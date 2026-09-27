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

const lockfileVersion = '9.0';

const Entries = Schema.Record(Schema.String, Schema.Unknown);
const Settings = Schema.Struct({
  excludeLinksFromLockfile: Schema.optionalKey(Schema.Boolean),
});
const Document = Schema.Struct({
  lockfileVersion: Schema.Literal(lockfileVersion),
  settings: Schema.optionalKey(Settings),
  importers: Entries,
  packages: Schema.optionalKey(Entries),
  snapshots: Schema.optionalKey(Entries),
});

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
  requiresBuild: Schema.optionalKey(Schema.Boolean),
});

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

// pnpm 11 merges a packages entry into its snapshot with Object.assign, so a
// field in the wrong section would override the other section's.
const snapshotFields = ['dependencies', 'optionalDependencies', 'optional'];
const packageFields = ['resolution', 'name', 'version'];

const byteOrderMark = String.fromCodePoint(0xfeff);
const documentStart = '---\n';
const documentSeparator = '\n---\n';
const fullCommit = /^[0-9a-f]{40}$/;
const semver = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

// Reached through a production, dev, optional, or dev-then-optional path.
type Mode = 0 | 1 | 2 | 3;
const devMode = 1;
const optionalMode = 2;
const devOptionalMode = 3;

const importerGroups = [
  ['dependencies', 0],
  ['devDependencies', devMode],
  ['optionalDependencies', optionalMode],
  ['configDependencies', 0],
  ['packageManagerDependencies', 0],
] as const;

type Edge = {
  readonly from: Location & { readonly dependency: string };
  readonly base: string;
  readonly mode: Mode;
  readonly ref: string;
};

type Classified =
  | {
      readonly kind: 'source';
      readonly source: LockfileSource;
      readonly version: string | null;
    }
  | { readonly kind: 'workspace' }
  | { readonly kind: 'error'; readonly error: string };

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

function snapshotKeyOf(ref: string, alias: string): string {
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
    : `${alias}@${ref}`;
}

function isOutside(path: string): boolean {
  return (
    path === '..' ||
    path.startsWith('../') ||
    posix.isAbsolute(path) ||
    win32.isAbsolute(path)
  );
}

function resolvePath(base: string, target: string): string {
  if (posix.isAbsolute(target) || win32.isAbsolute(target)) {
    return target;
  }

  const joined = posix.normalize(posix.join(base, target));

  return joined === './' ? '.' : joined.replace(/\/$/, '');
}

function gitArchiveSpec(url: URL): string | undefined {
  const segments = url.pathname.split('/').slice(1);
  if (url.hostname === 'codeload.github.com') {
    const [owner, repo, kind, ref] = segments;

    return segments.length === 4 && kind === 'tar.gz'
      ? `github:${owner}/${repo}#${ref}`
      : '';
  }

  if (url.hostname === 'bitbucket.org' && segments[2] === 'get') {
    const [owner, repo, , file = ''] = segments;

    return segments.length === 4 && file.endsWith('.tar.gz')
      ? `bitbucket:${owner}/${repo}#${file.slice(0, -'.tar.gz'.length)}`
      : '';
  }

  if (url.hostname !== 'gitlab.com') {
    return undefined;
  }

  const dash = segments.indexOf('-');
  if (dash > 1 && segments[dash + 1] === 'archive') {
    return `gitlab:${segments.slice(0, dash).join('/')}#${segments[dash + 2] ?? ''}`;
  }

  const [api, v4, projects, project = '', repository, file] = segments;

  return api === 'api' &&
    v4 === 'v4' &&
    projects === 'projects' &&
    repository === 'repository' &&
    file === 'archive.tar.gz'
    ? `gitlab:${decodeURIComponent(project)}#${url.searchParams.get('ref') ?? ''}`
    : undefined;
}

function classifyTarball(
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

    return semver.test(version)
      ? { kind: 'source', source: { kind: 'registry', integrity }, version }
      : {
          kind: 'error',
          error: `${name}@${keyVersion} has no tarball and no registry version`,
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
    return { kind: 'error', error: `unrecognized tarball ${tarball}` };
  }

  const git = gitArchiveSpec(url);
  if (git !== undefined || resolution.gitHosted === true) {
    const commit = git?.slice(git.lastIndexOf('#') + 1) ?? '';

    return git !== undefined && fullCommit.test(commit)
      ? {
          kind: 'source',
          source: { kind: 'git', spec: git },
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

function classify(
  name: string,
  keyVersion: string,
  info: typeof PackageInfo.Type,
  importers: ReadonlySet<string>,
): Classified {
  const { resolution } = info;
  const entryVersion = info.version ?? null;
  const type = resolution['type'];
  if (type === undefined) {
    const tarball = decodeTarball(resolution, closed);

    return Result.isSuccess(tarball)
      ? classifyTarball(name, keyVersion, tarball.success, entryVersion)
      : { kind: 'error', error: String(tarball.failure) };
  }

  if (type === 'git') {
    const git = decodeGit(resolution, closed);
    if (Result.isFailure(git)) {
      return { kind: 'error', error: String(git.failure) };
    }

    const spec = `${git.success.repo}#${git.success.commit}`;

    return fullCommit.test(git.success.commit)
      ? { kind: 'source', source: { kind: 'git', spec }, version: entryVersion }
      : {
          kind: 'error',
          error: `git source ${spec} does not pin a full commit`,
        };
  }

  if (type === 'directory') {
    const directory = decodeDirectory(resolution, closed);
    if (Result.isFailure(directory)) {
      return { kind: 'error', error: String(directory.failure) };
    }

    const path = resolvePath('', directory.success.directory);

    return importers.has(path)
      ? { kind: 'workspace' }
      : {
          kind: 'source',
          source: { kind: 'file', spec: path },
          version: entryVersion,
        };
  }

  return {
    kind: 'error',
    error: `unsupported resolution type ${JSON.stringify(type)}`,
  };
}

function hasAny(value: unknown, fields: readonly string[]): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    fields.some((field) => Object.hasOwn(value, field))
  );
}

function snapshotNode(
  key: string,
  packages: Readonly<Record<string, unknown>>,
  importers: ReadonlySet<string>,
):
  | (Classified & { readonly kind: 'workspace' | 'error' })
  | {
      readonly kind: 'source';
      readonly name: string;
      readonly version: string | null;
      readonly source: LockfileSource;
      readonly hasInstallScript: boolean | null;
    } {
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

  if (hasAny(raw, snapshotFields)) {
    return { kind: 'error', error: `snapshot fields in packages entry ${id}` };
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

  return classified.kind === 'source'
    ? {
        kind: 'source',
        name,
        version: classified.version,
        source: classified.source,
        hasInstallScript: info.success.requiresBuild === true ? true : null,
      }
    : classified;
}

function along(mode: Mode, edge: Mode): Mode {
  if (edge !== optionalMode) {
    return mode;
  }

  return mode === devMode || mode === devOptionalMode
    ? devOptionalMode
    : optionalMode;
}

function flags(modes: number): { dev: boolean; optional: boolean } {
  const only = (allowed: readonly Mode[]) =>
    modes !== 0 &&
    ([0, 1, 2, 3] as const).every(
      (mode) => (modes & (1 << mode)) === 0 || allowed.includes(mode),
    );
  const dev = only([devMode, devOptionalMode]);
  const optional = only([optionalMode, devOptionalMode]);
  const devOptional = only([devMode, optionalMode, devOptionalMode]);

  return {
    dev: dev || (devOptional && !optional),
    optional: optional || (devOptional && !dev),
  };
}

function readDocument(
  prefix: string,
  document: typeof Document.Type,
): LockfileNode[] {
  const packages = document.packages ?? {};
  const importerIds = new Set(
    Object.keys(document.importers).filter(
      (id) => id === '.' || (resolvePath('', id) === id && !isOutside(id)),
    ),
  );
  const nodes: LockfileNode[] = [];
  if (document.settings?.excludeLinksFromLockfile === true) {
    nodes.push({
      kind: 'unreadable',
      path: `${prefix}.`,
      error: 'excludeLinksFromLockfile leaves links out of the lockfile',
    });
  }

  const roots: Edge[] = [];
  for (const [id, raw] of Object.entries(document.importers)) {
    const importer = decodeImporter(raw ?? {});
    if (Result.isFailure(importer)) {
      nodes.push({
        kind: 'unreadable',
        path: `${prefix}${id}`,
        error: String(importer.failure),
      });
      continue;
    }

    for (const [group, mode] of importerGroups) {
      const refs = importer.success[group] ?? {};
      for (const [alias, { version }] of Object.entries(refs)) {
        roots.push({
          from: { path: `${prefix}${id}`, dependency: alias },
          base: id === '.' ? '' : id,
          mode,
          ref: version,
        });
      }
    }
  }

  const snapshots = new Map<
    string,
    { readonly edges: readonly Edge[] } | { readonly error: string }
  >();
  for (const [key, raw] of Object.entries(document.snapshots ?? {})) {
    const snapshot = hasAny(raw, packageFields)
      ? undefined
      : decodeSnapshot(raw ?? {});
    if (snapshot === undefined || Result.isFailure(snapshot)) {
      snapshots.set(key, {
        error:
          snapshot === undefined
            ? 'package fields in a snapshot'
            : String(snapshot.failure),
      });
      continue;
    }

    const edgesOf = (
      refs: Readonly<Record<string, string>> | undefined,
      mode: Mode,
    ) =>
      Object.entries(refs ?? {}).map(([alias, ref]) => ({
        from: { path: `${prefix}${key}`, dependency: alias },
        base: '',
        mode,
        ref,
      }));
    snapshots.set(key, {
      edges: [
        ...edgesOf(snapshot.success.dependencies, 0),
        ...edgesOf(snapshot.success.optionalDependencies, optionalMode),
      ],
    });
  }

  const reached = new Map<string, number>();
  const linkModes = new Map<Edge, number>();
  const queue: (readonly [string, Mode])[] = [];
  const follow = (edge: Edge, mode: Mode) => {
    if (edge.ref.startsWith('link:')) {
      linkModes.set(edge, (linkModes.get(edge) ?? 0) | (1 << mode));

      return;
    }

    const key = snapshotKeyOf(edge.ref, edge.from.dependency);
    const seen = reached.get(key) ?? 0;
    if ((seen & (1 << mode)) === 0) {
      reached.set(key, seen | (1 << mode));
      queue.push([key, mode]);
    }
  };

  for (const edge of roots) {
    follow(edge, edge.mode);
  }

  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const [key, mode] = next;
    const snapshot = snapshots.get(key);
    for (const edge of snapshot !== undefined && 'edges' in snapshot
      ? snapshot.edges
      : []) {
      follow(edge, along(mode, edge.mode));
    }
  }

  const edges = [
    ...roots,
    ...[...snapshots.values()].flatMap((snapshot) =>
      'edges' in snapshot ? snapshot.edges : [],
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
          ...flags(linkModes.get(edge) ?? 0),
          hasInstallScript: null,
        });
      }
    } else if (!snapshots.has(snapshotKeyOf(edge.ref, edge.from.dependency))) {
      nodes.push({
        kind: 'unreadable',
        ...edge.from,
        error: `no snapshot ${snapshotKeyOf(edge.ref, edge.from.dependency)}`,
      });
    }
  }

  for (const [key, snapshot] of snapshots) {
    const path = `${prefix}${key}`;
    const node =
      'error' in snapshot
        ? ({ kind: 'error', error: snapshot.error } as const)
        : snapshotNode(key, packages, importerIds);
    if (node.kind === 'error') {
      nodes.push({ kind: 'unreadable', path, error: node.error });
    } else if (node.kind === 'source') {
      nodes.push({
        kind: 'package',
        path,
        name: node.name,
        version: node.version,
        source: node.source,
        ...flags(reached.get(key) ?? 0),
        hasInstallScript: node.hasInstallScript,
      });
    }
  }

  return nodes;
}

export function readPnpmLock(text: string): LockfileRead {
  const documents = splitDocuments(text);
  if (documents === undefined) {
    return {
      kind: 'unreadable',
      error: 'not a pnpm-lock.yaml: an env document without a lockfile',
    };
  }

  const decoded: (typeof Document.Type)[] = [];
  for (const source of documents) {
    const yaml = readYaml(source);
    if (yaml.kind === 'unreadable') {
      return {
        kind: 'unreadable',
        error: `not a pnpm-lock.yaml: ${yaml.error}`,
      };
    }

    const document = decodeDocument(yaml.value);
    if (Result.isFailure(document)) {
      return {
        kind: 'unreadable',
        error: `not a pnpm-lock.yaml with lockfileVersion '${lockfileVersion}': ${String(document.failure)}`,
      };
    }

    decoded.push(document.success);
  }

  return {
    kind: 'read',
    nodes: decoded.flatMap((document, index) =>
      readDocument(index < decoded.length - 1 ? 'env:' : '', document),
    ),
  };
}
