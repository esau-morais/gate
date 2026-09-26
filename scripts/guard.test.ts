import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  decodeReplayFixture,
  type ReplayFixture,
} from '../packages/gate/test/replay/fixture';
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
const fixturePath =
  'packages/gate/test/replay/fixtures/tanstack-2026-05-11.json';
const recorded = readFileSync(
  new URL(`../${fixturePath}`, import.meta.url),
  'utf8',
);
const recordedFixture = decodeReplayFixture(recorded);
const firstReport = '2026-05-11T19:46:46Z';

type Evaluation = ReplayFixture['evaluations'][number];

function editFirstReport(edit: (evaluation: Evaluation) => Evaluation) {
  return json({
    ...recordedFixture,
    evaluations: recordedFixture.evaluations.map((evaluation) =>
      evaluation.at.getTime() === Date.parse(firstReport)
        ? edit(evaluation)
        : evaluation,
    ),
  });
}

const base = {
  'bunfig.toml':
    '[install]\nauto = "disable"\nexact = true\nminimumReleaseAge = 259200\n',
  'package.json': json({ devDependencies: { typescript: '5.9.3' } }),
  'packages/cel/package.json': json({
    devDependencies: { '@bufbuild/cel-spec': '0.6.1' },
  }),
  'packages/gate/package.json': json({
    dependencies: { '@gate/cel': 'workspace:*', effect: '4.0.0-rc.117' },
  }),
  'packages/gate/policies/supply-chain-policy-v1.json': '{"rules":[]}\n',
  'packages/gate/src/policies.ts': `export const v1 = PolicyDigest.make(\n  '${digest}',\n);\n`,
  'packages/cel/test/conformance-known-failures.json': json({
    'basic/a': 'fail',
  }),
  [fixturePath]: recorded,
  'docs/REVIEW.md': 'Use Effect v4 (`effect`) with ms timestamps.\n',
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

  test('flags a replaced pinned digest', () => {
    expectViolation(
      check({
        'packages/gate/src/policies.ts': `export const v1 = PolicyDigest.make('sha256:${'b'.repeat(64)}');\n`,
      }),
      digest,
    );
  });

  test('flags a pinned digest kept only in a comment', () => {
    expectViolation(
      check({
        'packages/gate/src/policies.ts': `// was ${digest}\nexport const v1 = PolicyDigest.make('sha256:${'b'.repeat(64)}');\n`,
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

  test('flags a new entry even when the cel-spec suite version changes', () => {
    expectViolation(
      check({
        'packages/cel/test/conformance-known-failures.json': added,
        'packages/cel/package.json': json({
          devDependencies: { '@bufbuild/cel-spec': '0.7.0' },
        }),
      }),
      'basic/b',
    );
  });

  test('allows removing an entry that now passes', () => {
    expect(
      check({ 'packages/cel/test/conformance-known-failures.json': json({}) }),
    ).toEqual([]);
  });
});

describe('replay fixtures', () => {
  test('flags a weaker expected outcome', () => {
    expectViolation(
      check({
        [fixturePath]: editFirstReport((evaluation) => ({
          ...evaluation,
          expected: { outcome: 'ACCEPT', reasons: [] },
        })),
      }),
      'QUARANTINE to ACCEPT',
    );
  });

  test('flags a reason dropped at the same outcome', () => {
    expectViolation(
      check({
        [fixturePath]: editFirstReport((evaluation) => ({
          ...evaluation,
          expected: { outcome: 'QUARANTINE', reasons: ['release_age'] },
        })),
      }),
      'integrity_unknown',
    );
  });

  test('allows a stricter expected outcome', () => {
    expect(
      check({
        [fixturePath]: editFirstReport((evaluation) => ({
          ...evaluation,
          expected: { outcome: 'REJECT', reasons: ['feed_hit'] },
        })),
      }),
    ).toEqual([]);
  });

  test('flags a removed evaluation', () => {
    expectViolation(
      check({
        [fixturePath]: editFirstReport((evaluation) => ({
          ...evaluation,
          at: new Date('2026-05-11T20:00:00Z'),
        })),
      }),
      firstReport,
    );
  });

  test('flags a deleted fixture', () => {
    expect(check({ [fixturePath]: undefined })).toHaveLength(1);
  });

  test('flags a miss added to a caught incident', () => {
    expectViolation(
      check({
        [fixturePath]: json({ ...recordedFixture, miss: 'not caught' }),
      }),
      'miss',
    );
  });

  test('flags an unreadable fixture instead of skipping it', () => {
    expect(check({ [fixturePath]: '{' })).toHaveLength(1);
  });

  test('flags an unreadable base fixture instead of skipping it', () => {
    expect(
      guardViolations({
        base: tree({ ...base, [fixturePath]: '{' }),
        head: tree(base),
      }),
    ).toHaveLength(1);
  });
});

describe('install settings', () => {
  test('flags a shorter release age', () => {
    expectViolation(
      check({
        'bunfig.toml':
          '[install]\nauto = "disable"\nexact = true\nminimumReleaseAge = 3600\n',
      }),
      'minimumReleaseAge',
    );
  });

  test('flags a missing release age', () => {
    expect(
      check({ 'bunfig.toml': '[install]\nauto = "disable"\nexact = true\n' }),
    ).toHaveLength(1);
  });

  test('flags release age exclusions', () => {
    expectViolation(
      check({
        'bunfig.toml':
          '[install]\nauto = "disable"\nexact = true\nminimumReleaseAge = 259200\nminimumReleaseAgeExcludes = ["effect"]\n',
      }),
      'minimumReleaseAgeExcludes',
    );
  });

  test('flags auto-install, which ignores the lockfile', () => {
    expectViolation(
      check({
        'bunfig.toml': '[install]\nexact = true\nminimumReleaseAge = 259200\n',
      }),
      'auto',
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

  test('flags a dependency field that is not an object', () => {
    expectViolation(
      check({ 'package.json': json({ devDependencies: ['typescript'] }) }),
      'devDependencies',
    );
  });
});

describe('runtime dependencies', () => {
  const withDependency = (name: string) =>
    json({
      dependencies: {
        '@gate/cel': 'workspace:*',
        effect: '4.0.0-rc.117',
        [name]: '1.0.0',
      },
    });

  test('flags a new dependency with no recorded reason', () => {
    expectViolation(
      check({ 'packages/gate/package.json': withDependency('left-pad') }),
      'left-pad',
    );
  });

  test('flags a new dependency whose name only appears inside other words', () => {
    expectViolation(
      check({ 'packages/gate/package.json': withDependency('ms') }),
      'ms',
    );
  });

  test('allows a new dependency named in docs/REVIEW.md', () => {
    expect(
      check({
        'packages/gate/package.json': withDependency('left-pad'),
        'docs/REVIEW.md': 'Use Effect v4 (`effect`). `left-pad` because…\n',
      }),
    ).toEqual([]);
  });
});
