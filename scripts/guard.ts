import { readdirSync, readFileSync } from 'node:fs';

export type Tree = {
  read(path: string): string | undefined;
  list(dir: string): string[];
};

const policiesDir = 'packages/gate/policies';
const pinnedDigests = 'packages/gate/src/policies.ts';
const knownFailures = 'packages/cel/test/conformance-known-failures.json';
const celPackage = 'packages/cel/package.json';
const fixturesDir = 'packages/gate/test/replay/fixtures';
const decisions = 'docs/REVIEW.md';
const minimumReleaseAge = 259200;
const exactSpec = /^(?:\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?|workspace:\*)$/;
const outcomeRank: Record<string, number> = {
  ACCEPT: 0,
  QUARANTINE: 1,
  REJECT: 2,
};

type Json = Record<string, unknown>;

function isJson(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(text: string | undefined): Json | undefined {
  if (text === undefined) {
    return undefined;
  }

  try {
    const value: unknown = JSON.parse(text);

    return isJson(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function field(value: Json | undefined, key: string): Json {
  const inner = value?.[key];

  return isJson(inner) ? inner : {};
}

function packageFiles(tree: Tree): string[] {
  return [
    'package.json',
    ...tree.list('packages').map((dir) => `packages/${dir}/package.json`),
  ].filter((path) => tree.read(path) !== undefined);
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
  const headDigests = head.read(pinnedDigests) ?? '';
  const unpinned = [
    ...(base.read(pinnedDigests) ?? '').matchAll(/sha256:[0-9a-f]{64}/g),
  ]
    .map(([digest]) => digest)
    .filter((digest) => !headDigests.includes(digest))
    .map((digest) => `${pinnedDigests}: pinned digest ${digest} was removed`);

  return [...edited, ...unpinned];
}

function checkKnownFailures(base: Tree, head: Tree): string[] {
  const suiteVersion = (tree: Tree) =>
    field(parseJson(tree.read(celPackage)), 'devDependencies')[
      '@bufbuild/cel-spec'
    ];
  if (suiteVersion(base) !== suiteVersion(head)) {
    return [];
  }

  const before = parseJson(base.read(knownFailures)) ?? {};
  const after = parseJson(head.read(knownFailures));
  if (after === undefined) {
    return [`${knownFailures}: unreadable`];
  }

  return Object.keys(after)
    .filter((name) => !(name in before))
    .map(
      (name) =>
        `${knownFailures}: new entry ${name}; fix the regression instead`,
    );
}

type Evaluation = { at: string; outcome: string };

function evaluations(fixture: Json): Evaluation[] | undefined {
  const list = fixture['evaluations'];
  if (!Array.isArray(list)) {
    return undefined;
  }

  const parsed = list.map((entry: unknown) => {
    const at = isJson(entry) ? entry['at'] : undefined;
    const outcome = isJson(entry) ? field(entry, 'expected')['outcome'] : '';

    return typeof at === 'string' &&
      typeof outcome === 'string' &&
      outcome in outcomeRank
      ? { at, outcome }
      : undefined;
  });

  return parsed.every((entry) => entry !== undefined) ? parsed : undefined;
}

function checkFixture(path: string, base: Tree, head: Tree): string[] {
  const before = parseJson(base.read(path));
  const beforeEvaluations = before && evaluations(before);
  if (before === undefined || beforeEvaluations === undefined) {
    return [];
  }

  const after = parseJson(head.read(path));
  if (after === undefined) {
    return [`${path}: replay fixture was deleted or is unreadable`];
  }

  const afterEvaluations = evaluations(after);
  if (afterEvaluations === undefined) {
    return [`${path}: evaluations are unreadable`];
  }

  const missAdded =
    before['miss'] === undefined && after['miss'] !== undefined
      ? [`${path}: a caught incident gained a miss`]
      : [];
  const weakened = beforeEvaluations.flatMap(({ at, outcome }) => {
    const now = afterEvaluations.find((entry) => entry.at === at);
    if (now === undefined) {
      return [`${path}: evaluation at ${at} was removed`];
    }

    return (outcomeRank[now.outcome] ?? 0) < (outcomeRank[outcome] ?? 0)
      ? [`${path}: evaluation at ${at} went from ${outcome} to ${now.outcome}`]
      : [];
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

  const install = field(isJson(config) ? config : undefined, 'install');
  const age = install['minimumReleaseAge'];

  return [
    ...(typeof age === 'number' && age >= minimumReleaseAge
      ? []
      : [
          `bunfig.toml: minimumReleaseAge must be at least ${minimumReleaseAge}`,
        ]),
    ...(install['exact'] === true ? [] : ['bunfig.toml: exact must be true']),
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

function checkManifests(base: Tree, head: Tree): string[] {
  const review = head.read(decisions) ?? '';

  return packageFiles(head).flatMap((path) => {
    const manifest = parseJson(head.read(path));
    if (manifest === undefined) {
      return [`${path}: unreadable`];
    }

    const trusted = manifest['trustedDependencies'];
    const trustedViolations =
      trusted === undefined || (Array.isArray(trusted) && trusted.length === 0)
        ? []
        : [`${path}: trustedDependencies must stay empty`];
    const unpinned = dependencyFields.flatMap((key) =>
      Object.entries(field(manifest, key))
        .filter(([, spec]) => typeof spec !== 'string' || !exactSpec.test(spec))
        .map(
          ([name, spec]) =>
            `${path}: ${key}.${name} must be an exact version, got ${JSON.stringify(spec)}`,
        ),
    );
    const previous = field(parseJson(base.read(path)), 'dependencies');
    const undocumented = Object.keys(field(manifest, 'dependencies'))
      .filter((name) => !(name in previous) && !review.includes(name))
      .map(
        (name) =>
          `${path}: new runtime dependency ${name} has no reason in ${decisions}`,
      );

    return [...trustedViolations, ...unpinned, ...undocumented];
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

function git(args: string[]): string | undefined {
  const result = Bun.spawnSync(['git', ...args], { stderr: 'ignore' });

  return result.exitCode === 0 ? result.stdout.toString() : undefined;
}

function gitTree(commit: string): Tree {
  return {
    read: (path) => git(['show', `${commit}:${path}`]),
    list: (dir) =>
      (git(['ls-tree', '--name-only', `${commit}:${dir}`]) ?? '')
        .split('\n')
        .filter((name) => name !== ''),
  };
}

const workingTree: Tree = {
  read: (path) => {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return undefined;
    }
  },
  list: (dir) => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  },
};

if (import.meta.main) {
  const ref =
    process.env['GATE_GUARD_BASE'] ??
    git(['merge-base', 'HEAD', 'origin/main'])?.trim();
  const commit =
    ref === undefined
      ? undefined
      : git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])?.trim();
  if (commit === undefined) {
    console.error(
      'guard: no base commit; fetch origin/main or set GATE_GUARD_BASE',
    );
    process.exit(1);
  }

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
