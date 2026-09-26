import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readOsvSnapshot, type OsvSnapshot } from './osv';
import { trustMaterialFrom, type TrustMaterial } from './provenance';
import { isEvidenceName, type EvidenceStore } from './verify';

export class EvidenceDirectoryError extends Error {
  override readonly name = 'EvidenceDirectoryError';
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function readTrust(root: string): TrustMaterial | null {
  const path = join(root, 'trusted_root.json');
  if (!existsSync(path)) {
    return null;
  }

  try {
    return trustMaterialFrom(readJson(path));
  } catch {
    return null;
  }
}

function readOsv(root: string): OsvSnapshot {
  const dir = join(root, 'osv');
  if (!existsSync(dir)) {
    return { kind: 'unavailable', reason: 'no OSV snapshot recorded' };
  }

  const files = readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.json'))
    .toSorted();

  return readOsvSnapshot(files.map((file) => readJson(join(dir, file))));
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
