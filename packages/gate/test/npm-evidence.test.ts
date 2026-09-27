import { describe, expect, test } from 'bun:test';
import { Schema } from 'effect';
import { Sha512Integrity } from '../src/evidence';
import { NpmVersionFacts } from '../src/npm/facts';
import { npmVersionEvidence } from '../src/npm/evidence';

const decodeFacts = Schema.decodeUnknownSync(NpmVersionFacts);

function facts(
  version: string,
  time: string,
  overrides: Record<string, unknown> = {},
): NpmVersionFacts {
  return decodeFacts({
    version,
    time,
    integrity: null,
    provenance: { kind: 'absent' },
    npmUser: 'maintainer',
    scripts: {},
    ...overrides,
  });
}

const release = {
  repository: 'github.com/acme/lib',
  workflow: '.github/workflows/release.yml',
};
const verified = (identity: { repository: string; workflow: string }) => ({
  kind: 'verified' as const,
  ...identity,
});
const canary = {
  repository: 'github.com/acme/lib',
  workflow: '.github/workflows/canary.yml',
};

function evidenceFor(
  target: NpmVersionFacts,
  earlier: readonly NpmVersionFacts[],
  lockfile?: { integrity: Sha512Integrity | null },
) {
  return npmVersionEvidence({
    name: 'lib',
    registry: 'https://registry.npmjs.org',
    target,
    earlier,
    feeds: { kind: 'checked', hits: [] },
    claims: [],
    ...(lockfile === undefined ? {} : { lockfile }),
  });
}

describe('publisher continuity', () => {
  test('alternating between two trusted-publisher workflows stays continuous', () => {
    const earlier = [
      facts('1.0.0', '2026-01-01T00:00:00Z', { provenance: verified(release) }),
      facts('1.1.0-canary.0', '2026-01-08T00:00:00Z', {
        provenance: verified(canary),
      }),
      facts('1.1.0', '2026-01-15T00:00:00Z', { provenance: verified(release) }),
    ];
    const evidence = evidenceFor(
      facts('1.2.0-canary.0', '2026-01-22T00:00:00Z', {
        provenance: verified(canary),
      }),
      earlier,
    );

    expect(evidence.publisher.kind).toBe('continuous');
  });

  test('a workflow never seen before is a change', () => {
    const evidence = evidenceFor(
      facts('1.2.0', '2026-01-22T00:00:00Z', {
        provenance: verified({
          ...release,
          workflow: '.github/workflows/other.yml',
        }),
      }),
      [
        facts('1.1.0', '2026-01-15T00:00:00Z', {
          provenance: verified(release),
        }),
      ],
    );

    expect(evidence.publisher).toEqual({
      kind: 'changed',
      identity: {
        kind: 'workflow',
        ...release,
        workflow: '.github/workflows/other.yml',
      },
      earlier: [{ kind: 'workflow', ...release }],
    });
  });

  test('adopting provenance on an established package is a change', () => {
    const evidence = evidenceFor(
      facts('1.2.0', '2026-01-22T00:00:00Z', {
        provenance: verified(release),
        npmUser: 'GitHub Actions',
      }),
      [
        facts('1.0.0', '2026-01-08T00:00:00Z'),
        facts('1.1.0', '2026-01-15T00:00:00Z'),
      ],
    );

    expect(evidence.publisher).toMatchObject({
      kind: 'changed',
      earlier: [{ kind: 'account', name: 'maintainer' }],
    });
    expect(evidence.earlierProvenance).toBe('none');
  });

  test('a first publish has no baseline', () => {
    expect(
      evidenceFor(facts('1.0.0', '2026-01-22T00:00:00Z'), []).publisher.kind,
    ).toBe('first');
  });

  test('releases younger than the 72h window do not vouch for the next one', () => {
    const burst = ['1.1.1', '1.1.2', '1.1.3'].map((version, i) =>
      facts(version, `2026-01-21T0${i}:00:00Z`, { npmUser: 'intruder' }),
    );
    const evidence = evidenceFor(
      facts('1.1.4', '2026-01-22T00:00:00Z', { npmUser: 'intruder' }),
      [facts('1.1.0', '2026-01-15T00:00:00Z'), ...burst],
    );

    expect(evidence.publisher).toMatchObject({ kind: 'changed' });
  });

  test('an unreadable earlier identity makes an unmatched publisher unknown', () => {
    const evidence = evidenceFor(
      facts('1.2.0', '2026-01-22T00:00:00Z', { npmUser: 'stranger' }),
      [facts('1.1.0', '2026-01-15T00:00:00Z', { npmUser: null })],
    );

    expect(evidence.publisher.kind).toBe('unknown');
  });
});

describe('publisher tenure', () => {
  const founder = (version: string, time: string) =>
    facts(version, time, { npmUser: 'founder' });

  test('an account that took over an established package records when it joined', () => {
    const evidence = evidenceFor(
      facts('3.3.6', '2018-09-09T00:00:00Z', { npmUser: 'newcomer' }),
      [
        founder('3.3.3', '2016-06-18T00:00:00Z'),
        founder('3.3.4', '2016-07-17T00:00:00Z'),
        facts('3.3.5', '2018-09-05T00:00:00Z', { npmUser: 'newcomer' }),
      ],
    );

    expect(evidence.publisher).toEqual({
      kind: 'continuous',
      identity: { kind: 'account', name: 'newcomer' },
      joinedAt: new Date('2018-09-05T00:00:00Z'),
    });
  });

  test('the account that has published since the start of the history did not join', () => {
    const evidence = evidenceFor(founder('1.0.2', '2026-01-15T00:00:00Z'), [
      founder('1.0.0', '2026-01-01T00:00:00Z'),
      founder('1.0.1', '2026-01-08T00:00:00Z'),
    ]);

    expect(evidence.publisher).toEqual({
      kind: 'continuous',
      identity: { kind: 'account', name: 'founder' },
    });
  });
});

describe('install scripts', () => {
  test('a script identical to the previous version is unchanged', () => {
    const scripts = { postinstall: 'node-gyp rebuild', test: 'bun test' };
    const evidence = evidenceFor(
      facts('1.2.0', '2026-01-22T00:00:00Z', { scripts }),
      [facts('1.1.0', '2026-01-15T00:00:00Z', { scripts })],
    );

    expect(evidence.installScripts).toEqual({
      kind: 'unchanged',
      scripts: [{ hook: 'postinstall', command: 'node-gyp rebuild' }],
    });
  });

  test('a changed command counts as new, compared with the latest earlier version', () => {
    const evidence = evidenceFor(
      facts('1.2.0', '2026-01-22T00:00:00Z', {
        scripts: { postinstall: 'node x.js' },
      }),
      [
        facts('1.1.0', '2026-01-15T00:00:00Z'),
        facts('1.0.1', '2026-01-08T00:00:00Z', {
          scripts: { postinstall: 'node x.js' },
        }),
      ],
    );

    expect(evidence.installScripts).toEqual({
      kind: 'new',
      added: [{ hook: 'postinstall', command: 'node x.js' }],
    });
  });

  test('a script first added by a still-unsettled release stays new', () => {
    const postinstall = { postinstall: 'node bundle.js' };
    const evidence = evidenceFor(
      facts('4.1.2', '2026-01-22T00:21:00Z', { scripts: postinstall }),
      [
        facts('4.1.0', '2026-01-15T00:00:00Z'),
        facts('4.1.1', '2026-01-22T00:00:00Z', { scripts: postinstall }),
      ],
    );

    expect(evidence.installScripts.kind).toBe('new');
  });

  test('unknown scripts on the previous version are not read as none', () => {
    const evidence = evidenceFor(
      facts('1.2.0', '2026-01-22T00:00:00Z', {
        scripts: { install: 'node x.js' },
      }),
      [facts('1.1.0', '2026-01-15T00:00:00Z', { scripts: 'unknown' })],
    );

    expect(evidence.installScripts.kind).toBe('unknown');
  });
});

describe('provenance', () => {
  const unreadable = { kind: 'unavailable', reason: 'provenance unreadable' };

  test('unknown provenance is unavailable, not absent', () => {
    const evidence = evidenceFor(
      facts('1.2.0', '2026-01-22T00:00:00Z', { provenance: unreadable }),
      [],
    );

    expect(evidence.provenance.kind).toBe('unavailable');
  });

  test('earlier provenance is unknown when history is partly unreadable', () => {
    const evidence = evidenceFor(facts('1.2.0', '2026-01-22T00:00:00Z'), [
      facts('1.1.0', '2026-01-15T00:00:00Z', { provenance: unreadable }),
    ]);

    expect(evidence.earlierProvenance).toBe('unknown');
  });

  test('failed verification keeps its reason and vouches for no publisher', () => {
    const failed = {
      kind: 'unavailable',
      reason: 'signed subject is not pkg:npm/lib@1.2.0',
    };
    const evidence = evidenceFor(
      facts('1.2.0', '2026-01-22T00:00:00Z', { provenance: failed }),
      [facts('1.1.0', '2026-01-01T00:00:00Z', { provenance: failed })],
    );

    expect(evidence).toMatchObject({
      provenance: failed,
      earlierProvenance: 'unknown',
      publisher: { kind: 'unknown' },
    });
  });
});

describe('removed versions', () => {
  const removed = (version: string, time: string) =>
    facts(version, time, {
      provenance: { kind: 'unavailable', reason: 'version document missing' },
      npmUser: null,
      scripts: 'unknown',
      removed: true,
    });

  test('a version npm removed does not make the history unknown', () => {
    const evidence = evidenceFor(
      facts('1.2.0', '2026-01-22T00:00:00Z', { npmUser: 'stranger' }),
      [
        facts('1.0.0', '2026-01-01T00:00:00Z'),
        removed('1.1.0', '2026-01-08T00:00:00Z'),
      ],
    );

    expect(evidence).toMatchObject({
      earlierProvenance: 'unknown',
      earlierProvenanceExcludingRemoved: 'none',
      publisher: { kind: 'unknown' },
      publisherExcludingRemoved: {
        kind: 'changed',
        identity: { kind: 'account', name: 'stranger' },
        earlier: [{ kind: 'account', name: 'maintainer' }],
      },
    });
  });

  test('a listed version whose document is unreadable still makes the history unknown', () => {
    const evidence = evidenceFor(
      facts('1.2.0', '2026-01-22T00:00:00Z', { npmUser: 'stranger' }),
      [
        facts('1.0.0', '2026-01-01T00:00:00Z'),
        facts('1.1.0', '2026-01-08T00:00:00Z', {
          provenance: {
            kind: 'unavailable',
            reason: 'version document unreadable',
          },
          npmUser: null,
          scripts: 'unknown',
        }),
      ],
    );

    expect([
      evidence.earlierProvenanceExcludingRemoved,
      evidence.publisherExcludingRemoved?.kind,
    ]).toEqual(['unknown', 'unknown']);
  });

  test('the history is unknown when every settled earlier version was removed', () => {
    const evidence = evidenceFor(
      facts('1.2.0', '2026-01-22T00:00:00Z', {
        provenance: { kind: 'absent' },
      }),
      [
        removed('1.0.0', '2026-01-01T00:00:00Z'),
        removed('1.1.0', '2026-01-08T00:00:00Z'),
      ],
    );

    expect([
      evidence.earlierProvenanceExcludingRemoved,
      evidence.publisherExcludingRemoved?.kind,
    ]).toEqual(['unknown', 'unknown']);
  });

  test('a first publish has no history to be unknown', () => {
    const evidence = evidenceFor(facts('1.0.0', '2026-01-22T00:00:00Z'), [
      removed('0.9.0', '2026-01-21T00:00:00Z'),
    ]);

    expect([
      evidence.earlierProvenanceExcludingRemoved,
      evidence.publisherExcludingRemoved?.kind,
    ]).toEqual(['none', 'first']);
  });
});

describe('repository check', () => {
  const workflow = {
    repository: 'https://github.com/acme/lib',
    workflow: '.github/workflows/release.yml',
  };
  const fromWorkflow = facts('1.2.0', '2026-01-22T00:00:00Z', {
    provenance: verified(workflow),
    npmUser: 'GitHub Actions',
  });
  const declaring = (...repositories: (string | undefined)[]) =>
    repositories.map((repository, i) =>
      facts(
        `1.${i}.0`,
        `2026-01-0${i + 1}T00:00:00Z`,
        repository === undefined ? {} : { repository },
      ),
    );
  const check = (
    earlier: readonly NpmVersionFacts[],
    target = fromWorkflow,
  ) => {
    const publisher = evidenceFor(target, earlier).publisherExcludingRemoved;

    return publisher?.kind === 'changed'
      ? publisher.repositoryCheck
      : publisher?.kind;
  };

  test('a move to a workflow in the repository every earlier version declares is matched', () => {
    expect(
      check(
        declaring(
          'git+https://github.com/acme/lib.git',
          undefined,
          'https://github.com/Acme/lib',
        ),
      ),
    ).toBe('matched');
  });

  test('npm shorthand, ssh and monorepo URLs name the same repository', () => {
    for (const repository of [
      'acme/lib',
      'github:acme/lib',
      'git@github.com:acme/lib.git',
      'git+ssh://git@github.com/acme/lib.git',
      'git://github.com/acme/lib.git',
      'https://github.com/acme/lib/tree/main/packages/lib',
      'https://github.com/acme/lib#readme',
    ]) {
      expect({ repository, check: check(declaring(repository)) }).toEqual({
        repository,
        check: 'matched',
      });
    }
  });

  test('one earlier version naming another repository is a mismatch', () => {
    expect(
      check(declaring('acme/lib', 'https://github.com/acme/lib-fork')),
    ).toBe('mismatched');
    expect(check(declaring('https://gitlab.com/acme/lib'))).toBe('mismatched');
  });

  test('without a readable declared repository for every earlier version that has one, it is unchecked', () => {
    expect(check(declaring(undefined, undefined))).toBe('unchecked');
    expect(check(declaring('acme/lib', 'unknown'))).toBe('unchecked');
    expect(check(declaring('acme/lib', 'not a repository'))).toBe('unchecked');
  });

  test('an account publisher is never checked', () => {
    expect(
      check(
        declaring('acme/lib'),
        facts('1.2.0', '2026-01-22T00:00:00Z', { npmUser: 'stranger' }),
      ),
    ).toBe('unchecked');
  });
});

describe('lockfile integrity', () => {
  const published = Sha512Integrity.make(`sha512-${'A'.repeat(86)}==`);
  const other = Sha512Integrity.make(`sha512-${'B'.repeat(86)}==`);
  const target = facts('1.2.0', '2026-01-22T00:00:00Z', {
    integrity: published,
  });
  const check = (lockfile?: { integrity: Sha512Integrity | null }) => {
    const { source, integrityCheck } = evidenceFor(target, [], lockfile);

    return { integrity: source.integrity, integrityCheck };
  };

  test('matching the packument ties the decision to those bytes', () => {
    expect(check({ integrity: published })).toEqual({
      integrity: published,
      integrityCheck: 'matched',
    });
  });

  test('a lockfile pinning other bytes is a mismatch on the bytes it installs', () => {
    expect(check({ integrity: other })).toEqual({
      integrity: other,
      integrityCheck: 'mismatched',
    });
  });

  test('when either side lacks a sha512 the bytes are unknown', () => {
    expect(check({ integrity: null })).toEqual({
      integrity: null,
      integrityCheck: 'unchecked',
    });

    const unpublished = evidenceFor(
      facts('1.2.0', '2026-01-22T00:00:00Z', { integrity: null }),
      [],
      { integrity: published },
    );

    expect([unpublished.source.integrity, unpublished.integrityCheck]).toEqual([
      null,
      'unchecked',
    ]);
  });

  test('without a lockfile the packument integrity stands unchecked', () => {
    expect(check()).toEqual({
      integrity: published,
      integrityCheck: 'unchecked',
    });
  });
});

test('versions published after the target are not history', () => {
  expect(() =>
    evidenceFor(facts('1.2.0', '2026-01-22T00:00:00Z'), [
      facts('2.0.0', '2026-01-29T00:00:00Z'),
    ]),
  ).toThrow(/not published before/);
});
