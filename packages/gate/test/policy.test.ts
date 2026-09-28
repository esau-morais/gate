import { describe, expect, test } from 'bun:test';
import { Schema } from 'effect';
import { AllowedSource, Waiver } from '../src/context';
import {
  Sha512Integrity,
  type FirstPublish,
  type Identity,
  type PackageVersionEvidence,
  type RepositoryCheck,
} from '../src/evidence';
import { decide, loadPolicy, policyDigest, type Policy } from '../src/policy';
import {
  loadSupplyChainPolicyV1,
  loadSupplyChainPolicyV2,
  loadSupplyChainPolicyV3,
  loadSupplyChainPolicyV4,
  supplyChainPolicyV1,
  supplyChainPolicyV3,
  supplyChainPolicyV4,
} from './support/policies';

const policy = loadSupplyChainPolicyV1();
const policyV2 = loadSupplyChainPolicyV2();
const policyV3 = loadSupplyChainPolicyV3();
const policyV4 = loadSupplyChainPolicyV4();
const now = new Date('2026-06-01T00:00:00Z');
const hours = (n: number) => new Date(now.getTime() - n * 3_600_000);
const identity = {
  kind: 'workflow',
  repository: 'github.com/acme/lib',
  workflow: '.github/workflows/release.yml',
} as const;
const integrity = Sha512Integrity.make(`sha512-${'A'.repeat(86)}==`);
const otherIntegrity = Sha512Integrity.make(`sha512-${'B'.repeat(86)}==`);
const commit = 'a'.repeat(40);

const clean: PackageVersionEvidence = {
  subject: { ecosystem: 'npm', name: 'lib', version: '1.2.0' },
  source: {
    kind: 'registry',
    registry: 'https://registry.npmjs.org',
    integrity,
  },
  publishTime: { kind: 'packument', at: hours(24 * 30) },
  provenance: {
    kind: 'verified',
    repository: identity.repository,
    workflow: identity.workflow,
  },
  earlierProvenance: 'some',
  publisher: { kind: 'continuous', identity },
  installScripts: { kind: 'none' },
  integrityCheck: 'matched',
  feeds: { kind: 'checked', hits: [] },
  claims: [],
};

function run(
  evidence: Partial<PackageVersionEvidence>,
  options: {
    canonical?: Policy;
    org?: Policy;
    allowedSources?: readonly unknown[];
    waivers?: readonly unknown[];
  } = {},
) {
  return decide({
    evidence: { ...clean, ...evidence },
    now,
    context: {
      allowedSources: (options.allowedSources ?? []).map((entry) =>
        decodeAllowedSource(entry),
      ),
      waivers: (options.waivers ?? []).map((entry) => decodeWaiver(entry)),
    },
    canonical: options.canonical ?? policy,
    ...(options.org === undefined ? {} : { org: options.org }),
  });
}

const decodeAllowedSource = Schema.decodeUnknownSync(AllowedSource);
const decodeWaiver = Schema.decodeUnknownSync(Waiver);

function codes(decision: ReturnType<typeof decide>): string[] {
  return decision.reasons
    .filter((reason) => reason.kind !== 'waived')
    .map((reason) => reason.code)
    .toSorted();
}

function orgPolicy(
  rules: readonly {
    code: string;
    outcome: string;
    when: string;
    waivable?: boolean;
  }[],
) {
  const bytes = new TextEncoder().encode(
    JSON.stringify({ id: 'org/acme', rules }),
  );

  return loadPolicy(bytes, policyDigest(bytes));
}

const script = { hook: 'postinstall', command: 'node x.js' } as const;

const firesEachRule: Record<string, Partial<PackageVersionEvidence>> = {
  feed_match: {
    feeds: { kind: 'checked', hits: [{ feed: 'osv', id: 'MAL-0' }] },
  },
  feeds_unavailable: { feeds: { kind: 'unavailable', reason: 'offline' } },
  integrity_unknown: {
    source: {
      kind: 'registry',
      registry: 'https://registry.npmjs.org',
      integrity: null,
    },
  },
  exotic_source: {
    source: { kind: 'git', spec: `github:acme/lib#${commit}`, integrity: null },
  },
  publish_time_unknown: { publishTime: { kind: 'unknown', reason: 'missing' } },
  release_age: { publishTime: { kind: 'packument', at: hours(1) } },
  provenance_unavailable: {
    provenance: { kind: 'unavailable', reason: 'timeout' },
  },
  trust_downgrade: { provenance: { kind: 'absent' } },
  provenance_history_unknown: {
    provenance: { kind: 'absent' },
    earlierProvenance: 'unknown',
  },
  publisher_changed: {
    publisher: {
      kind: 'changed',
      identity,
      earlier: [{ kind: 'account', name: 'someone' }],
    },
  },
  publisher_unknown: { publisher: { kind: 'unknown', reason: 'unreadable' } },
  publisher_recent: {
    publisher: {
      kind: 'continuous',
      identity: { kind: 'account', name: 'newcomer' },
      joinedAt: hours(24 * 33),
    },
  },
  new_install_script: { installScripts: { kind: 'new', added: [script] } },
  install_scripts_unknown: {
    installScripts: { kind: 'unknown', reason: 'unreadable' },
  },
};

test('every v1 rule fires on the evidence it guards', () => {
  expect(Object.keys(firesEachRule).toSorted()).toEqual(
    policy.rules.map((r) => r.code).toSorted(),
  );

  for (const [code, evidence] of Object.entries(firesEachRule)) {
    expect({ code, fired: codes(run(evidence)) }).toEqual({
      code,
      fired: [code],
    });
  }
});

describe('SupplyChainPolicy/v2', () => {
  test('rejects a lockfile integrity the registry does not list', () => {
    const mismatch = { integrityCheck: 'mismatched' } as const;

    expect(run(mismatch, { canonical: policyV2 })).toMatchObject({
      outcome: 'REJECT',
      reasons: [{ code: 'integrity_mismatch', outcome: 'REJECT' }],
    });
    expect(run(mismatch).outcome).toBe('ACCEPT');
  });

  test('keeps every v1 rule and its outcome', () => {
    expect(policyV2.rules.map((rule) => rule.code)).toEqual([
      ...policy.rules.map((rule) => rule.code),
      'integrity_mismatch',
    ]);

    for (const evidence of [{}, ...Object.values(firesEachRule)]) {
      const v2 = run(evidence, { canonical: policyV2 });

      expect([v2.outcome, codes(v2)]).toEqual([
        run(evidence).outcome,
        codes(run(evidence)),
      ]);
    }
  });

  test('a registry node whose integrity cannot be cross-checked has no bytes', () => {
    expect(
      codes(
        run(
          {
            integrityCheck: 'unchecked',
            source: { ...clean.source, integrity: null },
          },
          { canonical: policyV2 },
        ),
      ),
    ).toEqual(['integrity_unknown']);
  });
});

describe('SupplyChainPolicy/v3', () => {
  const account = { kind: 'account', name: 'someone' } as const;
  const excludingRemoved = (
    evidence: Partial<PackageVersionEvidence>,
  ): Partial<PackageVersionEvidence> => {
    const publisher = evidence.publisher ?? clean.publisher;

    return {
      ...evidence,
      earlierProvenanceExcludingRemoved:
        evidence.earlierProvenance ?? clean.earlierProvenance,
      publisherExcludingRemoved:
        publisher.kind === 'changed'
          ? { ...publisher, repositoryCheck: 'unchecked' }
          : publisher,
    };
  };

  const v3 = (evidence: Partial<PackageVersionEvidence>) =>
    run(excludingRemoved(evidence), { canonical: policyV3 });
  const aged = (days: number) =>
    ({ publishTime: { kind: 'packument', at: hours(24 * days) } }) as const;
  const changed = (
    repositoryCheck: RepositoryCheck,
    earlier: readonly [Identity, ...Identity[]] = [account],
    publisherIdentity: Identity = identity,
  ): Partial<PackageVersionEvidence> => ({
    publisher: { kind: 'unknown', reason: 'an earlier version was removed' },
    publisherExcludingRemoved: {
      kind: 'changed',
      identity: publisherIdentity,
      earlier,
      repositoryCheck,
    },
  });
  const decideV3 = (evidence: Partial<PackageVersionEvidence>) =>
    run(
      {
        earlierProvenanceExcludingRemoved: clean.earlierProvenance,
        publisherExcludingRemoved: { kind: 'continuous', identity },
        ...evidence,
      },
      { canonical: policyV3 },
    );

  test('keeps every v2 rule, outcome and waiver', () => {
    const shape = (rules: typeof policyV3.rules) =>
      rules.map(({ code, outcome, waivable }) => [code, outcome, waivable]);

    expect(shape(policyV3.rules)).toEqual(shape(policyV2.rules));
  });

  test('decides like v2 when no version was removed, within 90 days', () => {
    for (const evidence of [{}, ...Object.values(firesEachRule)]) {
      const v2 = run(evidence, { canonical: policyV2 });

      expect([v3(evidence).outcome, codes(v3(evidence))]).toEqual([
        v2.outcome,
        codes(v2),
      ]);
    }
  });

  test('a removed version makes neither the publisher nor earlier provenance unknown', () => {
    expect(
      decideV3({
        provenance: { kind: 'absent' },
        earlierProvenance: 'unknown',
        earlierProvenanceExcludingRemoved: 'none',
        publisher: {
          kind: 'unknown',
          reason: 'an earlier version was removed',
        },
      }),
    ).toMatchObject({ outcome: 'ACCEPT', reasons: [] });
  });

  test('an account that joined recently is found past a removed version', () => {
    expect(
      codes(
        decideV3({
          publisher: {
            kind: 'unknown',
            reason: 'an earlier version was removed',
          },
          publisherExcludingRemoved: {
            kind: 'continuous',
            identity: account,
            joinedAt: hours(24 * 33),
          },
        }),
      ),
    ).toEqual(['publisher_recent']);
  });

  test('unknown history without removed versions still quarantines', () => {
    expect(
      codes(
        decideV3({
          provenance: { kind: 'absent' },
          earlierProvenance: 'none',
          earlierProvenanceExcludingRemoved: 'unknown',
          publisherExcludingRemoved: { kind: 'unknown', reason: 'unreadable' },
        }),
      ),
    ).toEqual(['provenance_history_unknown', 'publisher_unknown']);
  });

  test('a move from accounts to a workflow in the declared repository is not a publisher change', () => {
    expect(decideV3(changed('matched')).outcome).toBe('ACCEPT');
    expect(codes(decideV3(changed('mismatched')))).toEqual([
      'publisher_changed',
    ]);
    expect(codes(decideV3(changed('unchecked')))).toEqual([
      'publisher_changed',
    ]);
  });

  test('the repository check excuses only a first move from accounts to a workflow', () => {
    expect(codes(decideV3(changed('matched', [account, identity])))).toEqual([
      'publisher_changed',
    ]);
    expect(codes(decideV3(changed('matched', [identity])))).toEqual([
      'publisher_changed',
    ]);
    expect(
      codes(
        decideV3(
          changed('matched', [account], { kind: 'account', name: 'other' }),
        ),
      ),
    ).toEqual(['publisher_changed']);
  });

  test('identity rules stop firing 90 days after publish', () => {
    const recent = {
      publisherExcludingRemoved: {
        kind: 'continuous',
        identity: account,
        joinedAt: hours(24 * 90 + 24),
      },
    } as const;
    const downgrade = { provenance: { kind: 'absent' } } as const;

    for (const [code, evidence] of [
      ['publisher_changed', changed('unchecked')],
      ['publisher_recent', recent],
      ['trust_downgrade', downgrade],
    ] as const) {
      const at = (days: number) =>
        codes(
          decideV3({
            ...evidence,
            ...aged(days),
            ...(code === 'publisher_recent'
              ? {
                  publisherExcludingRemoved: {
                    ...recent.publisherExcludingRemoved,
                    joinedAt: hours(24 * days + 24),
                  },
                }
              : {}),
          }),
        );

      expect({ code, before: at(89.999), after: at(90) }).toEqual({
        code,
        before: [code],
        after: [],
      });
    }
  });

  test('without a publish time the identity rules keep firing', () => {
    const unknownTime = {
      publishTime: { kind: 'unknown', reason: 'missing' },
    } as const;
    const fired = (decision: ReturnType<typeof decide>) =>
      decision.reasons.map((reason) => [reason.kind, reason.code]).toSorted();

    expect(
      fired(decideV3({ ...changed('unchecked'), ...unknownTime })),
    ).toEqual([
      ['fired', 'publish_time_unknown'],
      ['fired', 'publisher_changed'],
    ]);
    expect(
      fired(decideV3({ provenance: { kind: 'absent' }, ...unknownTime })),
    ).toEqual([
      ['fired', 'publish_time_unknown'],
      ['fired', 'trust_downgrade'],
    ]);
  });

  test('a trust downgrade still counts versions npm removed', () => {
    expect(
      codes(
        decideV3({
          provenance: { kind: 'absent' },
          earlierProvenance: 'some',
          earlierProvenanceExcludingRemoved: 'none',
        }),
      ),
    ).toEqual(['trust_downgrade']);
  });

  test('evidence recorded before v3 fields existed never accepts', () => {
    const decision = run({}, { canonical: policyV3 });

    expect(decision.outcome).toBe('QUARANTINE');
    expect(decision.reasons.every((reason) => reason.kind === 'failed')).toBe(
      true,
    );
  });
});

describe('SupplyChainPolicy/v4', () => {
  const decodeRules = Schema.decodeUnknownSync(
    Schema.fromJsonString(
      Schema.Struct({
        rules: Schema.Array(
          Schema.Struct({ code: Schema.String, when: Schema.String }),
        ),
      }),
    ),
  );
  const v3Fields = {
    earlierProvenanceExcludingRemoved: clean.earlierProvenance,
    publisherExcludingRemoved: { kind: 'continuous', identity },
  } as const;
  const decideV4 = (evidence: Partial<PackageVersionEvidence>) =>
    run(
      { ...v3Fields, newDependencies: { kind: 'none' }, ...evidence },
      { canonical: policyV4 },
    );
  const publishedAt = hours(24 * 30);
  const dependency = (
    firstPublish: FirstPublish,
  ): Partial<PackageVersionEvidence> => ({
    newDependencies: {
      kind: 'added',
      added: [{ name: 'dep', spec: '^1.0.0', firstPublish }],
    },
  });
  const firstPublishedBefore = (hoursBefore: number) =>
    dependency({
      kind: 'packument',
      at: new Date(publishedAt.getTime() - hoursBefore * 3_600_000),
    });

  test('is v3 plus a waivable young-dependency rule and an unknown-dependencies rule', () => {
    const shape = (rules: typeof policyV4.rules) =>
      rules.map(({ code, outcome, waivable }) => [code, outcome, waivable]);

    expect(shape(policyV4.rules)).toEqual([
      ...shape(policyV3.rules).filter(
        ([code]) => code !== 'integrity_mismatch',
      ),
      ['new_dependency_young', 'QUARANTINE', true],
      ['new_dependencies_unknown', 'QUARANTINE', false],
      ['integrity_mismatch', 'REJECT', false],
    ]);
    const rulesOf = (bytes: Uint8Array) =>
      decodeRules(new TextDecoder().decode(bytes)).rules;

    expect(
      rulesOf(supplyChainPolicyV4.bytes()).filter(
        (rule) => !rule.code.startsWith('new_dependenc'),
      ),
    ).toEqual([...rulesOf(supplyChainPolicyV3.bytes())]);
  });

  test('decides like v3 when a version adds no dependency', () => {
    for (const evidence of [{}, ...Object.values(firesEachRule)]) {
      const v3 = run({ ...v3Fields, ...evidence }, { canonical: policyV3 });

      expect([decideV4(evidence).outcome, codes(decideV4(evidence))]).toEqual([
        v3.outcome,
        codes(v3),
      ]);
    }
  });

  test('a dependency whose package was first published less than 30 days before this version quarantines', () => {
    expect(codes(decideV4(firstPublishedBefore(719.99)))).toEqual([
      'new_dependency_young',
    ]);
    expect(codes(decideV4(firstPublishedBefore(720)))).toEqual([]);
    expect(codes(decideV4(firstPublishedBefore(-1)))).toEqual([
      'new_dependency_young',
    ]);
  });

  test('one young dependency among older ones is enough', () => {
    expect(
      codes(
        decideV4({
          newDependencies: {
            kind: 'added',
            added: [
              {
                name: 'old',
                spec: '^1',
                firstPublish: { kind: 'packument', at: hours(24 * 3650) },
              },
              {
                name: 'young',
                spec: '^1',
                firstPublish: { kind: 'packument', at: hours(24 * 31) },
              },
            ],
          },
        }),
      ),
    ).toEqual(['new_dependency_young']);
  });

  test('the young-dependency rule stops firing 90 days after publish', () => {
    const at = (days: number) =>
      codes(
        decideV4({
          publishTime: { kind: 'packument', at: hours(24 * days) },
          ...dependency({ kind: 'packument', at: hours(24 * days + 1) }),
        }),
      );

    expect({ before: at(89.999), after: at(90) }).toEqual({
      before: ['new_dependency_young'],
      after: [],
    });
  });

  test('an unknown dependency list or first publish quarantines, past 90 days too, and no waiver clears it', () => {
    const old = {
      publishTime: { kind: 'packument', at: hours(24 * 365) },
    } as const;
    const waiver = {
      policy: 'SupplyChainPolicy/v4',
      package: 'lib',
      version: '1.2.0',
      integrity,
      rule: 'new_dependencies_unknown',
      reason: 'try',
      author: 'probe@example.com',
      expiresAt: '2027-01-01T00:00:00Z',
    };

    for (const evidence of [
      { newDependencies: { kind: 'unknown', reason: 'unreadable' } } as const,
      dependency({ kind: 'unknown', reason: 'no packument recorded' }),
    ]) {
      const decision = run(
        { ...v3Fields, ...old, ...evidence },
        { canonical: policyV4, waivers: [waiver] },
      );

      expect([decision.outcome, codes(decision)]).toEqual([
        'QUARANTINE',
        ['new_dependencies_unknown'],
      ]);
    }
  });

  test('a new git, URL or file dependency is left to exotic_source on its own lockfile node', () => {
    expect(decideV4(dependency({ kind: 'exotic' })).outcome).toBe('ACCEPT');
  });

  test('evidence recorded before newDependencies existed never accepts, even long after publish', () => {
    for (const age of [24 * 30, 24 * 365]) {
      const decision = run(
        { ...v3Fields, publishTime: { kind: 'packument', at: hours(age) } },
        { canonical: policyV4 },
      );

      expect(decision.outcome).toBe('QUARANTINE');
      expect(decision.reasons.every((reason) => reason.kind === 'failed')).toBe(
        true,
      );
      expect(decision.reasons.map((reason) => reason.code)).toContain(
        'new_dependencies_unknown',
      );
    }
  });
});

test('clean evidence outside the window is accepted', () => {
  expect(run({})).toMatchObject({ outcome: 'ACCEPT', reasons: [] });
});

test('the window is 72 hours from the upstream publish time', () => {
  expect(
    codes(run({ publishTime: { kind: 'packument', at: hours(71.99) } })),
  ).toEqual(['release_age']);
  expect(
    run({ publishTime: { kind: 'packument', at: hours(72) } }).outcome,
  ).toBe('ACCEPT');
  expect(
    codes(run({ publishTime: { kind: 'packument', at: hours(-1) } })),
  ).toEqual(['release_age']);
});

test('an account that joined within 30 days of the publish stays quarantined', () => {
  const joined = (publishedDaysAgo: number, joinedDaysAgo: number) =>
    run({
      publishTime: { kind: 'packument', at: hours(24 * publishedDaysAgo) },
      publisher: {
        kind: 'continuous',
        identity: { kind: 'account', name: 'newcomer' },
        joinedAt: hours(24 * joinedDaysAgo),
      },
    });

  expect(codes(joined(70, 74))).toEqual(['publisher_recent']);
  expect(joined(70, 100).outcome).toBe('ACCEPT');
  expect(
    run({
      publisher: { kind: 'continuous', identity, joinedAt: hours(24 * 31) },
    }).outcome,
  ).toBe('ACCEPT');
});

describe('exotic sources', () => {
  const spec = `git+ssh://git@github.com/acme/lib.git#${commit}`;
  const git = { source: { kind: 'git', spec, integrity: null } } as const;
  const url = {
    source: { kind: 'url', spec: 'https://acme.dev/lib.tgz', integrity },
  } as const;

  test('fail unless the name and pinned spec are allowlisted', () => {
    expect(run(git).outcome).toBe('REJECT');
    expect(
      run(git, { allowedSources: [{ kind: 'git', name: 'other', spec }] })
        .outcome,
    ).toBe('REJECT');
    expect(
      run(git, { allowedSources: [{ kind: 'git', name: 'lib', spec }] })
        .outcome,
    ).toBe('ACCEPT');
  });

  test('a tarball URL must match the allowlisted integrity', () => {
    const entry = { kind: 'url', name: 'lib', spec: url.source.spec };

    expect(
      run(url, { allowedSources: [{ ...entry, integrity }] }).outcome,
    ).toBe('ACCEPT');
    expect(
      run(url, { allowedSources: [{ ...entry, integrity: otherIntegrity }] })
        .outcome,
    ).toBe('REJECT');
    expect(
      run(
        { source: { ...url.source, integrity: null } },
        { allowedSources: [{ ...entry, integrity }] },
      ).outcome,
    ).toBe('REJECT');
  });

  test('allowlist entries must pin immutable content', () => {
    for (const entry of [
      { kind: 'git', name: 'lib', spec: 'github:acme/lib#main' },
      { kind: 'git', name: 'lib', spec: 'github:acme/lib#a1b2c3d' },
      { kind: 'url', name: 'lib', spec: 'https://acme.dev/lib.tgz' },
      { kind: 'file', name: 'lib', spec: 'file:../outside' },
      { kind: 'file', name: 'lib', spec: '/abs/path' },
      { kind: 'file', name: 'lib', spec: 'file:./../outside' },
      { kind: 'file', name: 'lib', spec: '..\\outside' },
      { kind: 'file', name: 'lib', spec: '~/lib' },
      { kind: 'file', name: 'lib', spec: 'C:/lib' },
    ]) {
      expect(() => decodeAllowedSource(entry)).toThrow();
    }

    expect(
      decodeAllowedSource({
        kind: 'file',
        name: 'lib',
        spec: 'file:vendor/lib',
      }),
    ).toMatchObject({ kind: 'file' });
    expect(
      decodeAllowedSource({ kind: 'file', name: 'lib', spec: './vendor/lib' }),
    ).toMatchObject({ kind: 'file' });
  });
});

describe('waivers', () => {
  const changed = {
    publisher: {
      kind: 'changed',
      identity,
      earlier: [{ kind: 'account', name: 'someone' }],
    },
  } as const;
  const waiver = {
    policy: 'SupplyChainPolicy/v1',
    package: 'lib',
    version: '1.2.0',
    integrity,
    rule: 'publisher_changed',
    reason: 'maintainer added a second trusted-publisher workflow',
    author: 'reviewer@acme.dev',
    expiresAt: '2026-06-08T00:00:00Z',
  };

  test('clear a waivable quarantine for that exact artifact', () => {
    const decision = run(changed, { waivers: [waiver] });

    expect(decision.outcome).toBe('ACCEPT');
    expect(decision.reasons).toMatchObject([
      { kind: 'waived', code: 'publisher_changed' },
    ]);
  });

  test('do not apply after expiry, to other bytes or to unknown bytes', () => {
    expect(
      run(changed, {
        waivers: [{ ...waiver, expiresAt: '2026-06-01T00:00:00Z' }],
      }).outcome,
    ).toBe('QUARANTINE');
    expect(
      run(changed, { waivers: [{ ...waiver, integrity: otherIntegrity }] })
        .outcome,
    ).toBe('QUARANTINE');
    expect(
      run(
        { ...changed, source: { ...clean.source, integrity: null } },
        { waivers: [waiver] },
      ).outcome,
    ).toBe('QUARANTINE');
  });

  test('clear only the rule of the policy they name', () => {
    const org = orgPolicy([
      {
        code: 'publisher_changed',
        outcome: 'QUARANTINE',
        when: "evidence.publisher.kind == 'changed'",
        waivable: true,
      },
    ]);
    const decision = run(changed, { org, waivers: [waiver] });

    expect(decision.outcome).toBe('QUARANTINE');
    expect(decision.reasons.map((r) => [r.kind, r.policy.id])).toEqual([
      ['waived', 'SupplyChainPolicy/v1'],
      ['fired', 'org/acme'],
    ]);
  });

  test('must expire on a real date', () => {
    expect(() =>
      decodeWaiver({ ...waiver, expiresAt: '2026-02-30T00:00:00Z' }),
    ).toThrow();
  });

  test('cannot clear a rule the policy does not mark waivable', () => {
    const young = { publishTime: { kind: 'packument', at: hours(1) } } as const;

    expect(
      run(young, { waivers: [{ ...waiver, rule: 'release_age' }] }).outcome,
    ).toBe('QUARANTINE');
  });

  test('only signals a reviewer can check are waivable in v1', () => {
    expect(
      policy.rules.filter((rule) => rule.waivable).map((rule) => rule.code),
    ).toEqual([
      'trust_downgrade',
      'publisher_changed',
      'publisher_recent',
      'new_install_script',
    ]);
  });

  test('a waivable REJECT rule fails to load', () => {
    expect(() =>
      orgPolicy([
        { code: 'nope', outcome: 'REJECT', when: 'false', waivable: true },
      ]),
    ).toThrow(/nope/);
  });
});

describe('probabilistic claims', () => {
  const claims = [{ kind: 'malware', source: 'model', probability: 0.9 }];

  test('are ignored by v1, which sets no threshold', () => {
    expect(run({ claims }).outcome).toBe('ACCEPT');
  });

  test('can quarantine through an org rule with its own threshold', () => {
    const org = orgPolicy([
      {
        code: 'model_review',
        outcome: 'QUARANTINE',
        when: 'claims.exists(c, c.probability >= 0.85)',
      },
    ]);

    expect(run({ claims }, { org }).outcome).toBe('QUARANTINE');
  });

  test('a REJECT rule that reads claims fails to load', () => {
    expect(() =>
      orgPolicy([
        { code: 'model_says_no', outcome: 'REJECT', when: 'size(claims) > 0' },
      ]),
    ).toThrow(/model_says_no/);
  });
});

describe('org rules', () => {
  test('the stricter outcome wins', () => {
    const org = orgPolicy([
      {
        code: 'no_scripts',
        outcome: 'REJECT',
        when: "evidence.installScripts.kind != 'none'",
      },
    ]);
    const decision = run(
      { installScripts: { kind: 'new', added: [script] } },
      { org },
    );

    expect(decision.outcome).toBe('REJECT');
    expect(decision.reasons.map((r) => [r.policy.id, r.code])).toEqual([
      ['SupplyChainPolicy/v1', 'new_install_script'],
      ['org/acme', 'no_scripts'],
    ]);
  });

  test('cannot loosen a canonical outcome', () => {
    const org = orgPolicy([
      { code: 'never', outcome: 'QUARANTINE', when: 'false' },
    ]);

    expect(
      run(
        { feeds: { kind: 'checked', hits: [{ feed: 'osv', id: 'MAL-0' }] } },
        { org },
      ).outcome,
    ).toBe('REJECT');
  });

  test('a failing rule counts at its own outcome, tagged failed', () => {
    const failing = (outcome: string) =>
      orgPolicy([
        {
          code: 'too_old',
          outcome,
          when: "now - evidence.publishTime.at > duration('8760h')",
        },
      ]);
    const unknownTime = {
      publishTime: { kind: 'unknown', reason: 'missing' },
    } as const;

    for (const outcome of ['QUARANTINE', 'REJECT'] as const) {
      const decision = run(unknownTime, { org: failing(outcome) });

      expect(decision.outcome).toBe(outcome);
      expect(decision.reasons.find((r) => r.code === 'too_old')).toMatchObject({
        kind: 'failed',
        outcome,
      });
    }
  });

  test('a claims rule that fails cannot reject', () => {
    const org = orgPolicy([
      {
        code: 'model_review',
        outcome: 'QUARANTINE',
        when: 'claims.exists(c, int(c.probability * 1e19) > 0)',
      },
    ]);
    const claims = [{ kind: 'malware', source: 'model', probability: 0.99 }];

    expect(run({ claims }, { org }).outcome).toBe('QUARANTINE');
  });
});

describe('loading', () => {
  test('a policy whose bytes do not match the pinned digest is refused', () => {
    const bytes = supplyChainPolicyV1.bytes();
    const edited = new TextEncoder().encode(
      new TextDecoder().decode(bytes).replace('72h', '24h'),
    );

    expect(() => loadPolicy(edited, supplyChainPolicyV1.digest)).toThrow(
      /digest/,
    );
  });

  test('a rule that is not boolean fails to load', () => {
    expect(() =>
      orgPolicy([{ code: 'age', outcome: 'QUARANTINE', when: 'now' }]),
    ).toThrow(/age/);
  });

  test('duplicate rule codes fail to load', () => {
    const rule = { code: 'twice', outcome: 'QUARANTINE', when: 'false' };

    expect(() => orgPolicy([rule, rule])).toThrow(/twice/);
  });
});
