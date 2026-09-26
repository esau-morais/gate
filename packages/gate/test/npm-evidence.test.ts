import { describe, expect, test } from 'bun:test';
import { Schema } from 'effect';
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
    provenance: 'absent',
    npmUser: 'maintainer',
    scripts: {},
    ...overrides,
  });
}

const release = {
  repository: 'github.com/acme/lib',
  workflow: '.github/workflows/release.yml',
};
const canary = {
  repository: 'github.com/acme/lib',
  workflow: '.github/workflows/canary.yml',
};

function evidenceFor(
  target: NpmVersionFacts,
  earlier: readonly NpmVersionFacts[],
) {
  return npmVersionEvidence({
    name: 'lib',
    registry: 'https://registry.npmjs.org',
    target,
    earlier,
    feeds: { kind: 'checked', hits: [] },
    claims: [],
  });
}

describe('publisher continuity', () => {
  test('alternating between two trusted-publisher workflows stays continuous', () => {
    const earlier = [
      facts('1.0.0', '2026-01-01T00:00:00Z', { provenance: release }),
      facts('1.1.0-canary.0', '2026-01-08T00:00:00Z', { provenance: canary }),
      facts('1.1.0', '2026-01-15T00:00:00Z', { provenance: release }),
    ];
    const evidence = evidenceFor(
      facts('1.2.0-canary.0', '2026-01-22T00:00:00Z', { provenance: canary }),
      earlier,
    );

    expect(evidence.publisher.kind).toBe('continuous');
  });

  test('a workflow never seen before is a change', () => {
    const evidence = evidenceFor(
      facts('1.2.0', '2026-01-22T00:00:00Z', {
        provenance: { ...release, workflow: '.github/workflows/other.yml' },
      }),
      [facts('1.1.0', '2026-01-15T00:00:00Z', { provenance: release })],
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
        provenance: release,
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
  test('unknown provenance is unavailable, not absent', () => {
    const evidence = evidenceFor(
      facts('1.2.0', '2026-01-22T00:00:00Z', { provenance: 'unknown' }),
      [],
    );

    expect(evidence.provenance.kind).toBe('unavailable');
  });

  test('earlier provenance is unknown when history is partly unreadable', () => {
    const evidence = evidenceFor(facts('1.2.0', '2026-01-22T00:00:00Z'), [
      facts('1.1.0', '2026-01-15T00:00:00Z', { provenance: 'unknown' }),
    ]);

    expect(evidence.earlierProvenance).toBe('unknown');
  });
});

test('versions published after the target are not history', () => {
  expect(() =>
    evidenceFor(facts('1.2.0', '2026-01-22T00:00:00Z'), [
      facts('2.0.0', '2026-01-29T00:00:00Z'),
    ]),
  ).toThrow(/not published before/);
});
