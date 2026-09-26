import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Schema } from 'effect';

const Lock = Schema.Struct({
  lockfileVersion: Schema.Number,
  packages: Schema.Record(
    Schema.String,
    Schema.Record(Schema.String, Schema.Unknown),
  ),
});
type Lock = typeof Lock.Type;

const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Lock));

export function recordedLockPath(name: 'npm-cli' | 'sigstore-js'): string {
  return fileURLToPath(new URL(`./${name}.package-lock.json`, import.meta.url));
}

export function recordedLock(name: 'npm-cli' | 'sigstore-js'): Lock {
  return decode(readFileSync(recordedLockPath(name), 'utf8'));
}

function withPackages(lock: Lock, packages: Lock['packages']): Lock {
  return { ...lock, packages: { ...lock.packages, ...packages } };
}

export function linkOutsideRepository(): Lock {
  return withPackages(recordedLock('npm-cli'), {
    'node_modules/libnpmaccess': { resolved: '../libnpmaccess', link: true },
    '../libnpmaccess': { version: '11.0.0' },
  });
}

export function linkNoPatternCovers(): Lock {
  return withPackages(recordedLock('npm-cli'), {
    'node_modules/vendored': { resolved: 'vendor/vendored', link: true },
    'vendor/vendored': { version: '1.0.0' },
  });
}

export function rootWithoutWorkspaces(): Lock {
  const lock = recordedLock('npm-cli');
  const root = Object.entries(lock.packages[''] ?? {}).filter(
    ([key]) => key !== 'workspaces',
  );

  return withPackages(lock, { '': Object.fromEntries(root) });
}
