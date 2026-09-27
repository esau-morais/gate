import { posix, win32 } from 'node:path';
import { Result, Schema } from 'effect';
import { readYaml } from '../yaml';
import {
  npmRegistry,
  registryTarball,
  sha512Of,
  type Location,
  type LockfileNode,
  type LockfileRead,
  type LockfileSource,
} from './lockfile';
import { isFolderPath } from './workspaces';

const lockfileVersion = '9.0';

const Entries = Schema.Record(Schema.String, Schema.Unknown);
const Document = Schema.Struct({
  lockfileVersion: Schema.Literal(lockfileVersion),
  settings: Schema.optionalKey(
    Schema.Struct({
      excludeLinksFromLockfile: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  importers: Entries,
  packages: Schema.optionalKey(Entries),
  snapshots: Schema.optionalKey(Entries),
});
type Document = typeof Document.Type;

const References = Schema.optionalKey(
  Schema.Record(
    Schema.String,
    Schema.Struct({
      specifier: Schema.String,
      version: Schema.NonEmptyString,
    }),
  ),
);
const Importer = Schema.Struct({
  dependencies: References,
  devDependencies: References,
  optionalDependencies: References,
  configDependencies: References,
  packageManagerDependencies: References,
});

const SnapshotReferences = Schema.optionalKey(
  Schema.Record(Schema.String, Schema.NonEmptyString),
);
const Snapshot = Schema.Struct({
  dependencies: SnapshotReferences,
  optionalDependencies: SnapshotReferences,
});
const PackageInfo = Schema.Struct({
  resolution: Schema.Record(Schema.String, Schema.Unknown),
  name: Schema.optionalKey(Schema.String),
  version: Schema.optionalKey(Schema.String),
});
type PackageInfo = typeof PackageInfo.Type;

const TarballResolution = Schema.Struct({
  integrity: Schema.optionalKey(Schema.String),
  tarball: Schema.optionalKey(Schema.NonEmptyString),
  gitHosted: Schema.optionalKey(Schema.Boolean),
});
const GitResolution = Schema.Struct({
  type: Schema.Literal('git'),
  repo: Schema.NonEmptyString,
  commit: Schema.String,
  integrity: Schema.optionalKey(Schema.String),
});
const DirectoryResolution = Schema.Struct({
  type: Schema.Literal('directory'),
  directory: Schema.NonEmptyString,
});

const closed = { onExcessProperty: 'error' } as const;
const decodeDocument = Schema.decodeUnknownResult(Document);
const decodeImporter = Schema.decodeUnknownResult(Importer);
const decodeSnapshot = Schema.decodeUnknownResult(Snapshot);
const decodePackageInfo = Schema.decodeUnknownResult(PackageInfo);
const decodeTarball = Schema.decodeUnknownResult(TarballResolution);
const decodeGit = Schema.decodeUnknownResult(GitResolution);
const decodeDirectory = Schema.decodeUnknownResult(DirectoryResolution);

const refusedInPackages = [
  'dependencies',
  'optionalDependencies',
  'optional',
  'id',
];
const refusedInSnapshots = ['resolution', 'name', 'version', 'id'];
const userinfo = /\/\/([^/@\s]*)@/g;

const byteOrderMark = String.fromCodePoint(0xfeff);
const documentStart = '---\n';
const documentSeparator = '\n---\n';
const fullCommit = /^[0-9a-f]{40}$/;
export const semver = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

type Reach = 'production' | 'dev' | 'optional' | 'devOptional';

const importerGroups = [
  ['dependencies', 'production'],
  ['devDependencies', 'dev'],
  ['optionalDependencies', 'optional'],
  ['configDependencies', 'production'],
  ['packageManagerDependencies', 'production'],
] as const;

type Edge = {
  readonly from: Location & { readonly dependency: string };
  readonly base: string;
  readonly ref: string;
  readonly optional: boolean;
};

type ParsedSnapshot =
  | { readonly kind: 'snapshot'; readonly edges: readonly Edge[] }
  | { readonly kind: 'error'; readonly error: string };

type Classified =
  | {
      readonly kind: 'source';
      readonly source: LockfileSource;
      readonly version: string | null;
    }
  | { readonly kind: 'workspace' }
  | { readonly kind: 'error'; readonly error: string };

type SnapshotSource = Extract<Classified, { kind: 'source' }> & {
  readonly name: string;
};

type GitArchive =
  | {
      readonly kind: 'archive';
      readonly repository: string;
      readonly ref: string;
    }
  | { readonly kind: 'malformed' };

const invalid = (failure: unknown): Classified => ({
  kind: 'error',
  error: String(failure),
});

function splitDocuments(text: string): readonly string[] | undefined {
  const normalized = (
    text.startsWith(byteOrderMark) ? text.slice(byteOrderMark.length) : text
  ).replaceAll(/\r\n/g, '\n');
  if (!normalized.startsWith(documentStart)) {
    return [normalized];
  }

  const separator = normalized.indexOf(documentSeparator, documentStart.length);

  return separator === -1
    ? undefined
    : [
        normalized.slice(documentStart.length, separator),
        normalized.slice(separator + documentSeparator.length),
      ];
}

function packageKey(snapshotKey: string): string {
  if (!snapshotKey.endsWith(')')) {
    return snapshotKey;
  }

  let open = 1;
  for (let index = snapshotKey.length - 2; index >= 0; index -= 1) {
    const char = snapshotKey[index];
    if (char === '(') {
      open -= 1;
    } else if (char === ')') {
      open += 1;
    } else if (open === 0) {
      return snapshotKey.slice(0, index + 1);
    }
  }

  return snapshotKey;
}

function snapshotKeyOf(edge: Edge): string {
  const { ref } = edge;
  if (ref.startsWith('@')) {
    return ref;
  }

  const at = ref.indexOf('@');
  const colon = ref.indexOf(':');
  const bracket = ref.indexOf('(');

  return at !== -1 &&
    (colon === -1 || at < colon) &&
    (bracket === -1 || at < bracket)
    ? ref
    : `${edge.from.dependency}@${ref}`;
}

function resolvePath(base: string, target: string): string {
  if (posix.isAbsolute(target) || win32.isAbsolute(target)) {
    return target;
  }

  const joined = posix.normalize(posix.join(base, target));

  return joined === './' ? '.' : joined.replace(/\/$/, '');
}

function gitArchive(url: URL): GitArchive | undefined {
  const segments = url.pathname.split('/').slice(1);
  if (url.hostname === 'codeload.github.com') {
    const [owner, repo, kind, ref = ''] = segments;

    return segments.length === 4 && kind === 'tar.gz'
      ? { kind: 'archive', repository: `github:${owner}/${repo}`, ref }
      : { kind: 'malformed' };
  }

  if (url.hostname === 'bitbucket.org' && segments[2] === 'get') {
    const [owner, repo, , file = ''] = segments;

    return segments.length === 4 && file.endsWith('.tar.gz')
      ? {
          kind: 'archive',
          repository: `bitbucket:${owner}/${repo}`,
          ref: file.slice(0, -'.tar.gz'.length),
        }
      : { kind: 'malformed' };
  }

  if (url.hostname !== 'gitlab.com') {
    return undefined;
  }

  const dash = segments.indexOf('-');
  if (dash > 1 && segments[dash + 1] === 'archive') {
    return {
      kind: 'archive',
      repository: `gitlab:${segments.slice(0, dash).join('/')}`,
      ref: segments[dash + 2] ?? '',
    };
  }

  const [api, v4, projects, project = '', repository, file] = segments;
  if (
    api !== 'api' ||
    v4 !== 'v4' ||
    projects !== 'projects' ||
    repository !== 'repository' ||
    file !== 'archive.tar.gz'
  ) {
    return undefined;
  }

  return [...url.searchParams.keys()].join() === 'ref'
    ? {
        kind: 'archive',
        repository: `gitlab:${decodeURIComponent(project)}`,
        ref: url.searchParams.get('ref') ?? '',
      }
    : { kind: 'malformed' };
}

export function classifyTarball(
  name: string,
  keyVersion: string,
  resolution: typeof TarballResolution.Type,
  entryVersion: string | null,
): Classified {
  const { tarball } = resolution;
  const integrity = sha512Of(resolution.integrity);
  if (tarball === undefined) {
    const version = keyVersion.startsWith('npmjs:')
      ? keyVersion.slice('npmjs:'.length)
      : keyVersion;
    if (!semver.test(version)) {
      return {
        kind: 'error',
        error: `${name}@${keyVersion} has no tarball and no registry version`,
      };
    }

    return entryVersion === null || entryVersion === version
      ? { kind: 'source', source: { kind: 'registry', integrity }, version }
      : {
          kind: 'error',
          error: `${name}@${keyVersion} records version ${entryVersion}`,
        };
  }

  if (tarball.startsWith('file:')) {
    return {
      kind: 'source',
      source: { kind: 'file', spec: tarball },
      version: entryVersion,
    };
  }

  const url = URL.parse(tarball);
  if (url === null || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
    return {
      kind: 'error',
      error: 'a tarball that is neither file: nor http(s)',
    };
  }

  if (url.username !== '' || url.password !== '') {
    return { kind: 'error', error: 'a tarball URL with credentials' };
  }

  const git = gitArchive(url);
  if (git !== undefined || resolution.gitHosted === true) {
    return git?.kind === 'archive' && fullCommit.test(git.ref)
      ? {
          kind: 'source',
          source: { kind: 'git', spec: `${git.repository}#${git.ref}` },
          version: entryVersion,
        }
      : {
          kind: 'error',
          error: `git source ${tarball} does not pin a full commit`,
        };
  }

  if (!tarball.startsWith(`${npmRegistry}/`)) {
    return {
      kind: 'source',
      source: { kind: 'url', spec: tarball, integrity },
      version: entryVersion,
    };
  }

  return semver.test(keyVersion) &&
    tarball === registryTarball(name, keyVersion)
    ? {
        kind: 'source',
        source: { kind: 'registry', integrity },
        version: keyVersion,
      }
    : {
        kind: 'error',
        error: `tarball ${tarball} is not the tarball of ${name}@${keyVersion}`,
      };
}

function classifyGit(
  resolution: typeof GitResolution.Type,
  entryVersion: string | null,
): Classified {
  const { repo, commit } = resolution;
  const url = URL.parse(repo);
  if (
    url !== null &&
    (url.password !== '' || !['', 'git'].includes(url.username))
  ) {
    return { kind: 'error', error: 'a git repository URL with credentials' };
  }

  const spec = `${repo}#${commit}`;

  return fullCommit.test(commit)
    ? { kind: 'source', source: { kind: 'git', spec }, version: entryVersion }
    : { kind: 'error', error: `git source ${spec} does not pin a full commit` };
}

function classify(
  name: string,
  keyVersion: string,
  info: PackageInfo,
  importers: ReadonlySet<string>,
): Classified {
  const { resolution } = info;
  const entryVersion = info.version ?? null;
  const type = resolution['type'];
  if (type === undefined) {
    return Result.match(decodeTarball(resolution, closed), {
      onFailure: invalid,
      onSuccess: (tarball) =>
        classifyTarball(name, keyVersion, tarball, entryVersion),
    });
  }

  if (type === 'git') {
    return Result.match(decodeGit(resolution, closed), {
      onFailure: invalid,
      onSuccess: (git) => classifyGit(git, entryVersion),
    });
  }

  if (type === 'directory') {
    return Result.match(decodeDirectory(resolution, closed), {
      onFailure: invalid,
      onSuccess: ({ directory }): Classified => {
        const path = resolvePath('', directory);

        return importers.has(path)
          ? { kind: 'workspace' }
          : {
              kind: 'source',
              source: { kind: 'file', spec: path },
              version: entryVersion,
            };
      },
    });
  }

  return {
    kind: 'error',
    error: `unsupported resolution type ${JSON.stringify(type)}`,
  };
}

function withoutCredentials(text: string): string {
  return text.replaceAll(userinfo, (match, user: string) =>
    user === 'git' ? match : '//***@',
  );
}

function refusedField(
  value: unknown,
  fields: readonly string[],
): string | undefined {
  return typeof value === 'object' && value !== null
    ? fields.find((field) => Object.hasOwn(value, field))
    : undefined;
}

function classifySnapshot(
  key: string,
  packages: Readonly<Record<string, unknown>>,
  importers: ReadonlySet<string>,
): SnapshotSource | Exclude<Classified, { kind: 'source' }> {
  const id = packageKey(key);
  const at = id.indexOf('@', 1);
  if (at === -1) {
    return { kind: 'error', error: `unrecognized key ${key}` };
  }

  const name = id.slice(0, at);
  const raw = Object.hasOwn(packages, id) ? packages[id] : undefined;
  if (raw === undefined) {
    return { kind: 'error', error: `no packages entry ${id}` };
  }

  const refused = refusedField(raw, refusedInPackages);
  if (refused !== undefined) {
    return { kind: 'error', error: `${refused} in packages entry ${id}` };
  }

  const info = decodePackageInfo(raw);
  if (Result.isFailure(info)) {
    return { kind: 'error', error: String(info.failure) };
  }

  if (info.success.name !== undefined && info.success.name !== name) {
    return {
      kind: 'error',
      error: `packages entry ${id} names ${info.success.name}`,
    };
  }

  const classified = classify(name, id.slice(at + 1), info.success, importers);

  return classified.kind === 'source' ? { ...classified, name } : classified;
}

function dependencyFlags(reaches: ReadonlySet<Reach> | undefined): {
  dev: boolean;
  optional: boolean;
} {
  const all = (...allowed: readonly Reach[]) =>
    reaches !== undefined &&
    reaches.size > 0 &&
    [...reaches].every((reach) => allowed.includes(reach));
  const dev = all('dev', 'devOptional');
  const optional = all('optional', 'devOptional');
  const devOrOptional = all('dev', 'optional', 'devOptional');

  return {
    dev: dev || (devOrOptional && !optional),
    optional: optional || (devOrOptional && !dev),
  };
}

function throughEdge(reach: Reach, edge: Edge): Reach {
  if (!edge.optional) {
    return reach;
  }

  return reach === 'dev' || reach === 'devOptional'
    ? 'devOptional'
    : 'optional';
}

function parseImporters(
  prefix: string,
  importers: Readonly<Record<string, unknown>>,
): { roots: (readonly [Edge, Reach])[]; errors: LockfileNode[] } {
  const roots: (readonly [Edge, Reach])[] = [];
  const errors: LockfileNode[] = [];
  for (const [id, raw] of Object.entries(importers)) {
    const importer = decodeImporter(raw ?? {});
    if (Result.isFailure(importer)) {
      errors.push({
        kind: 'unreadable',
        path: `${prefix}${id}`,
        error: String(importer.failure),
      });
      continue;
    }

    for (const [group, reach] of importerGroups) {
      for (const [alias, { version }] of Object.entries(
        importer.success[group] ?? {},
      )) {
        const edge = {
          from: { path: `${prefix}${id}`, dependency: alias },
          base: id === '.' ? '' : id,
          ref: version,
          optional: false,
        };
        roots.push([edge, reach]);
      }
    }
  }

  return { roots, errors };
}

function parseSnapshots(
  prefix: string,
  snapshots: Readonly<Record<string, unknown>>,
): Map<string, ParsedSnapshot> {
  const parsed = new Map<string, ParsedSnapshot>();
  for (const [key, raw] of Object.entries(snapshots)) {
    if (withoutCredentials(key) !== key) {
      parsed.set(key, { kind: 'error', error: 'a key with credentials' });
      continue;
    }

    const refused = refusedField(raw, refusedInSnapshots);
    if (refused !== undefined) {
      parsed.set(key, { kind: 'error', error: `${refused} in a snapshot` });
      continue;
    }

    const snapshot = decodeSnapshot(raw ?? {});
    if (Result.isFailure(snapshot)) {
      parsed.set(key, { kind: 'error', error: String(snapshot.failure) });
      continue;
    }

    const edgesOf = (
      refs: Readonly<Record<string, string>> | undefined,
      optional: boolean,
    ) =>
      Object.entries(refs ?? {}).map(([alias, ref]) => ({
        from: { path: `${prefix}${key}`, dependency: alias },
        base: '',
        ref,
        optional,
      }));
    parsed.set(key, {
      kind: 'snapshot',
      edges: [
        ...edgesOf(snapshot.success.dependencies, false),
        ...edgesOf(snapshot.success.optionalDependencies, true),
      ],
    });
  }

  return parsed;
}

function walk(
  roots: readonly (readonly [Edge, Reach])[],
  snapshots: ReadonlyMap<string, ParsedSnapshot>,
): {
  snapshots: Map<string, Set<Reach>>;
  links: Map<Edge, Set<Reach>>;
} {
  const reached = new Map<string, Set<Reach>>();
  const links = new Map<Edge, Set<Reach>>();
  const queue: (readonly [string, Reach])[] = [];
  const add = <K>(map: Map<K, Set<Reach>>, key: K, reach: Reach) => {
    const seen = map.get(key) ?? new Set<Reach>();
    map.set(key, seen);
    if (seen.has(reach)) {
      return false;
    }

    seen.add(reach);

    return true;
  };

  const follow = (edge: Edge, reach: Reach) => {
    if (edge.ref.startsWith('link:')) {
      add(links, edge, reach);

      return;
    }

    const key = snapshotKeyOf(edge);
    if (add(reached, key, reach)) {
      queue.push([key, reach]);
    }
  };

  for (const [edge, reach] of roots) {
    follow(edge, reach);
  }

  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const [key, reach] = next;
    const snapshot = snapshots.get(key);
    for (const edge of snapshot?.kind === 'snapshot' ? snapshot.edges : []) {
      follow(edge, throughEdge(reach, edge));
    }
  }

  return { snapshots: reached, links };
}

function readDocument(prefix: string, document: Document): LockfileNode[] {
  const importerIds = new Set(
    Object.keys(document.importers).filter(
      (id) => id === '.' || isFolderPath(id),
    ),
  );
  const { roots, errors } = parseImporters(prefix, document.importers);
  const snapshots = parseSnapshots(prefix, document.snapshots ?? {});
  const reached = walk(roots, snapshots);
  const nodes: LockfileNode[] = [...errors];
  if (document.settings?.excludeLinksFromLockfile === true) {
    nodes.unshift({
      kind: 'unreadable',
      path: `${prefix}.`,
      error: 'excludeLinksFromLockfile leaves links out of the lockfile',
    });
  }

  const edges = [
    ...roots.map(([edge]) => edge),
    ...[...snapshots.values()].flatMap((snapshot) =>
      snapshot.kind === 'snapshot' ? snapshot.edges : [],
    ),
  ];
  for (const edge of edges) {
    if (edge.ref.startsWith('link:')) {
      const path = resolvePath(edge.base, edge.ref.slice('link:'.length));
      if (!importerIds.has(path)) {
        nodes.push({
          kind: 'package',
          ...edge.from,
          name: edge.from.dependency,
          version: null,
          source: { kind: 'file', spec: path },
          ...dependencyFlags(reached.links.get(edge)),
          hasInstallScript: null,
        });
      }

      continue;
    }

    const key = snapshotKeyOf(edge);
    if (!snapshots.has(key)) {
      nodes.push({
        kind: 'unreadable',
        ...edge.from,
        error: `no snapshot ${withoutCredentials(key)}`,
      });
    }
  }

  for (const [key, snapshot] of snapshots) {
    const path = `${prefix}${withoutCredentials(key)}`;
    const classified =
      snapshot.kind === 'error'
        ? snapshot
        : classifySnapshot(key, document.packages ?? {}, importerIds);
    if (classified.kind === 'error') {
      nodes.push({ kind: 'unreadable', path, error: classified.error });
    } else if (classified.kind === 'source') {
      nodes.push({
        kind: 'package',
        path,
        name: classified.name,
        version: classified.version,
        source: classified.source,
        ...dependencyFlags(reached.snapshots.get(key)),
        hasInstallScript: null,
      });
    }
  }

  return nodes;
}

type Reference = NonNullable<
  (typeof Importer.Type)['configDependencies']
>[string];

export type EnvConfigDependency = Reference & {
  readonly resolution: typeof TarballResolution.Type | undefined;
};

export type PnpmLockRead = {
  readonly read: LockfileRead;
  readonly env: ReadonlyMap<string, EnvConfigDependency>;
};

function envConfigDependencies(
  document: Document,
): Map<string, EnvConfigDependency> {
  const importer = decodeImporter(document.importers['.'] ?? {});
  const packages = document.packages ?? {};
  const env = new Map<string, EnvConfigDependency>();
  if (Result.isFailure(importer)) {
    return env;
  }

  for (const [name, reference] of Object.entries(
    importer.success.configDependencies ?? {},
  )) {
    const id = `${name}@${reference.version}`;
    const info = decodePackageInfo(
      Object.hasOwn(packages, id) ? packages[id] : undefined,
    );
    const resolution = Result.isSuccess(info)
      ? decodeTarball(info.success.resolution, closed)
      : undefined;
    env.set(name, {
      ...reference,
      resolution:
        resolution !== undefined && Result.isSuccess(resolution)
          ? resolution.success
          : undefined,
    });
  }

  return env;
}

export function readPnpmLockfile(text: string): PnpmLockRead {
  const none = new Map<string, EnvConfigDependency>();
  const documents = splitDocuments(text);
  if (documents === undefined) {
    return {
      read: {
        kind: 'unreadable',
        error: 'not a pnpm-lock.yaml: an env document without a lockfile',
      },
      env: none,
    };
  }

  const decoded: Document[] = [];
  for (const source of documents) {
    const yaml = readYaml(source);
    if (yaml.kind === 'unreadable') {
      return {
        read: {
          kind: 'unreadable',
          error: `not a pnpm-lock.yaml: ${yaml.error}`,
        },
        env: none,
      };
    }

    const document = decodeDocument(yaml.value);
    if (Result.isFailure(document)) {
      return {
        read: {
          kind: 'unreadable',
          error: `not a pnpm-lock.yaml with lockfileVersion '${lockfileVersion}': ${String(document.failure)}`,
        },
        env: none,
      };
    }

    decoded.push(document.success);
  }

  const [env] = decoded.length > 1 ? decoded : [];

  return {
    read: {
      kind: 'read',
      nodes: decoded.flatMap((document, index) =>
        readDocument(index < decoded.length - 1 ? 'env:' : '', document),
      ),
    },
    env: env === undefined ? none : envConfigDependencies(env),
  };
}

export function readPnpmLock(text: string): LockfileRead {
  return readPnpmLockfile(text).read;
}
