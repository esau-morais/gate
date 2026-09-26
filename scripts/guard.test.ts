import { describe, expect, test } from 'bun:test';
import { guardViolations, type Tree } from './guard';

function tree(files: Record<string, string | undefined>): Tree {
  const present = Object.entries(files).flatMap(([path, text]) =>
    text === undefined ? [] : [[path, text] as const],
  );
  const map = new Map(present);

  return {
    read: (path) => map.get(path),
    list: (dir) => [
      ...new Set(
        [...map.keys()]
          .filter((path) => path.startsWith(`${dir}/`))
          .map((path) => path.slice(dir.length + 1).split('/')[0] ?? ''),
      ),
    ],
  };
}

const json = (value: unknown) => JSON.stringify(value);

function expectViolation(violations: string[], text: string) {
  expect(violations).toHaveLength(1);
  expect(violations[0]).toContain(text);
}

const digest = `sha256:${'a'.repeat(64)}`;
const fixturePath = 'packages/gate/test/replay/fixtures/incident.json';
const fixture = (evaluations: unknown[], miss?: string) =>
  json({ ...(miss === undefined ? {} : { miss }), evaluations });
const quarantineAt = (at: string) => ({
  at,
  moment: 'first public report',
  expected: { outcome: 'QUARANTINE', reasons: ['release_age'] },
});

const base = {
  'bunfig.toml': '[install]\nexact = true\nminimumReleaseAge = 259200\n',
  'package.json': json({ devDependencies: { typescript: '5.9.3' } }),
  'packages/cel/package.json': json({
    devDependencies: { '@bufbuild/cel-spec': '0.6.1' },
  }),
  'packages/gate/package.json': json({
    dependencies: { '@gate/cel': 'workspace:*', effect: '4.0.0-rc.117' },
  }),
  'packages/gate/policies/supply-chain-policy-v1.json': '{"rules":[]}\n',
  'packages/gate/src/policies.ts': `PolicyDigest.make('${digest}');\n`,
  'packages/cel/test/conformance-known-failures.json': json({
    'basic/a': 'fail',
  }),
  [fixturePath]: fixture([quarantineAt('2026-05-11T19:46:46Z')]),
  'docs/REVIEW.md': 'Use Effect v4 (`effect`).\n',
};

function check(changes: Record<string, string | undefined>) {
  return guardViolations({
    base: tree(base),
    head: tree({ ...base, ...changes }),
  });
}

test('an unchanged tree has no violations', () => {
  expect(check({})).toEqual([]);
});

describe('policies', () => {
  test('flags an edited published policy', () => {
    expectViolation(
      check({
        'packages/gate/policies/supply-chain-policy-v1.json': '{"rules":[1]}\n',
      }),
      'supply-chain-policy-v1.json',
    );
  });

  test('flags a deleted published policy', () => {
    expect(
      check({
        'packages/gate/policies/supply-chain-policy-v1.json': undefined,
      }),
    ).toHaveLength(1);
  });

  test('allows a new policy version', () => {
    expect(
      check({ 'packages/gate/policies/supply-chain-policy-v2.json': '{}' }),
    ).toEqual([]);
  });

  test('flags a removed pinned digest', () => {
    expectViolation(
      check({
        'packages/gate/src/policies.ts': `PolicyDigest.make('sha256:${'b'.repeat(64)}');\n`,
      }),
      digest,
    );
  });
});

describe('conformance known failures', () => {
  const added = json({ 'basic/a': 'fail', 'basic/b': 'fail' });

  test('flags a new entry', () => {
    expectViolation(
      check({ 'packages/cel/test/conformance-known-failures.json': added }),
      'basic/b',
    );
  });

  test('allows removing an entry that now passes', () => {
    expect(
      check({ 'packages/cel/test/conformance-known-failures.json': json({}) }),
    ).toEqual([]);
  });

  test('allows new entries when the cel-spec suite version changes', () => {
    expect(
      check({
        'packages/cel/test/conformance-known-failures.json': added,
        'packages/cel/package.json': json({
          devDependencies: { '@bufbuild/cel-spec': '0.7.0' },
        }),
      }),
    ).toEqual([]);
  });
});

describe('replay fixtures', () => {
  test('flags a weaker expected outcome', () => {
    expectViolation(
      check({
        [fixturePath]: fixture([
          {
            ...quarantineAt('2026-05-11T19:46:46Z'),
            expected: { outcome: 'ACCEPT', reasons: [] },
          },
        ]),
      }),
      'QUARANTINE to ACCEPT',
    );
  });

  test('allows a stricter expected outcome', () => {
    expect(
      check({
        [fixturePath]: fixture([
          {
            ...quarantineAt('2026-05-11T19:46:46Z'),
            expected: { outcome: 'REJECT', reasons: ['feed_hit'] },
          },
        ]),
      }),
    ).toEqual([]);
  });

  test('flags a removed evaluation', () => {
    expectViolation(
      check({ [fixturePath]: fixture([quarantineAt('2026-05-11T20:00:00Z')]) }),
      '2026-05-11T19:46:46Z',
    );
  });

  test('flags a deleted fixture', () => {
    expect(check({ [fixturePath]: undefined })).toHaveLength(1);
  });

  test('flags a miss added to a caught incident', () => {
    expectViolation(
      check({
        [fixturePath]: fixture(
          [quarantineAt('2026-05-11T19:46:46Z')],
          'not caught',
        ),
      }),
      'miss',
    );
  });

  test('flags an unreadable fixture instead of skipping it', () => {
    expect(check({ [fixturePath]: '{' })).toHaveLength(1);
  });
});

describe('install settings', () => {
  test('flags a shorter release age', () => {
    expectViolation(
      check({
        'bunfig.toml': '[install]\nexact = true\nminimumReleaseAge = 3600\n',
      }),
      'minimumReleaseAge',
    );
  });

  test('flags a missing release age', () => {
    expect(check({ 'bunfig.toml': '[install]\nexact = true\n' })).toHaveLength(
      1,
    );
  });

  test('flags release age exclusions', () => {
    expectViolation(
      check({
        'bunfig.toml':
          '[install]\nexact = true\nminimumReleaseAge = 259200\nminimumReleaseAgeExcludes = ["effect"]\n',
      }),
      'minimumReleaseAgeExcludes',
    );
  });

  test('flags trusted dependencies', () => {
    expectViolation(
      check({
        'package.json': json({
          devDependencies: { typescript: '5.9.3' },
          trustedDependencies: ['esbuild'],
        }),
      }),
      'trustedDependencies',
    );
  });

  test.each(['^5.9.3', '~5.9.3', 'latest', 'github:microsoft/TypeScript'])(
    'flags the unpinned spec %s',
    (spec) => {
      expectViolation(
        check({
          'package.json': json({ devDependencies: { typescript: spec } }),
        }),
        'typescript',
      );
    },
  );
});

describe('runtime dependencies', () => {
  test('flags a new dependency with no recorded reason', () => {
    expectViolation(
      check({
        'packages/gate/package.json': json({
          dependencies: {
            '@gate/cel': 'workspace:*',
            effect: '4.0.0-rc.117',
            'left-pad': '1.3.0',
          },
        }),
      }),
      'left-pad',
    );
  });

  test('allows a new dependency named in docs/REVIEW.md', () => {
    expect(
      check({
        'packages/gate/package.json': json({
          dependencies: {
            '@gate/cel': 'workspace:*',
            effect: '4.0.0-rc.117',
            'left-pad': '1.3.0',
          },
        }),
        'docs/REVIEW.md': 'Use Effect v4 (`effect`). `left-pad` because…\n',
      }),
    ).toEqual([]);
  });
});
