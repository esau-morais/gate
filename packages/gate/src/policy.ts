import { createHash } from 'node:crypto';
import { Environment, type ParseResult } from '@gate/cel';
import { Schema } from 'effect';
import { Waiver, type DecisionContext } from './context';
import type { PackageVersionEvidence } from './evidence';

export const PolicyDigest = Schema.String.check(
  Schema.isPattern(/^sha256:[0-9a-f]{64}$/),
).pipe(Schema.brand('PolicyDigest'));
export type PolicyDigest = typeof PolicyDigest.Type;

export const Outcome = Schema.Literals(['ACCEPT', 'QUARANTINE', 'REJECT']);
export type Outcome = typeof Outcome.Type;

export const PolicyRef = Schema.Struct({
  id: Schema.NonEmptyString,
  digest: PolicyDigest,
});
export type PolicyRef = typeof PolicyRef.Type;

const RuleOutcome = Schema.Literals(['QUARANTINE', 'REJECT']);

export const Reason = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('fired'),
    policy: PolicyRef,
    code: Schema.String,
    outcome: RuleOutcome,
  }),
  Schema.Struct({
    kind: Schema.Literal('failed'),
    policy: PolicyRef,
    code: Schema.String,
    outcome: RuleOutcome,
    error: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal('waived'),
    policy: PolicyRef,
    code: Schema.String,
    outcome: Schema.Literal('QUARANTINE'),
    waiver: Waiver,
  }),
]);
export type Reason = typeof Reason.Type;

export const Decision = Schema.Struct({
  outcome: Outcome,
  reasons: Schema.Array(Reason),
  policies: Schema.NonEmptyArray(PolicyRef),
});
export type Decision = typeof Decision.Type;

type Rule = {
  readonly code: string;
  readonly outcome: 'QUARANTINE' | 'REJECT';
  readonly waivable: boolean;
  readonly evaluate: ParseResult;
};

export type Policy = {
  readonly ref: PolicyRef;
  readonly rules: readonly Rule[];
};

export class PolicyLoadError extends Error {
  override readonly name = 'PolicyLoadError';
}

const PolicyDocument = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.NonEmptyString,
    rules: Schema.NonEmptyArray(
      Schema.Struct({
        code: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_]*$/)),
        outcome: RuleOutcome,
        when: Schema.NonEmptyString,
        waivable: Schema.optionalKey(Schema.Boolean),
      }),
    ),
  }),
);

const evidenceEnvironment = new Environment()
  .registerType({
    name: 'FeedHit',
    schema: { feed: 'string', id: 'string' },
  })
  .registerType({
    name: 'Identity',
    schema: {
      kind: 'string',
      name: 'string',
      repository: 'string',
      workflow: 'string',
    },
  })
  .registerVariable('evidence', {
    schema: {
      subject: { ecosystem: 'string', name: 'string', version: 'string' },
      source: { kind: 'string', spec: 'string', integrity: 'string' },
      publishTime: { kind: 'string', at: 'google.protobuf.Timestamp' },
      provenance: { kind: 'string' },
      earlierProvenance: 'string',
      earlierProvenanceExcludingRemoved: 'string',
      publisher: {
        kind: 'string',
        identity: { kind: 'string' },
        joinedAt: 'google.protobuf.Timestamp',
      },
      publisherExcludingRemoved: {
        kind: 'string',
        identity: { kind: 'string' },
        joinedAt: 'google.protobuf.Timestamp',
        earlier: 'list<Identity>',
        repositoryCheck: 'string',
      },
      installScripts: { kind: 'string' },
      integrityCheck: 'string',
      feeds: { kind: 'string', hits: 'list<FeedHit>' },
    },
  })
  .registerVariable('now', 'google.protobuf.Timestamp')
  .registerType({
    name: 'AllowedSource',
    schema: {
      kind: 'string',
      name: 'string',
      spec: 'string',
      integrity: 'string',
    },
  })
  .registerVariable('context', {
    schema: { allowedSources: 'list<AllowedSource>' },
  });

const claimsEnvironment = evidenceEnvironment
  .clone()
  .registerType({
    name: 'Claim',
    schema: { kind: 'string', source: 'string', probability: 'double' },
  })
  .registerVariable('claims', 'list<Claim>');

const environments = {
  REJECT: evidenceEnvironment,
  QUARANTINE: claimsEnvironment,
} as const;

const severity: Record<Outcome, number> = {
  ACCEPT: 0,
  QUARANTINE: 1,
  REJECT: 2,
};

export function policyDigest(bytes: Uint8Array): PolicyDigest {
  return PolicyDigest.make(
    `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
  );
}

function compile(
  policyId: string,
  rule: (typeof PolicyDocument.Type)['rules'][number],
): Rule {
  const fail = (why: string) =>
    new PolicyLoadError(`${policyId} rule ${rule.code}: ${why}`);
  const waivable = rule.waivable ?? false;
  if (waivable && rule.outcome === 'REJECT') {
    throw fail('a REJECT rule cannot be waivable');
  }

  let evaluate: ParseResult;
  try {
    evaluate = environments[rule.outcome].parse(rule.when);
  } catch (error) {
    throw fail(String(error));
  }

  const checked = evaluate.check();
  if (!checked.valid) {
    throw fail(String(checked.error));
  }

  if (checked.type !== 'bool') {
    throw fail(`evaluates to ${checked.type}, not bool`);
  }

  return { code: rule.code, outcome: rule.outcome, waivable, evaluate };
}

export function loadPolicy(bytes: Uint8Array, digest: PolicyDigest): Policy {
  const actual = policyDigest(bytes);
  if (actual !== digest) {
    throw new PolicyLoadError(
      `policy digest ${actual} is not the pinned ${digest}`,
    );
  }

  let document: typeof PolicyDocument.Type;
  try {
    document = Schema.decodeUnknownSync(PolicyDocument)(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    );
  } catch (error) {
    throw new PolicyLoadError(
      `policy ${digest} is malformed: ${String(error)}`,
    );
  }

  const codes = new Set<string>();
  for (const { code } of document.rules) {
    if (codes.has(code)) {
      throw new PolicyLoadError(`${document.id} repeats rule ${code}`);
    }

    codes.add(code);
  }

  return {
    ref: { id: document.id, digest },
    rules: document.rules.map((rule) => compile(document.id, rule)),
  };
}

export function waiverNames(
  waiver: Waiver,
  target: { policy: PolicyRef; code: string; evidence: PackageVersionEvidence },
): boolean {
  const { subject, source } = target.evidence;

  return (
    source.integrity !== null &&
    waiver.policy === target.policy.id &&
    waiver.rule === target.code &&
    waiver.package === subject.name &&
    waiver.version === subject.version &&
    waiver.integrity === source.integrity
  );
}

function findWaiver(
  policy: PolicyRef,
  rule: Rule,
  evidence: PackageVersionEvidence,
  now: Date,
  waivers: readonly Waiver[],
): Waiver | undefined {
  if (!rule.waivable) {
    return undefined;
  }

  return waivers.find(
    (waiver) =>
      waiverNames(waiver, { policy, code: rule.code, evidence }) &&
      now < waiver.expiresAt,
  );
}

function evaluatePolicy(
  policy: Policy,
  variables: Record<string, unknown>,
  waive: (policy: PolicyRef, rule: Rule) => Waiver | undefined,
): Reason[] {
  return policy.rules.flatMap((rule): Reason[] => {
    let result: unknown;
    try {
      result = rule.evaluate(variables);
    } catch (error) {
      return [
        {
          kind: 'failed',
          policy: policy.ref,
          code: rule.code,
          outcome: rule.outcome,
          error: String(error),
        },
      ];
    }

    if (result === false) {
      return [];
    }

    const waiver = result === true ? waive(policy.ref, rule) : undefined;
    if (waiver !== undefined) {
      return [
        {
          kind: 'waived',
          policy: policy.ref,
          code: rule.code,
          outcome: 'QUARANTINE',
          waiver,
        },
      ];
    }

    return result === true
      ? [
          {
            kind: 'fired',
            policy: policy.ref,
            code: rule.code,
            outcome: rule.outcome,
          },
        ]
      : [
          {
            kind: 'failed',
            policy: policy.ref,
            code: rule.code,
            outcome: rule.outcome,
            error: 'rule did not return a bool',
          },
        ];
  });
}

export function decide(input: {
  evidence: PackageVersionEvidence;
  now: Date;
  context: DecisionContext;
  canonical: Policy;
  org?: Policy;
}): Decision {
  const policies: readonly [Policy, ...Policy[]] =
    input.org === undefined ? [input.canonical] : [input.canonical, input.org];
  const { evidence, now, context } = input;
  const variables = {
    evidence: {
      ...evidence,
      subject: { ...evidence.subject, version: evidence.subject.version ?? '' },
      source: {
        ...evidence.source,
        integrity: evidence.source.integrity ?? '',
      },
    },
    claims: evidence.claims,
    now,
    context: {
      allowedSources: context.allowedSources.map((entry) => ({
        integrity: '',
        ...entry,
      })),
    },
  };
  const reasons = policies.flatMap((policy) =>
    evaluatePolicy(policy, variables, (ref, rule) =>
      findWaiver(ref, rule, evidence, now, context.waivers),
    ),
  );
  const outcome = reasons.reduce<Outcome>(
    (strictest, reason) =>
      reason.kind !== 'waived' && severity[reason.outcome] > severity[strictest]
        ? reason.outcome
        : strictest,
    'ACCEPT',
  );

  const [canonical, ...org] = policies;

  return {
    outcome,
    reasons,
    policies: [canonical.ref, ...org.map((policy) => policy.ref)],
  };
}
