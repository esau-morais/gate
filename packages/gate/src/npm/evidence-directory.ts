import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readOsvSnapshot, type OsvSnapshot } from './osv';
import { trustMaterialFrom, type TrustRoot } from './provenance';
import type { EvidenceStore } from './verify';

const npmName = /^(@[\w.~-]+\/)?[\w.~-]+$/;
const osvManifest = 'manifest.json';

export function isEvidenceName(name: string): boolean {
  return (
    npmName.test(name) &&
    !name.split('/').some((segment) => segment === '.' || segment === '..')
  );
}

export class EvidenceDirectoryError extends Error {
  override readonly name = 'EvidenceDirectoryError';
}

export function isFileSystemError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    'syscall' in error
  );
}

function readJson(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (isFileSystemError(error)) {
      return null;
    }

    throw error;
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return null;
    }

    throw error;
  }
}

function readTrust(root: string): TrustRoot {
  const path = join(root, 'trusted_root.json');
  if (!existsSync(path)) {
    return { kind: 'unavailable', reason: 'no trusted root recorded' };
  }

  try {
    return { kind: 'loaded', material: trustMaterialFrom(readJson(path)) };
  } catch (error) {
    return {
      kind: 'unavailable',
      reason: `trusted root is unreadable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function readOsv(root: string): OsvSnapshot {
  const dir = join(root, 'osv');
  if (!existsSync(dir)) {
    return { kind: 'unavailable', reason: 'no OSV snapshot recorded' };
  }

  const manifest = join(dir, osvManifest);
  const files = readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.json') && file !== osvManifest)
    .toSorted();

  return readOsvSnapshot({
    manifest: existsSync(manifest) ? readJson(manifest) : undefined,
    records: files.map((file) => readJson(join(dir, file))),
  });
}

function readAttestations(
  root: string,
  name: string,
): ReadonlyMap<string, unknown> {
  const file = join(root, 'attestations', `${name}@`);
  const dir = dirname(file);
  const prefix = file.slice(dir.length + 1);
  if (!existsSync(dir)) {
    return new Map();
  }

  return new Map(
    readdirSync(dir)
      .filter((entry) => entry.startsWith(prefix) && entry.endsWith('.json'))
      .map((entry) => [
        entry.slice(prefix.length, -'.json'.length),
        readJson(join(dir, entry)),
      ]),
  );
}

export function readEvidenceDirectory(root: string): EvidenceStore {
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new EvidenceDirectoryError(`${root} is not a directory`);
  }

  const guarded =
    <T>(read: (name: string) => T, fallback: T) =>
    (name: string): T =>
      isEvidenceName(name) ? read(name) : fallback;

  return {
    packument: guarded((name) => {
      const path = join(root, 'packuments', `${name}.json`);

      return existsSync(path) ? readJson(path) : undefined;
    }, undefined),
    attestations: guarded(
      (name) => readAttestations(root, name),
      new Map<string, unknown>(),
    ),
    trust: readTrust(root),
    osv: readOsv(root),
  };
}
