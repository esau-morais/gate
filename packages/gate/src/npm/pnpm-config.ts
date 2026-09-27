import { Result, Schema } from 'effect';
import { readYaml } from '../yaml';
import { registryTarball, type LockfileNode } from './lockfile';
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
  tarball: Schema.optionalKey(Schema.NonEmptyString),
  integrity: Schema.String,
});

const decodeSettings = Schema.decodeUnknownResult(Settings);
const decodeManifest = Schema.decodeUnknownResult(Manifest);
const decodeTarballPin = Schema.decodeUnknownResult(TarballPin);

const integrityToken = /^sha(?:1|256|384|512)-[A-Za-z0-9+/]+={0,2}$/;
const reservedNames = new Set(['node_modules', 'favicon.ico']);
const byteOrderMark = String.fromCodePoint(0xfeff);

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

  return integrity.includes('+')
    ? parsePin(integrity, tarball)
    : {
        kind: 'error',
        error: `${JSON.stringify(integrity)} is not <version>+<integrity>`,
      };
}

function samePin(name: string, pin: Pin, env: EnvConfigDependency): boolean {
  return (
    pin.version === env.version &&
    pin.integrity === env.integrity &&
    (pin.tarball ?? registryTarball(name, pin.version)) ===
      (env.tarball ?? registryTarball(name, env.version))
  );
}

function pinnedNode(
  location: { path: string; dependency: string },
  pin: Pin,
): LockfileNode {
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

  return {
    kind: 'package',
    ...location,
    name,
    version: classified.version,
    source: classified.source,
    dev: false,
    optional: false,
    hasInstallScript: null,
  };
}

function configNode(
  path: string,
  name: string,
  value: unknown,
  env: EnvConfigDependency | undefined,
): LockfileNode | undefined {
  const location = { path, dependency: name };
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
      ? undefined
      : {
          kind: 'unreadable',
          ...location,
          error: `pnpm-workspace.yaml pins ${name}@${entry.pin.version} and the lockfile's env document pins ${name}@${env.version} with other bytes; pnpm 10 installs the first, pnpm 11 and 12 the second`,
        };
  }

  const { specifier } = entry;
  if (env?.specifier === specifier) {
    return undefined;
  }

  return semver.test(specifier)
    ? {
        kind: 'package',
        ...location,
        name,
        version: specifier,
        source: { kind: 'registry', integrity: null },
        dev: false,
        optional: false,
        hasInstallScript: null,
      }
    : {
        kind: 'unreadable',
        ...location,
        error: `pnpm resolves ${specifier} from the registry at install`,
      };
}

function manifestNodes(path: string, text: string): LockfileNode[] {
  const manifest = decodeManifest(
    text.startsWith(byteOrderMark) ? text.slice(byteOrderMark.length) : text,
  );
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

export function readPnpmConfigDependencies(input: {
  readonly env: ReadonlyMap<string, EnvConfigDependency>;
  readonly workspace?: { readonly path: string; readonly text: string };
  readonly manifest?: { readonly path: string; readonly text: string };
}): LockfileNode[] {
  const { workspace, manifest } = input;
  let configDependencies: Readonly<Record<string, unknown>> | undefined;
  if (workspace !== undefined && workspace.text.trim() !== '') {
    const yaml = readYaml(workspace.text);
    if (yaml.kind === 'unreadable') {
      return [{ kind: 'unreadable', path: workspace.path, error: yaml.error }];
    }

    const settings = decodeSettings(yaml.value);
    if (Result.isFailure(settings)) {
      return [
        {
          kind: 'unreadable',
          path: workspace.path,
          error: String(settings.failure),
        },
      ];
    }

    configDependencies = settings.success?.configDependencies;
  }

  if (configDependencies === undefined || workspace === undefined) {
    return manifest === undefined
      ? []
      : manifestNodes(manifest.path, manifest.text);
  }

  return Object.entries(configDependencies).flatMap(([name, value]) => {
    const node = configNode(workspace.path, name, value, input.env.get(name));

    return node === undefined ? [] : [node];
  });
}
