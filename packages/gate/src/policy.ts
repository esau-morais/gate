import { createHash } from 'node:crypto';
import { Environment, type ParseResult } from '@gate/cel';
import { Schema } from 'effect';
import type { DecisionContext, Waiver } from './context';
import type { PackageVersionEvidence } from './evidence';

export const PolicyDigest = Schema.String.check(
  Schema.isPattern(/^sha256:[0-9a-f]{64}$/),
).pipe(Schema.brand('PolicyDigest'));
export type PolicyDigest = typeof PolicyDigest.Type;

export type Outcome = 'ACCEPT' | 'QUARANTINE' | 'REJECT';
export type PolicyRef = { readonly id: string; readonly digest: PolicyDigest };

export type Reason =
  | {
      readonly kind: 'fired';
      readonly policy: PolicyRef;
      readonly code: string;
      readonly outcome: 'QUARANTINE' | 'REJECT';
    }
  | {
      readonly kind: 'failed';
      readonly policy: PolicyRef;
      readonly code: string;
      readonly outcome: 'QUARANTINE' | 'REJECT';
      readonly error: string;
    }
  | {
      readonly kind: 'waived';
      readonly policy: PolicyRef;
      readonly code: string;
      readonly outcome: 'QUARANTINE';
      readonly waiver: Waiver;
    };

export type Decision = {
  readonly outcome: Outcome;
  readonly reasons: readonly Reason[];
  readonly policies: readonly PolicyRef[];
};

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
        outcome: Schema.Literals(['QUARANTINE', 'REJECT']),
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
  .registerVariable('evidence', {
    schema: {
      subject: { ecosystem: 'string', name: 'string', version: 'string' },
      source: { kind: 'string', spec: 'string', integrity: 'string' },
      publishTime: { kind: 'string', at: 'google.protobuf.Timestamp' },
      provenance: { kind: 'string' },
      earlierProvenance: 'string',
      publisher: {
        kind: 'string',
        identity: { kind: 'string' },
        joinedAt: 'google.protobuf.Timestamp',
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

function findWaiver(
  policy: PolicyRef,
  rule: Rule,
  evidence: PackageVersionEvidence,
  now: Date,
  waivers: readonly Waiver[],
): Waiver | undefined {
  const { integrity } = evidence.source;
  if (!rule.waivable || integrity === null) {
    return undefined;
  }

  return waivers.find(
    (waiver) =>
      waiver.policy === policy.id &&
      waiver.rule === rule.code &&
      waiver.package === evidence.subject.name &&
      waiver.version === evidence.subject.version &&
      waiver.integrity === integrity &&
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
  const policies =
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

  return { outcome, reasons, policies: policies.map((policy) => policy.ref) };
}
