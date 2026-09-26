import { Option, Schema } from 'effect';

const Patterns = Schema.Array(Schema.String);
const Root = Schema.Struct({
  workspaces: Schema.Union([Schema.Struct({ packages: Patterns }), Patterns]),
});
const Link = Schema.Struct({
  link: Schema.Literal(true),
  resolved: Schema.NonEmptyString,
});
const Folder = Schema.Struct({
  name: Schema.optionalKey(Schema.NonEmptyString),
});

const decodeRoot = Schema.decodeUnknownOption(Root);
const decodeLink = Schema.decodeUnknownOption(Link);
const decodeFolder = Schema.decodeUnknownOption(Folder);

const globstar = Symbol('globstar');
type Segment = RegExp | typeof globstar;

const patternSegment = /^[A-Za-z0-9._@+~*?-]+$/;
const folderSegment = /^[A-Za-z0-9._@+~-]+$/;

function parsePattern(raw: string): readonly Segment[] | undefined {
  const segments = raw.replace(/^\.?\/+/, '').split('/');
  const parsed: Segment[] = [];
  for (const segment of segments) {
    if (segment === '**') {
      parsed.push(globstar);
      continue;
    }

    if (
      !patternSegment.test(segment) ||
      segment.includes('**') ||
      segment === '.' ||
      segment === '..'
    ) {
      return undefined;
    }

    const body = segment
      .replace(/[.+]/g, '\\$&')
      .replaceAll('*', '[^/]*')
      .replaceAll('?', '[^/]');
    const guard = /^[*?]/.test(segment) ? '(?!\\.)' : '';
    parsed.push(new RegExp(`^${guard}${body}$`));
  }

  return parsed;
}

function matches(
  pattern: readonly Segment[],
  path: readonly string[],
): boolean {
  const [head, ...rest] = pattern;
  if (head === undefined) {
    return path.length === 0;
  }

  const [first, ...others] = path;
  if (head !== globstar) {
    return first !== undefined && head.test(first) && matches(rest, others);
  }

  if (rest.length === 0) {
    return path.length > 0 && path.every((segment) => !segment.startsWith('.'));
  }

  return (
    matches(rest, path) ||
    (first !== undefined && !first.startsWith('.') && matches(pattern, others))
  );
}

function folderSegments(path: string): readonly string[] | undefined {
  const segments = path.split('/');

  return segments.every(
    (segment) =>
      folderSegment.test(segment) &&
      segment !== '.' &&
      segment !== '..' &&
      segment !== 'node_modules',
  )
    ? segments
    : undefined;
}

function nameFromFolder(segments: readonly string[]): string {
  const base = segments.at(-1) ?? '';
  const parent = segments.at(-2);

  return parent?.startsWith('@') === true ? `${parent}/${base}` : base;
}

function nameFromLink(path: string): string {
  const marker = 'node_modules/';

  return path.slice(path.lastIndexOf(marker) + marker.length);
}

export function workspaceLinks(
  packages: Record<string, unknown>,
): ReadonlySet<string> {
  const root = decodeRoot(packages['']);
  if (Option.isNone(root)) {
    return new Set();
  }

  const { workspaces } = root.value;
  const declared = 'packages' in workspaces ? workspaces.packages : workspaces;
  const patterns: (readonly Segment[])[] = [];
  for (const raw of declared) {
    const pattern = parsePattern(raw);
    if (pattern === undefined) {
      return new Set();
    }

    patterns.push(pattern);
  }

  const links = new Set<string>();
  for (const [path, raw] of Object.entries(packages)) {
    const link = decodeLink(raw);
    if (Option.isNone(link) || !Object.hasOwn(packages, link.value.resolved)) {
      continue;
    }

    const target = link.value.resolved;
    const segments = folderSegments(target);
    const folder = decodeFolder(packages[target]);
    if (
      segments !== undefined &&
      Option.isSome(folder) &&
      patterns.some((pattern) => matches(pattern, segments)) &&
      nameFromLink(path) === (folder.value.name ?? nameFromFolder(segments))
    ) {
      links.add(path);
    }
  }

  return links;
}
