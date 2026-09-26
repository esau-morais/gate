import { isDeepStrictEqual } from 'node:util';
import { Schema } from 'effect';
import { canonicalJson } from './canonical-json';
import type { PackageVersionEvidence } from './evidence';
import type { LogEntry } from './log/log';
import {
  decide,
  Decision,
  type Policy,
  type PolicyDigest,
  type PolicyRef,
} from './policy';
import { decodeRecord, type DecisionRecord } from './record';

export type ReplayResult =
  | {
      readonly index: number;
      readonly result: 'match';
      readonly path: string;
      readonly dependency?: string;
      readonly subject: PackageVersionEvidence['subject'];
      readonly outcome: Decision['outcome'];
      readonly reasons: Decision['reasons'];
      readonly policies: Decision['policies'];
    }
  | {
      readonly index: number;
      readonly result: 'mismatch';
      readonly error: string;
      readonly logged: Decision;
      readonly replayed: Decision;
    }
  | {
      readonly index: number;
      readonly result: 'failed';
      readonly error: string;
    };

const decisionJson = Schema.encodeSync(Schema.toCodecJson(Decision));
const decisionBytes = (decision: Decision) =>
  canonicalJson(decisionJson(decision));

type Resolved =
  | { readonly kind: 'resolved'; readonly canonical: Policy }
  | { readonly kind: 'unresolved'; readonly error: string };

function resolvePolicy(
  refs: readonly PolicyRef[],
  pinned: ReadonlyMap<PolicyDigest, Policy>,
): Resolved {
  const [ref, ...org] = refs;
  if (ref === undefined || org.length > 0) {
    return {
      kind: 'unresolved',
      error: `record names ${refs.length} policies; replay knows only the pinned canonical policies`,
    };
  }

  const policy = pinned.get(ref.digest);
  if (policy === undefined) {
    return { kind: 'unresolved', error: `unknown policy digest ${ref.digest}` };
  }

  return policy.ref.id === ref.id
    ? { kind: 'resolved', canonical: policy }
    : {
        kind: 'unresolved',
        error: `policy ${ref.digest} is ${policy.ref.id}, not ${ref.id}`,
      };
}

function replayRecord(
  index: number,
  record: DecisionRecord,
  pinned: ReadonlyMap<PolicyDigest, Policy>,
): ReplayResult {
  if (!isDeepStrictEqual(record.subject, record.evidence.subject)) {
    return {
      index,
      result: 'failed',
      error: 'record subject differs from its evidence subject',
    };
  }

  const policy = resolvePolicy(record.policies, pinned);
  if (policy.kind === 'unresolved') {
    return { index, result: 'failed', error: policy.error };
  }

  const logged: Decision = {
    outcome: record.outcome,
    reasons: record.reasons,
    policies: record.policies,
  };
  const replayed = decide({
    evidence: record.evidence,
    now: record.at,
    context: record.context,
    canonical: policy.canonical,
  });
  if (decisionBytes(replayed) !== decisionBytes(logged)) {
    return {
      index,
      result: 'mismatch',
      error: 'the policy gives a different decision from the logged one',
      logged,
      replayed,
    };
  }

  return {
    index,
    result: 'match',
    path: record.path,
    ...(record.dependency === undefined
      ? {}
      : { dependency: record.dependency }),
    subject: record.subject,
    ...logged,
  };
}

export function replayEntry(
  entry: LogEntry,
  pinned: ReadonlyMap<PolicyDigest, Policy>,
): ReplayResult {
  if (entry.kind === 'failed') {
    return { index: entry.index, result: 'failed', error: entry.error };
  }

  const read = decodeRecord(entry.bytes);

  return read.kind === 'read'
    ? replayRecord(entry.index, read.record, pinned)
    : {
        index: entry.index,
        result: 'failed',
        error: `unreadable record: ${read.error}`,
      };
}

export function replayExitCode(results: readonly ReplayResult[]): 0 | 1 {
  return results.every((result) => result.result === 'match') ? 0 : 1;
}
