import { readdirSync, readFileSync } from 'node:fs';
import {
  decodeReplayExpectations,
  type ReplayExpectations,
} from '../packages/gate/test/replay/fixture';

export type Tree = {
  read(path: string): string | undefined;
  list(dir: string): string[];
};

const policiesDir = 'packages/gate/policies';
const pinnedDigestsPath = 'packages/gate/src/policies.ts';
const knownFailuresPath = 'packages/cel/test/conformance-known-failures.json';
const fixturesDir = 'packages/gate/test/replay/fixtures';
const reviewPath = 'docs/REVIEW.md';
const minimumReleaseAge = 259200;
const exactSpec = /^(?:\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?|workspace:\*)$/;
const pinnedDigest =
  /PolicyDigest\.make\(\s*'(sha256:[0-9a-f]{64})'\s*,?\s*\)/g;

type Expected = ReplayExpectations['evaluations'][number]['expected'];
type Outcome = Expected['outcome'];
const strictness: readonly Outcome[] = ['ACCEPT', 'QUARANTINE', 'REJECT'];

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseObject(text: string | undefined): JsonObject | undefined {
  if (text === undefined) {
    return undefined;
  }

  try {
    const value: unknown = JSON.parse(text);

    return isObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function checkPolicies(base: Tree, head: Tree): string[] {
  const edited = base
    .list(policiesDir)
    .map((file) => `${policiesDir}/${file}`)
    .filter((path) => head.read(path) !== base.read(path))
    .map(
      (path) =>
        `${path}: published policies are immutable; add a new version instead`,
    );
  const pinned = (tree: Tree) =>
    [...(tree.read(pinnedDigestsPath) ?? '').matchAll(pinnedDigest)].map(
      ([, digest]) => digest,
    );
  const headDigests = new Set(pinned(head));
  const unpinned = pinned(base)
    .filter((digest) => !headDigests.has(digest))
    .map(
      (digest) => `${pinnedDigestsPath}: pinned digest ${digest} was removed`,
    );

  return [...edited, ...unpinned];
}

function checkKnownFailures(base: Tree, head: Tree): string[] {
  const before = parseObject(base.read(knownFailuresPath));
  const after = parseObject(head.read(knownFailuresPath));
  if (before === undefined || after === undefined) {
    return [`${knownFailuresPath}: unreadable`];
  }

  return Object.keys(after)
    .filter((name) => !(name in before))
    .map(
      (name) =>
        `${knownFailuresPath}: new entry ${name}; fix the regression instead`,
    );
}

function decodeFixture(
  text: string | undefined,
): ReplayExpectations | undefined {
  if (text === undefined) {
    return undefined;
  }

  try {
    return decodeReplayExpectations(text);
  } catch {
    return undefined;
  }
}

function weakening(before: Expected, after: Expected): string | undefined {
  const change =
    strictness.indexOf(after.outcome) - strictness.indexOf(before.outcome);
  if (change < 0) {
    return `went from ${before.outcome} to ${after.outcome}`;
  }

  const dropped = before.reasons.filter(
    (reason) => !after.reasons.includes(reason),
  );

  return change === 0 && dropped.length > 0
    ? `dropped reasons ${dropped.join(', ')}`
    : undefined;
}

type Evaluation = ReplayExpectations['evaluations'][number];

function underPolicy(evaluation: Evaluation, policy: string): Expected {
  const { expectedUnder } = evaluation;

  return (
    (expectedUnder !== undefined && Object.hasOwn(expectedUnder, policy)
      ? expectedUnder[policy]
      : undefined) ?? evaluation.expected
  );
}

function checkFixture(path: string, base: Tree, head: Tree): string[] {
  const before = decodeFixture(base.read(path));
  if (before === undefined) {
    return [`${path}: base fixture is unreadable, so nothing can be compared`];
  }

  const after = decodeFixture(head.read(path));
  if (after === undefined) {
    return [`${path}: replay fixture was deleted or is unreadable`];
  }

  const missAdded =
    before.miss === undefined && after.miss !== undefined
      ? [`${path}: a caught incident gained a miss`]
      : [];
  const weakened = before.evaluations.flatMap((evaluation) => {
    const moment = evaluation.at.toISOString().replace('.000Z', 'Z');
    const now = after.evaluations.find(
      (entry) => entry.at.getTime() === evaluation.at.getTime(),
    );
    if (now === undefined) {
      return [`${path}: evaluation at ${moment} was removed`];
    }

    const policies = [
      ...new Set([
        ...Object.keys(evaluation.expectedUnder ?? {}),
        ...Object.keys(now.expectedUnder ?? {}),
      ]),
    ].toSorted();
    const shared = weakening(evaluation.expected, now.expected);

    return [
      ...(shared === undefined
        ? []
        : [`${path}: evaluation at ${moment} ${shared}`]),
      ...policies.flatMap((policy) => {
        const change = weakening(
          underPolicy(evaluation, policy),
          underPolicy(now, policy),
        );

        return change === undefined
          ? []
          : [`${path}: evaluation at ${moment} under ${policy} ${change}`];
      }),
    ];
  });

  return [...missAdded, ...weakened];
}

function checkFixtures(base: Tree, head: Tree): string[] {
  return base
    .list(fixturesDir)
    .filter((file) => file.endsWith('.json'))
    .flatMap((file) => checkFixture(`${fixturesDir}/${file}`, base, head));
}

function checkBunfig(head: Tree): string[] {
  let config: unknown;
  try {
    config = Bun.TOML.parse(head.read('bunfig.toml') ?? '');
  } catch {
    return ['bunfig.toml: unreadable'];
  }

  const install = isObject(config) ? config['install'] : undefined;
  if (!isObject(install)) {
    return ['bunfig.toml: missing [install]'];
  }

  const age = install['minimumReleaseAge'];

  return [
    ...(typeof age === 'number' && age >= minimumReleaseAge
      ? []
      : [
          `bunfig.toml: minimumReleaseAge must be at least ${minimumReleaseAge}`,
        ]),
    ...(install['exact'] === true ? [] : ['bunfig.toml: exact must be true']),
    ...(install['auto'] === 'disable'
      ? []
      : [
          'bunfig.toml: auto must be "disable"; auto-install ignores the lockfile',
        ]),
    ...('minimumReleaseAgeExcludes' in install
      ? ['bunfig.toml: minimumReleaseAgeExcludes bypasses the release age']
      : []),
  ];
}

const dependencyFields = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
  'overrides',
  'resolutions',
];

function namedIn(review: string, name: string): boolean {
  return review.includes(`\`${name}\``) || review.includes(`\`${name}@`);
}

function checkManifest(
  path: string,
  manifest: JsonObject,
  previous: JsonObject | undefined,
  review: string,
): string[] {
  const trusted = manifest['trustedDependencies'];
  const trustedViolations =
    trusted === undefined || (Array.isArray(trusted) && trusted.length === 0)
      ? []
      : [`${path}: trustedDependencies must stay empty`];
  const specViolations = dependencyFields.flatMap((key) => {
    const specs = manifest[key];
    if (specs === undefined) {
      return [];
    }

    if (!isObject(specs)) {
      return [`${path}: ${key} must be an object`];
    }

    return Object.entries(specs)
      .filter(([, spec]) => typeof spec !== 'string' || !exactSpec.test(spec))
      .map(
        ([name, spec]) =>
          `${path}: ${key}.${name} must be an exact version, got ${JSON.stringify(spec)}`,
      );
  });
  const runtime = manifest['dependencies'];
  const known = previous?.['dependencies'];
  const undocumented = (isObject(runtime) ? Object.keys(runtime) : [])
    .filter((name) => !(isObject(known) && name in known))
    .filter((name) => !namedIn(review, name))
    .map(
      (name) =>
        `${path}: new runtime dependency ${name} is not named in ${reviewPath}`,
    );

  return [...trustedViolations, ...specViolations, ...undocumented];
}

function checkManifests(base: Tree, head: Tree): string[] {
  const review = head.read(reviewPath) ?? '';
  const paths = [
    'package.json',
    ...head.list('packages').map((dir) => `packages/${dir}/package.json`),
  ].filter((path) => head.read(path) !== undefined);

  return paths.flatMap((path) => {
    const manifest = parseObject(head.read(path));

    return manifest === undefined
      ? [`${path}: unreadable`]
      : checkManifest(path, manifest, parseObject(base.read(path)), review);
  });
}

export function guardViolations({
  base,
  head,
}: {
  base: Tree;
  head: Tree;
}): string[] {
  return [
    ...checkPolicies(base, head),
    ...checkKnownFailures(base, head),
    ...checkFixtures(base, head),
    ...checkBunfig(head),
    ...checkManifests(base, head),
  ];
}

function git(args: string[]): string {
  const result = Bun.spawnSync(['git', ...args]);
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed: ${result.stderr.toString().trim()}`,
    );
  }

  return result.stdout.toString();
}

function gitTree(commit: string): Tree {
  const files = new Set(
    git(['ls-tree', '-r', '--name-only', commit])
      .split('\n')
      .filter((path) => path !== ''),
  );

  return {
    read: (path) =>
      files.has(path) ? git(['show', `${commit}:${path}`]) : undefined,
    list: (dir) => [
      ...new Set(
        [...files]
          .filter((path) => path.startsWith(`${dir}/`))
          .map((path) => path.slice(dir.length + 1).split('/')[0] ?? ''),
      ),
    ],
  };
}

function isMissing(error: unknown): boolean {
  return isObject(error) && error['code'] === 'ENOENT';
}

const workingTree: Tree = {
  read: (path) => {
    try {
      return readFileSync(path, 'utf8');
    } catch (error) {
      if (isMissing(error)) {
        return undefined;
      }

      throw error;
    }
  },
  list: (dir) => {
    try {
      return readdirSync(dir);
    } catch (error) {
      if (isMissing(error)) {
        return [];
      }

      throw error;
    }
  },
};

if (import.meta.main) {
  const ref =
    process.env['GATE_GUARD_BASE'] ??
    git(['merge-base', 'HEAD', 'origin/main']).trim();
  const commit = git(['rev-parse', '--verify', `${ref}^{commit}`]).trim();
  const violations = guardViolations({
    base: gitTree(commit),
    head: workingTree,
  });
  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(`guard: ${violation}`);
    }

    process.exit(1);
  }

  console.log(`guard: no violations against ${commit.slice(0, 12)}`);
}
