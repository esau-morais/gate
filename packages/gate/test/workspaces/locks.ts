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
export type Lock = typeof Lock.Type;

const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Lock));

export function recordedLockPath(name: 'npm-cli' | 'sigstore-js'): string {
  return fileURLToPath(new URL(`./${name}.package-lock.json`, import.meta.url));
}

export function recordedLock(name: 'npm-cli' | 'sigstore-js'): Lock {
  return decode(readFileSync(recordedLockPath(name), 'utf8'));
}
