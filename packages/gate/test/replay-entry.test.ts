import { expect, test } from 'bun:test';
import { noContext } from '../src/context';
import { npmVersionEvidence } from '../src/npm/evidence';
import { decide, PolicyDigest, type Policy } from '../src/policy';
import { pinnedPolicies } from '../src/pinned-policies';
import {
  encodeRecord,
  lockfileDigest,
  type DecisionRecord,
} from '../src/record';
import { replayEntry } from '../src/replay';
import {
  loadSupplyChainPolicyV1,
  loadSupplyChainPolicyV2,
} from './support/policies';

const at = new Date('2026-01-02T01:00:00.000Z');
const version = (v: string, time: string) => ({
  version: v,
  time: new Date(time),
  integrity: null,
  provenance: { kind: 'absent' as const },
  npmUser: 'maintainer',
  scripts: {},
});
const evidence = npmVersionEvidence({
  name: 'lib',
  registry: 'https://registry.npmjs.org',
  target: version('1.1.0', '2026-01-02T00:00:00Z'),
  earlier: [version('1.0.0', '2025-12-01T00:00:00Z')],
  feeds: { kind: 'checked', hits: [] },
  claims: [],
});

function record(policy: Policy): DecisionRecord {
  const decision = decide({
    evidence,
    now: at,
    context: noContext,
    canonical: policy,
  });

  return {
    type: 'gate.decision/v1',
    path: 'node_modules/lib',
    dev: false,
    optional: false,
    subject: evidence.subject,
    at,
    lockfile: lockfileDigest(new Uint8Array()),
    context: noContext,
    evidence,
    ...decision,
  };
}

const included = (logged: DecisionRecord) => ({
  index: 0,
  kind: 'included' as const,
  bytes: encodeRecord(logged),
});
const policies = pinnedPolicies();

test('a decision logged under v1 or v2 replays under the policy its digest names', () => {
  for (const policy of [loadSupplyChainPolicyV1(), loadSupplyChainPolicyV2()]) {
    const result = replayEntry(included(record(policy)), policies);

    expect(result).toMatchObject({ index: 0, result: 'match' });
    expect(result.result === 'match' && result.policies).toEqual([policy.ref]);
  }
});

test('a logged outcome the policy does not produce is a mismatch', () => {
  const logged = record(loadSupplyChainPolicyV2());
  expect(logged.outcome).toBe('QUARANTINE');

  const result = replayEntry(
    included({ ...logged, outcome: 'ACCEPT', reasons: [] }),
    policies,
  );

  expect(result).toMatchObject({
    result: 'mismatch',
    logged: { outcome: 'ACCEPT', reasons: [] },
    replayed: { outcome: 'QUARANTINE' },
  });
});

test('an unknown policy digest fails instead of being skipped', () => {
  const logged = record(loadSupplyChainPolicyV2());
  const unknown = {
    id: 'SupplyChainPolicy/v2',
    digest: PolicyDigest.make(`sha256:${'0'.repeat(64)}`),
  };

  const result = replayEntry(
    included({ ...logged, policies: [unknown] }),
    policies,
  );

  expect(result.result === 'failed' ? result.error : '').toContain(
    'unknown policy digest',
  );
});

test('a known digest logged under another policy id fails', () => {
  const logged = record(loadSupplyChainPolicyV2());
  const [ref] = logged.policies;

  expect(
    replayEntry(
      included({
        ...logged,
        policies: [{ ...ref, id: 'SupplyChainPolicy/v9' }],
      }),
      policies,
    ).result,
  ).toBe('failed');
});

test('a record whose subject differs from its evidence fails', () => {
  const logged = record(loadSupplyChainPolicyV2());

  expect(
    replayEntry(
      included({ ...logged, subject: { ...logged.subject, name: 'other' } }),
      policies,
    ).result,
  ).toBe('failed');
});

test('an unreadable record or a failed entry fails', () => {
  expect(
    replayEntry(
      { index: 3, kind: 'included', bytes: new TextEncoder().encode('{}') },
      policies,
    ),
  ).toMatchObject({ index: 3, result: 'failed' });
  expect(
    replayEntry({ index: 4, kind: 'failed', error: 'missing' }, policies),
  ).toEqual({ index: 4, result: 'failed', error: 'missing' });
});
