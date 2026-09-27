import { Option, Result, Schema } from 'effect';
import { Sha512Integrity } from '../evidence';
import { nameFromFolder, workspaceMatcher } from './workspaces';

export const npmRegistry = 'https://registry.npmjs.org';

export type LockfileSource =
  | { readonly kind: 'registry'; readonly integrity: Sha512Integrity | null }
  | { readonly kind: 'git'; readonly spec: string }
  | {
      readonly kind: 'url';
      readonly spec: string;
      readonly integrity: Sha512Integrity | null;
    }
  | { readonly kind: 'file'; readonly spec: string };

export type Location = {
  readonly path: string;
  readonly dependency?: string;
};

export type LockfileNode =
  | (Location & {
      readonly kind: 'package';
      readonly name: string;
      readonly version: string | null;
      readonly source: LockfileSource;
      readonly dev: boolean;
      readonly optional: boolean;
      readonly hasInstallScript: boolean | null;
    })
  | (Location & { readonly kind: 'unreadable'; readonly error: string });

export type LockfileRead =
  | { readonly kind: 'read'; readonly nodes: readonly LockfileNode[] }
  | { readonly kind: 'unreadable'; readonly error: string };

const PackageLock = Schema.fromJsonString(
  Schema.Struct({
    lockfileVersion: Schema.Literals([2, 3]),
    packages: Schema.Record(Schema.String, Schema.Unknown),
  }),
);

const Dependencies = Schema.optionalKey(
  Schema.Record(Schema.String, Schema.String),
);
const OptionalBoolean = Schema.optionalKey(Schema.Boolean);

const Entry = Schema.Struct({
  name: Schema.optionalKey(Schema.NonEmptyString),
  version: Schema.optionalKey(Schema.NonEmptyString),
  resolved: Schema.optionalKey(Schema.NonEmptyString),
  integrity: Schema.optionalKey(Schema.String),
  link: OptionalBoolean,
  dev: OptionalBoolean,
  optional: OptionalBoolean,
  devOptional: OptionalBoolean,
  inBundle: OptionalBoolean,
  hasInstallScript: OptionalBoolean,
  dependencies: Dependencies,
  optionalDependencies: Dependencies,
  devDependencies: Dependencies,
  workspaces: Schema.optionalKey(Schema.Unknown),
});
type Entry = typeof Entry.Type;

const decodeLock = Schema.decodeUnknownResult(PackageLock);
const decodeEntry = Schema.decodeUnknownResult(Entry);
const decodeSha512 = Schema.decodeUnknownOption(Sha512Integrity);

const pinnedCommit = /#[0-9a-f]{40}$/;
const gitSpec = /^(git\+[a-z]+:|git:|github:|gitlab:|bitbucket:|gist:)/;
const gitShorthand = /^[\w.-]+\/[\w.-]+(#.*)?$/;
const urlSpec = /^https?:\/\//;
const fileSpec = /^(file:|link:|workspace:|\.{1,2}\/|\/|~\/)/;

export function sha512Of(
  integrity: string | undefined,
): Sha512Integrity | null {
  const digests = new Set(
    (integrity?.split(/\s+/) ?? []).flatMap((token) =>
      Option.toArray(decodeSha512(token)),
    ),
  );
  const [only, ...rest] = digests;

  return only !== undefined && rest.length === 0 ? only : null;
}

function isOutsideNodeModules(path: string): boolean {
  return !path.split('/').includes('node_modules');
}

function nameFromPath(path: string): string {
  const marker = 'node_modules/';

  return path.slice(path.lastIndexOf(marker) + marker.length);
}

export function registryTarball(name: string, version: string): string {
  return `${npmRegistry}/${name}/-/${name.slice(name.indexOf('/') + 1)}-${version}.tgz`;
}

type Classified =
  | { readonly kind: 'source'; readonly source: LockfileSource }
  | { readonly kind: 'error'; readonly error: string };

function classifyEntry(name: string, entry: Entry): Classified {
  const { resolved, version } = entry;
  if (entry.link === true) {
    return resolved === undefined
      ? { kind: 'error', error: 'link without a target' }
      : { kind: 'source', source: { kind: 'file', spec: resolved } };
  }

  if (resolved === undefined || resolved.startsWith(`${npmRegistry}/`)) {
    if (version === undefined) {
      return { kind: 'error', error: 'registry entry without a version' };
    }

    if (resolved !== undefined && resolved !== registryTarball(name, version)) {
      return {
        kind: 'error',
        error: `resolved ${resolved} is not the tarball of ${name}@${version}`,
      };
    }

    return {
      kind: 'source',
      source: { kind: 'registry', integrity: sha512Of(entry.integrity) },
    };
  }

  return (
    classifySpec(resolved, entry.integrity) ?? {
      kind: 'error',
      error: `unrecognized resolved ${resolved}`,
    }
  );
}

function classifySpec(
  spec: string,
  integrity: string | undefined,
): Classified | undefined {
  if (gitSpec.test(spec) || gitShorthand.test(spec)) {
    return pinnedCommit.test(spec)
      ? { kind: 'source', source: { kind: 'git', spec } }
      : {
          kind: 'error',
          error: `git source ${spec} does not pin a full commit`,
        };
  }

  if (urlSpec.test(spec)) {
    return {
      kind: 'source',
      source: { kind: 'url', spec, integrity: sha512Of(integrity) },
    };
  }

  return fileSpec.test(spec)
    ? { kind: 'source', source: { kind: 'file', spec } }
    : undefined;
}

function installedAt(
  packages: Record<string, unknown>,
  parent: string,
  name: string,
): boolean {
  let base = parent;
  for (;;) {
    const candidate =
      base === '' ? `node_modules/${name}` : `${base}/node_modules/${name}`;
    if (Object.hasOwn(packages, candidate)) {
      return true;
    }

    if (base === '') {
      return false;
    }

    const cut = base.lastIndexOf('/node_modules/');
    base = cut === -1 ? '' : base.slice(0, cut);
  }
}

function undeclaredExoticNodes(
  packages: Record<string, unknown>,
  path: string,
  entry: Entry,
): LockfileNode[] {
  const edges = [
    ...Object.entries(entry.dependencies ?? {}).map(([name, spec]) => ({
      name,
      spec,
      dev: false,
      optional: false,
    })),
    ...Object.entries(entry.optionalDependencies ?? {}).map(([name, spec]) => ({
      name,
      spec,
      dev: false,
      optional: true,
    })),
    ...Object.entries(entry.devDependencies ?? {}).map(([name, spec]) => ({
      name,
      spec,
      dev: true,
      optional: false,
    })),
  ];

  return edges.flatMap(({ name, spec, dev, optional }): LockfileNode[] => {
    const classified = classifySpec(spec, undefined);
    if (classified === undefined || installedAt(packages, path, name)) {
      return [];
    }

    const location = { path, dependency: name };

    return classified.kind === 'error'
      ? [{ kind: 'unreadable', ...location, error: classified.error }]
      : [
          {
            kind: 'package',
            ...location,
            name,
            version: null,
            source: classified.source,
            dev,
            optional,
            hasInstallScript: null,
          },
        ];
  });
}

function entryNode(path: string, entry: Entry): LockfileNode {
  const name = entry.name ?? nameFromPath(path);
  const classified = classifyEntry(name, entry);
  if (classified.kind === 'error') {
    return { kind: 'unreadable', path, error: classified.error };
  }

  return {
    kind: 'package',
    path,
    name,
    version: entry.version ?? null,
    source: classified.source,
    dev: entry.dev === true || entry.devOptional === true,
    optional: entry.optional === true || entry.devOptional === true,
    hasInstallScript: entry.hasInstallScript === true,
  };
}

function isLinkAt(path: string, name: string): boolean {
  return (
    path === `node_modules/${name}` || path.endsWith(`/node_modules/${name}`)
  );
}

function workspaceLinks(
  entries: ReadonlyMap<string, Entry>,
): ReadonlySet<string> {
  const declared = workspaceMatcher(entries.get('')?.workspaces);
  const folders = new Map<string, string | null>();
  for (const [path, entry] of entries) {
    if (
      entry.link === undefined &&
      entry.resolved === undefined &&
      declared(path)
    ) {
      const name = entry.name ?? nameFromFolder(path);
      folders.set(name, folders.has(name) ? null : path);
    }
  }

  const links = new Set<string>();
  for (const [path, entry] of entries) {
    const name = nameFromPath(path);
    if (
      entry.link === true &&
      entry.resolved !== undefined &&
      isLinkAt(path, name) &&
      folders.get(name) === entry.resolved
    ) {
      links.add(path);
    }
  }

  return links;
}

export function readPackageLock(text: string): LockfileRead {
  const lock = decodeLock(text);
  if (Result.isFailure(lock)) {
    return {
      kind: 'unreadable',
      error: `not a package-lock.json v2 or v3: ${String(lock.failure)}`,
    };
  }

  const { packages } = lock.success;
  const decoded = Object.entries(packages).map(
    ([path, raw]) => [path, decodeEntry(raw)] as const,
  );
  const workspaces = workspaceLinks(
    new Map(
      decoded.flatMap(([path, entry]) =>
        Result.isSuccess(entry) ? [[path, entry.success] as const] : [],
      ),
    ),
  );
  const nodes = decoded.flatMap(([path, decodedEntry]): LockfileNode[] => {
    if (Result.isFailure(decodedEntry)) {
      return [
        { kind: 'unreadable', path, error: String(decodedEntry.failure) },
      ];
    }

    const entry = decodedEntry.success;
    const edges = undeclaredExoticNodes(packages, path, entry);
    if (isOutsideNodeModules(path)) {
      return entry.link === true
        ? [
            { kind: 'unreadable', path, error: 'link outside node_modules' },
            ...edges,
          ]
        : edges;
    }

    if (workspaces.has(path) || entry.inBundle === true) {
      return edges;
    }

    return [entryNode(path, entry), ...edges];
  });

  return { kind: 'read', nodes };
}
