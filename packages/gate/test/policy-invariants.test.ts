import { expect, test } from 'bun:test';
import { Schema } from 'effect';
import { Waiver, type DecisionContext } from '../src/context';
import {
  Sha512Integrity,
  type Identity,
  type PackageVersionEvidence,
  type RepositoryCheck,
} from '../src/evidence';
import { decide, type Decision, type Policy } from '../src/policy';
import {
  loadSupplyChainPolicyV2,
  loadSupplyChainPolicyV3,
} from './support/policies';

type Evidence = PackageVersionEvidence;
type Publisher = NonNullable<Evidence['publisherExcludingRemoved']>;

const now = new Date('2026-06-01T00:00:00Z');
const hoursAgo = (n: number) => new Date(now.getTime() - n * 3_600_000);
const hours = 3_600_000;
const integrity = Sha512Integrity.make(`sha512-${'A'.repeat(86)}==`);
const account = { kind: 'account', name: 'maintainer' } as const;
const other = { kind: 'account', name: 'other' } as const;
const workflow = {
  kind: 'workflow',
  repository: 'https://github.com/acme/lib',
  workflow: '.github/workflows/release.yml',
} as const;

const sources: Evidence['source'][] = [
  { kind: 'registry', registry: 'https://registry.npmjs.org', integrity },
  { kind: 'registry', registry: 'https://registry.npmjs.org', integrity: null },
  { kind: 'url', spec: 'https://acme.dev/lib.tgz', integrity },
];

const publishTimes: Evidence['publishTime'][] = [
  { kind: 'unknown', reason: 'missing' },
  ...[71.99, 72, 2159.99, 2160].map((age) => ({
    kind: 'packument' as const,
    at: hoursAgo(age),
  })),
];

const provenances: Evidence['provenance'][] = [
  { kind: 'verified', repository: workflow.repository, workflow: 'release' },
  { kind: 'absent' },
  { kind: 'unavailable', reason: 'timeout' },
];

const histories = ['some', 'none', 'unknown'] as const;

function publishers(publishTime: Evidence['publishTime']): Publisher[] {
  const published = publishTime.kind === 'packument' ? publishTime.at : now;
  const joined = (age: number) => new Date(published.getTime() - age * hours);
  const changed = (
    identity: Identity,
    earlier: readonly [Identity, ...Identity[]],
    repositoryCheck: RepositoryCheck,
  ): Publisher => ({ kind: 'changed', identity, earlier, repositoryCheck });

  return [
    { kind: 'continuous', identity: account },
    { kind: 'continuous', identity: account, joinedAt: joined(719.99) },
    { kind: 'continuous', identity: account, joinedAt: joined(720) },
    { kind: 'continuous', identity: workflow },
    { kind: 'first', identity: account },
    changed(workflow, [account], 'matched'),
    changed(workflow, [account], 'mismatched'),
    changed(workflow, [account], 'unchecked'),
    changed(workflow, [account, other], 'matched'),
    changed(other, [account], 'unchecked'),
    { kind: 'unknown', reason: 'unreadable' },
  ];
}

const installScripts: Evidence['installScripts'][] = [
  { kind: 'none' },
  { kind: 'new', added: [{ hook: 'postinstall', command: 'node y.js' }] },
  { kind: 'unknown', reason: 'unreadable' },
];

const integrityChecks = ['matched', 'mismatched', 'unchecked'] as const;

const feeds: Evidence['feeds'][] = [
  { kind: 'checked', hits: [] },
  { kind: 'checked', hits: [{ feed: 'osv', id: 'MAL-0' }] },
  { kind: 'unavailable', reason: 'offline' },
];

const withoutRepositoryCheck = (publisher: Publisher): Evidence['publisher'] =>
  publisher.kind === 'changed'
    ? {
        kind: 'changed',
        identity: publisher.identity,
        earlier: publisher.earlier,
      }
    : publisher;

const dimensions: readonly (readonly Partial<Evidence>[])[] = [
  sources.map((source) => ({ source })),
  publishTimes.flatMap((publishTime) =>
    publishers(publishTime).map((publisher) => ({
      publishTime,
      publisher: withoutRepositoryCheck(publisher),
      publisherExcludingRemoved: publisher,
    })),
  ),
  provenances.map((provenance) => ({ provenance })),
  histories.map((earlierProvenance) => ({ earlierProvenance })),
  histories.map((history) => ({ earlierProvenanceExcludingRemoved: history })),
  installScripts.map((scripts) => ({ installScripts: scripts })),
  integrityChecks.map((integrityCheck) => ({ integrityCheck })),
  feeds.map((feed) => ({ feeds: feed })),
];

const base: Evidence = {
  subject: { ecosystem: 'npm', name: 'lib', version: '1.2.0' },
  source: sources[0] ?? { kind: 'url', spec: 'unused', integrity: null },
  publishTime: { kind: 'unknown', reason: 'unset' },
  provenance: { kind: 'absent' },
  earlierProvenance: 'none',
  publisher: { kind: 'first', identity: account },
  installScripts: { kind: 'none' },
  integrityCheck: 'unchecked',
  feeds: { kind: 'checked', hits: [] },
  claims: [],
};

function* everyEvidence(index = 0, evidence = base): Generator<Evidence> {
  const dimension = dimensions[index];
  if (dimension === undefined) {
    yield evidence;

    return;
  }

  for (const patch of dimension) {
    yield* everyEvidence(index + 1, { ...evidence, ...patch });
  }
}

type History = {
  readonly publisher: (evidence: Evidence) => Publisher['kind'] | undefined;
  readonly earlierProvenance: (evidence: Evidence) => string | undefined;
};

const v2History: History = {
  publisher: (evidence) => evidence.publisher.kind,
  earlierProvenance: (evidence) => evidence.earlierProvenance,
};

const v3History: History = {
  publisher: (evidence) =>
    evidence.publisherExcludingRemoved?.kind ?? 'unknown',
  earlierProvenance: (evidence) =>
    evidence.earlierProvenanceExcludingRemoved ?? 'unknown',
};

function violations(
  evidence: Evidence,
  decision: Decision,
  history: History,
): string[] {
  const registry = evidence.source.kind === 'registry';
  const found: string[] = [];
  const requireOutcome = (law: string, holds: boolean) => {
    if (!holds) {
      found.push(law);
    }
  };

  const accepted = decision.outcome === 'ACCEPT';

  if (
    (evidence.feeds.kind === 'checked' && evidence.feeds.hits.length > 0) ||
    evidence.integrityCheck === 'mismatched'
  ) {
    requireOutcome(
      'a feed hit or integrity mismatch rejects',
      decision.outcome === 'REJECT',
    );
  }

  const unknown =
    evidence.feeds.kind === 'unavailable' ||
    evidence.installScripts.kind === 'unknown' ||
    (evidence.provenance.kind === 'absent' &&
      history.earlierProvenance(evidence) === 'unknown') ||
    (registry &&
      (evidence.provenance.kind === 'unavailable' ||
        history.publisher(evidence) === 'unknown' ||
        evidence.publishTime.kind === 'unknown' ||
        evidence.source.integrity === null));
  if (unknown) {
    requireOutcome('unknown evidence never accepts', !accepted);
  }

  if (
    registry &&
    evidence.publishTime.kind === 'packument' &&
    now.getTime() - evidence.publishTime.at.getTime() < 72 * hours
  ) {
    requireOutcome('a version inside the window never accepts', !accepted);
  }

  if (!registry) {
    requireOutcome(
      'a non-registry source never accepts without an allowlist entry',
      !accepted,
    );
  }

  return found;
}

const noContext: DecisionContext = { allowedSources: [], waivers: [] };
const decodeWaiver = Schema.decodeUnknownSync(Waiver);
const claims = [{ kind: 'malware', source: 'model', probability: 1 }];

function checkPolicy(policy: Policy, history: History) {
  const waiveEverything: DecisionContext = {
    allowedSources: [],
    waivers: policy.rules.map((rule) =>
      decodeWaiver({
        policy: policy.ref.id,
        package: 'lib',
        version: '1.2.0',
        integrity,
        rule: rule.code,
        reason: 'waive everything',
        author: 'probe@example.com',
        expiresAt: '2027-01-01T00:00:00Z',
      }),
    ),
  };
  const rules = new Map(policy.rules.map((rule) => [rule.code, rule]));
  let cases = 0;
  const failures = new Map<string, Evidence>();
  const fail = (law: string, evidence: Evidence) => {
    if (!failures.has(law)) {
      failures.set(law, evidence);
    }
  };

  for (const evidence of everyEvidence()) {
    const at = (context: DecisionContext, withClaims = false) =>
      decide({
        evidence: withClaims ? { ...evidence, claims } : evidence,
        now,
        context,
        canonical: policy,
      });
    const plain = at(noContext);
    const waivable = plain.reasons.some(
      (reason) => rules.get(reason.code)?.waivable === true,
    );
    const waived = waivable ? at(waiveEverything) : plain;
    const claimed = at(noContext, true);
    cases += 1;

    for (const law of violations(evidence, plain, history)) {
      fail(law, evidence);
    }

    for (const law of violations(evidence, waived, history)) {
      fail(`${law}, even with waivers`, evidence);
    }

    for (const reason of waived.reasons) {
      const rule = rules.get(reason.code);
      if (
        reason.kind === 'waived' &&
        (rule?.waivable !== true || rule.outcome !== 'QUARANTINE')
      ) {
        fail('a waiver clears only a waivable QUARANTINE rule', evidence);
      }
    }

    const expected =
      plain.outcome === 'ACCEPT' ? ['ACCEPT', 'QUARANTINE'] : [plain.outcome];
    if (!expected.includes(claimed.outcome)) {
      fail('a claim only moves ACCEPT to QUARANTINE', evidence);
    }
  }

  return { cases, failures: Object.fromEntries(failures) };
}

for (const [policy, history] of [
  [loadSupplyChainPolicyV2(), v2History],
  [loadSupplyChainPolicyV3(), v3History],
] as const) {
  test(`${policy.ref.id} keeps the decision rules for every combination of evidence kinds`, () => {
    const result = checkPolicy(policy, history);

    expect(result.cases).toBe(3 * 5 * 3 * 9 * 11 * 3 * 3 * 3);
    expect(result.failures).toEqual({});
  }, 30_000);
}
