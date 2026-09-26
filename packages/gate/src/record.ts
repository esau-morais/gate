import { createHash } from 'node:crypto';
import { Schema } from 'effect';
import { canonicalJson } from './canonical-json';
import { DecisionContext } from './context';
import { PackageVersionEvidence } from './evidence';
import { Outcome, PolicyRef, Reason } from './policy';
import { UtcTimestamp } from './time';

export const LockfileDigest = Schema.String.check(
  Schema.isPattern(/^sha256:[0-9a-f]{64}$/),
).pipe(Schema.brand('LockfileDigest'));
export type LockfileDigest = typeof LockfileDigest.Type;

export function lockfileDigest(bytes: Uint8Array): LockfileDigest {
  return LockfileDigest.make(
    `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
  );
}

export const DecisionRecord = Schema.Struct({
  type: Schema.Literal('gate.decision/v1'),
  path: Schema.String,
  dependency: Schema.optionalKey(Schema.NonEmptyString),
  dev: Schema.Boolean,
  optional: Schema.Boolean,
  subject: PackageVersionEvidence.fields.subject,
  at: UtcTimestamp,
  lockfile: LockfileDigest,
  context: DecisionContext,
  evidence: PackageVersionEvidence,
  outcome: Outcome,
  reasons: Schema.Array(Reason),
  policies: Schema.NonEmptyArray(PolicyRef),
});
export type DecisionRecord = typeof DecisionRecord.Type;

const RecordJson = Schema.toCodecJson(DecisionRecord);
const toJson = Schema.encodeSync(RecordJson);
const fromJson = Schema.decodeUnknownSync(RecordJson);

export function encodeRecord(record: DecisionRecord): Uint8Array {
  return new TextEncoder().encode(canonicalJson(toJson(record)));
}

export type RecordRead =
  | { readonly kind: 'read'; readonly record: DecisionRecord }
  | { readonly kind: 'unreadable'; readonly error: string };

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

export function decodeRecord(bytes: Uint8Array): RecordRead {
  let record: DecisionRecord;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    record = fromJson(JSON.parse(text), { onExcessProperty: 'error' });
  } catch (error) {
    return { kind: 'unreadable', error: String(error) };
  }

  return sameBytes(encodeRecord(record), bytes)
    ? { kind: 'read', record }
    : {
        kind: 'unreadable',
        error: 'record bytes are not its canonical encoding',
      };
}
