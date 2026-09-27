import { Result, Schema } from 'effect';
import { readYaml } from '../yaml';
import {
  registryTarball,
  type LockfileNode,
  type LockfileSource,
} from './lockfile';
import { classifyTarball, semver, type EnvConfigDependency } from './pnpm-lock';

const ConfigDependencies = Schema.optionalKey(
  Schema.Record(Schema.String, Schema.Unknown),
);
const Settings = Schema.NullOr(
  Schema.Struct({ configDependencies: ConfigDependencies }),
);
const Manifest = Schema.fromJsonString(
  Schema.Struct({
    pnpm: Schema.optionalKey(
      Schema.Struct({ configDependencies: ConfigDependencies }),
    ),
  }),
);
const TarballPin = Schema.Struct({
  tarball: Schema.optionalKey(Schema.String),
  integrity: Schema.String,
});

const decodeSettings = Schema.decodeUnknownResult(Settings);
const decodeManifest = Schema.decodeUnknownResult(Manifest);
const decodeTarballPin = Schema.decodeUnknownResult(TarballPin);

const integrityToken = /^sha(?:1|256|384|512)-[A-Za-z0-9+/]+={0,2}$/;
const reservedNames = new Set(['node_modules', 'favicon.ico']);
const httpTarball = /^https?:\/\//;

export type ConfigFile = { readonly path: string; readonly text: string };

type Location = { readonly path: string; readonly dependency: string };

type Pin = {
  readonly version: string;
  readonly integrity: string;
  readonly tarball: string | undefined;
};

type Entry =
  | { readonly kind: 'pin'; readonly pin: Pin }
  | { readonly kind: 'specifier'; readonly specifier: string }
  | { readonly kind: 'error'; readonly error: string };

function isPackageName(name: string): boolean {
  const scoped = name.startsWith('@');
  const parts = (scoped ? name.slice(1) : name).split('/');

  return (
    parts.length === (scoped ? 2 : 1) &&
    parts.every(
      (part) =>
        part !== '' &&
        !part.startsWith('.') &&
        !part.startsWith('_') &&
        encodeURIComponent(part) === part,
    ) &&
    !reservedNames.has(name.toLowerCase())
  );
}

function parsePin(value: string, tarball: string | undefined): Entry {
  const plus = value.indexOf('+');
  const version = value.slice(0, plus);
  const integrity = value.slice(plus + 1);
  if (!semver.test(version)) {
    return { kind: 'error', error: `${version} is not an exact version` };
  }

  const tokens = integrity.split(/\s+/).filter((token) => token !== '');
  if (
    tokens.length === 0 ||
    !tokens.every((token) => integrityToken.test(token))
  ) {
    return {
      kind: 'error',
      error: `${JSON.stringify(integrity)} is not an integrity`,
    };
  }

  return { kind: 'pin', pin: { version, integrity, tarball } };
}

function parseEntry(value: unknown): Entry {
  if (typeof value === 'string') {
    return value.includes('+')
      ? parsePin(value, undefined)
      : { kind: 'specifier', specifier: value };
  }

  const pin = decodeTarballPin(value, { onExcessProperty: 'error' });
  if (Result.isFailure(pin)) {
    return { kind: 'error', error: String(pin.failure) };
  }

  const { integrity, tarball } = pin.success;
  if (tarball !== undefined && tarball !== '' && !httpTarball.test(tarball)) {
    return {
      kind: 'error',
      error: `pnpm pins config dependencies to http(s) tarballs, not ${tarball}`,
    };
  }

  return integrity.includes('+')
    ? parsePin(integrity, tarball === '' ? undefined : tarball)
    : {
        kind: 'error',
        error: `${JSON.stringify(integrity)} is not <version>+<integrity>`,
      };
}

function samePin(name: string, pin: Pin, env: EnvConfigDependency): boolean {
  return (
    pin.version === env.version &&
    pin.integrity === env.resolution?.integrity &&
    (pin.tarball ?? registryTarball(name, pin.version)) ===
      (env.resolution?.tarball ?? registryTarball(name, env.version))
  );
}

function packageNode(
  location: Location,
  version: string | null,
  source: LockfileSource,
): LockfileNode {
  return {
    kind: 'package',
    ...location,
    name: location.dependency,
    version,
    source,
    dev: false,
    optional: false,
    hasInstallScript: null,
  };
}

function pinnedNode(location: Location, pin: Pin): LockfileNode {
  const name = location.dependency;
  const classified = classifyTarball(
    name,
    pin.version,
    pin.tarball === undefined
      ? { integrity: pin.integrity }
      : { integrity: pin.integrity, tarball: pin.tarball },
    pin.version,
  );
  if (classified.kind !== 'source') {
    return {
      kind: 'unreadable',
      ...location,
      error:
        classified.kind === 'error'
          ? classified.error
          : `${name} resolves to a workspace`,
    };
  }

  return packageNode(location, classified.version, classified.source);
}

const inEnvDocument = { kind: 'env-document' } as const;

function configNode(
  location: Location,
  value: unknown,
  env: EnvConfigDependency | undefined,
): LockfileNode | typeof inEnvDocument {
  const name = location.dependency;
  if (!isPackageName(name)) {
    return { kind: 'unreadable', ...location, error: 'not a package name' };
  }

  const entry = parseEntry(value);
  if (entry.kind === 'error') {
    return { kind: 'unreadable', ...location, error: entry.error };
  }

  if (entry.kind === 'pin') {
    if (env === undefined) {
      return pinnedNode(location, entry.pin);
    }

    return samePin(name, entry.pin, env)
      ? inEnvDocument
      : {
          kind: 'unreadable',
          ...location,
          error: `pnpm-workspace.yaml pins ${name}@${entry.pin.version} and the lockfile's env document pins ${name}@${env.version} with other bytes; pnpm 10 installs the first, pnpm 11 and 12 the second`,
        };
  }

  const { specifier } = entry;
  if (env?.specifier === specifier) {
    return inEnvDocument;
  }

  return semver.test(specifier)
    ? packageNode(location, specifier, { kind: 'registry', integrity: null })
    : {
        kind: 'unreadable',
        ...location,
        error: `pnpm resolves ${specifier} from the registry at install`,
      };
}

function manifestNodes({ path, text }: ConfigFile): LockfileNode[] {
  const manifest = decodeManifest(text);
  if (Result.isFailure(manifest)) {
    return [{ kind: 'unreadable', path, error: String(manifest.failure) }];
  }

  return Object.keys(manifest.success.pnpm?.configDependencies ?? {}).map(
    (name) => ({
      kind: 'unreadable',
      path,
      dependency: name,
      error:
        'pnpm 10 installs config dependencies listed in package.json; gate reads them only from pnpm-workspace.yaml',
    }),
  );
}

function workspaceNodes(
  { path, text }: ConfigFile,
  env: ReadonlyMap<string, EnvConfigDependency>,
): LockfileNode[] | undefined {
  if (text.trim() === '') {
    return undefined;
  }

  const yaml = readYaml(text);
  if (yaml.kind === 'unreadable') {
    return [{ kind: 'unreadable', path, error: yaml.error }];
  }

  const settings = decodeSettings(yaml.value);
  if (Result.isFailure(settings)) {
    return [{ kind: 'unreadable', path, error: String(settings.failure) }];
  }

  const configDependencies = settings.success?.configDependencies;

  return configDependencies === undefined
    ? undefined
    : Object.entries(configDependencies).flatMap(([name, value]) => {
        const node = configNode(
          { path, dependency: name },
          value,
          env.get(name),
        );

        return node.kind === 'env-document' ? [] : [node];
      });
}

export function readPnpmConfigDependencies<F extends ConfigFile>(input: {
  readonly env: ReadonlyMap<string, EnvConfigDependency>;
  readonly workspace?: F;
  readonly manifest?: F;
}): { readonly file: F; readonly nodes: LockfileNode[] } | undefined {
  const { workspace, manifest } = input;
  const nodes =
    workspace === undefined ? undefined : workspaceNodes(workspace, input.env);
  if (workspace !== undefined && nodes !== undefined) {
    return { file: workspace, nodes };
  }

  return manifest === undefined
    ? undefined
    : { file: manifest, nodes: manifestNodes(manifest) };
}
