import { Option, Schema } from 'effect';

const Patterns = Schema.Array(Schema.String);
const Declaration = Schema.Union([
  Schema.Struct({ packages: Patterns }),
  Patterns,
]);
const decodeDeclaration = Schema.decodeUnknownOption(Declaration);

const globstar = Symbol('globstar');
type Segment = RegExp | typeof globstar;
type Pattern = readonly Segment[];

const patternSegment = /^[A-Za-z0-9._@+~*?-]+$/;
const folderSegment = /^[A-Za-z0-9._@+~-]+$/;

function parsePattern(raw: string): Pattern | undefined {
  const parsed: Segment[] = [];
  for (const segment of raw.replace(/^\.?\/+/, '').split('/')) {
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

function matches(pattern: Pattern, path: readonly string[]): boolean {
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

export function isFolderPath(path: string): boolean {
  return folderSegments(path) !== undefined;
}

export function workspaceMatcher(
  workspaces: unknown,
): (path: string) => boolean {
  const declaration = decodeDeclaration(workspaces);
  if (Option.isNone(declaration)) {
    return () => false;
  }

  const declared =
    'packages' in declaration.value
      ? declaration.value.packages
      : declaration.value;
  const patterns: Pattern[] = [];
  for (const raw of declared) {
    const pattern = parsePattern(raw);
    if (pattern === undefined) {
      return () => false;
    }

    patterns.push(pattern);
  }

  return (path) => {
    const segments = folderSegments(path);

    return (
      segments !== undefined &&
      patterns.some((pattern) => matches(pattern, segments))
    );
  };
}

export function nameFromFolder(path: string): string {
  const [base = '', parent] = path.split('/').toReversed();

  return parent?.startsWith('@') === true ? `${parent}/${base}` : base;
}
