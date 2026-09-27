import { describe, expect, test } from 'bun:test';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Schema } from 'effect';
import {
  evidenceDir,
  expectedNodes,
  loadVerifyCases,
  type NodeSummary,
  summarizeOutput,
  verifyArgs,
} from './verify/cases';
import {
  recordedPnpmLock,
  recordedPnpmLockPath,
  recordedPnpmWorkspace,
} from './pnpm/locks';
import { generateTestLogKey } from './support/log';
import { readLog } from '../src/log/log';
import { parseVerifierKey } from '../src/log/note';
import { decodeRecord, lockfileDigest } from '../src/record';
import { recordedLock, recordedLockPath, type Lock } from './workspaces/locks';
import {
  loadSupplyChainPolicyV1,
  loadSupplyChainPolicyV2,
  loadSupplyChainPolicyV3,
} from './support/policies';
import { noContext } from '../src/context';
import { PolicyRef } from '../src/policy';
import { readEvidenceDirectory } from '../src/npm/evidence-directory';
import { readPackageLock } from '../src/npm/lockfile';
import { verifyNodes } from '../src/npm/verify';

const pinned = [
  loadSupplyChainPolicyV1(),
  loadSupplyChainPolicyV2(),
  loadSupplyChainPolicyV3(),
];
const decodePolicies = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ policies: Schema.NonEmptyArray(PolicyRef) }),
  ),
);

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

function raw(
  args: readonly string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
) {
  const run = Bun.spawnSync(['bun', cli, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined
      ? {}
      : { env: { ...process.env, ...options.env } }),
  });

  return {
    exitCode: run.exitCode,
    stdout: run.stdout.toString(),
    stderr: run.stderr.toString(),
  };
}

function gate(args: readonly string[]) {
  const run = raw(args);

  return {
    exitCode: run.exitCode,
    stderr: run.stderr,
    nodes: summarizeOutput(run.stdout),
  };
}

for (const { name, dir, fixture } of loadVerifyCases()) {
  describe(name, () => {
    for (const evaluation of fixture.evaluations) {
      test(evaluation.moment, () => {
        const run = gate(verifyArgs(dir, fixture, evaluation));

        expect(run.stderr).toBe('');
        expect(run.nodes).toEqual(expectedNodes(evaluation));
        expect(run.exitCode).toBe(evaluation.exitCode);
      });

      test.each(pinned.map((policy) => [policy.ref.id, policy] as const))(
        `${evaluation.moment} (%s)`,
        (_, policy) => {
          const lock = readPackageLock(
            readFileSync(new URL(fixture.lockfile, dir), 'utf8'),
          );
          if (lock.kind !== 'read') {
            throw new Error(lock.error);
          }

          const nodes = verifyNodes({
            nodes: lock.nodes,
            store: readEvidenceDirectory(fileURLToPath(evidenceDir)),
            at: evaluation.at,
            policy,
            context: noContext,
          }).map((record): NodeSummary => {
            const location =
              record.dependency === undefined
                ? { path: record.path }
                : { path: record.path, dependency: record.dependency };

            return record.kind === 'decision'
              ? {
                  ...location,
                  outcome: record.outcome,
                  reasons: record.reasons
                    .map((reason) => reason.code)
                    .toSorted(),
                }
              : { ...location, unreadable: record.error };
          });

          expect(nodes).toEqual(expectedNodes(evaluation));
        },
      );
    }
  });
}

test('gate verify decides under SupplyChainPolicy/v3', () => {
  const vite = loadVerifyCases().find(
    ({ name }) => name === 'vite-8.3.0-benign',
  );
  if (vite === undefined) {
    throw new Error('the vite lockfile case is missing');
  }

  const [evaluation] = vite.fixture.evaluations;
  const run = raw(verifyArgs(vite.dir, vite.fixture, evaluation));
  const policies = run.stdout
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => decodePolicies(line).policies);

  expect(policies.length).toBeGreaterThan(0);
  for (const refs of policies) {
    expect(refs).toEqual([loadSupplyChainPolicyV3().ref]);
  }
});

test('an unsupported lockfile version exits non-zero with an unreadable record', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-verify-'));
  const lockfile = join(dir, 'package-lock.json');
  writeFileSync(
    lockfile,
    JSON.stringify({ lockfileVersion: 1, dependencies: {} }),
  );

  try {
    const run = gate([
      'verify',
      '--lockfile',
      lockfile,
      '--evidence',
      fileURLToPath(evidenceDir),
      '--at',
      '2026-09-26T00:00:00Z',
      '--json',
    ]);

    expect(run.nodes.map((node) => 'unreadable' in node)).toEqual([true]);
    expect(run.exitCode).toBe(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('evidence source', () => {
  const lockfile = fileURLToPath(
    new URL(
      'verify/cases/vite-8.3.0-benign/package-lock.json',
      import.meta.url,
    ),
  );
  test('--evidence and --fetch together are refused before anything is fetched', () => {
    const cache = mkdtempSync(join(tmpdir(), 'gate-fetch-'));
    try {
      const run = raw([
        'verify',
        '--lockfile',
        lockfile,
        '--evidence',
        fileURLToPath(evidenceDir),
        '--fetch',
        cache,
      ]);

      expect(run.stderr).toContain(
        'gate verify: pass --evidence or --fetch, not both',
      );
      expect(run.stdout).toBe('');
      expect(readdirSync(cache)).toEqual([]);
      expect(run.exitCode).toBe(1);
    } finally {
      rmSync(cache, { recursive: true, force: true });
    }
  });
});

describe('zero config', () => {
  const at = '2026-05-11T20:14:12Z';
  const lockfile = fileURLToPath(
    new URL(
      'verify/cases/tanstack-react-router-1.169.8/package-lock.json',
      import.meta.url,
    ),
  );
  const evidence = fileURLToPath(evidenceDir);

  test('without --lockfile, gate verify reads ./package-lock.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gate-cwd-'));
    try {
      copyFileSync(lockfile, join(dir, 'package-lock.json'));
      const explicit = raw([
        'verify',
        '--lockfile',
        lockfile,
        '--evidence',
        evidence,
        '--at',
        at,
        '--json',
      ]);
      const implicit = raw(
        ['verify', '--evidence', evidence, '--at', at, '--json'],
        { cwd: dir },
      );

      expect(implicit.stderr).toBe('');
      expect(explicit.stdout).not.toBe('');
      expect(implicit.stdout).toBe(explicit.stdout);
      expect(implicit.exitCode).toBe(explicit.exitCode);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('without a lockfile in the directory, gate verify fails before fetching', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gate-cwd-'));
    try {
      const run = raw(['verify'], {
        cwd: dir,
        env: { XDG_CACHE_HOME: join(dir, 'cache') },
      });

      expect(run.stderr).toContain(
        `gate verify: no package-lock.json or pnpm-lock.yaml in ${dir}; pass --lockfile`,
      );
      expect(run.stdout).toBe('');
      expect(existsSync(join(dir, 'cache', 'gate'))).toBe(false);
      expect(run.exitCode).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function withPackages(lock: Lock, packages: Lock['packages']): Lock {
  return { ...lock, packages: { ...lock.packages, ...packages } };
}

export function linkOutsideRepository(): Lock {
  return withPackages(recordedLock('npm-cli'), {
    'node_modules/libnpmaccess': { resolved: '../libnpmaccess', link: true },
    '../libnpmaccess': { version: '11.0.0' },
  });
}

export function linkNoPatternCovers(): Lock {
  return withPackages(recordedLock('npm-cli'), {
    'node_modules/vendored': { resolved: 'vendor/vendored', link: true },
    'vendor/vendored': { version: '1.0.0' },
  });
}

export function rootWithoutWorkspaces(): Lock {
  const lock = recordedLock('npm-cli');
  const root = Object.entries(lock.packages[''] ?? {}).filter(
    ([key]) => key !== 'workspaces',
  );

  return withPackages(lock, { '': Object.fromEntries(root) });
}

describe('workspace links', () => {
  const at = '2026-09-26T00:00:00Z';
  const verifyLock = (lockfile: string) =>
    gate([
      'verify',
      '--lockfile',
      lockfile,
      '--evidence',
      fileURLToPath(evidenceDir),
      '--at',
      at,
      '--json',
    ]);

  test('links to the workspaces npm/cli and sigstore-js declare do not reject', () => {
    for (const name of ['npm-cli', 'sigstore-js'] as const) {
      const run = verifyLock(recordedLockPath(name));

      expect(run.stderr).toBe('');
      expect(run.nodes).toEqual([]);
      expect(run.exitCode).toBe(0);
    }
  });

  const rejectedLinks = (lock: unknown) => {
    const dir = mkdtempSync(join(tmpdir(), 'gate-workspaces-'));
    try {
      const file = join(dir, 'package-lock.json');
      writeFileSync(file, JSON.stringify(lock));
      const run = verifyLock(file);

      return {
        exitCode: run.exitCode,
        paths: run.nodes.flatMap((node) =>
          'outcome' in node &&
          node.outcome === 'REJECT' &&
          node.reasons.includes('exotic_source')
            ? [node.path]
            : [],
        ),
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test('a link to a folder outside the repository still rejects', () => {
    expect(rejectedLinks(linkOutsideRepository())).toEqual({
      exitCode: 1,
      paths: ['node_modules/libnpmaccess'],
    });
  });

  test('a link no workspaces pattern covers still rejects', () => {
    expect(rejectedLinks(linkNoPatternCovers())).toEqual({
      exitCode: 1,
      paths: ['node_modules/vendored'],
    });
  });

  test('every link rejects when the root declares no workspaces', () => {
    const run = rejectedLinks(rootWithoutWorkspaces());

    expect(run.exitCode).toBe(1);
    expect(run.paths).toHaveLength(16);
  });
});

describe('pnpm-lock.yaml', () => {
  const evidence = fileURLToPath(evidenceDir);
  const viteAt = '2026-09-23T12:17:15Z';
  const vue = recordedPnpmLockPath('vuejs-core');
  const verifyAt = (lockfile: string, at = viteAt) =>
    raw([
      'verify',
      '--lockfile',
      lockfile,
      '--evidence',
      evidence,
      '--at',
      at,
      '--json',
    ]);
  const decodeLine = Schema.decodeUnknownSync(
    Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
  );
  const decisions = (stdout: string) =>
    stdout
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => decodeLine(line));
  const withTempLock = <A>(text: string, run: (file: string) => A): A => {
    const dir = mkdtempSync(join(tmpdir(), 'gate-pnpm-'));
    try {
      const file = join(dir, 'pnpm-lock.yaml');
      writeFileSync(file, text);

      return run(file);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test('without --lockfile, gate verify reads ./pnpm-lock.yaml', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gate-cwd-'));
    try {
      copyFileSync(vue, join(dir, 'pnpm-lock.yaml'));
      const explicit = verifyAt(vue);
      const implicit = raw(
        ['verify', '--evidence', evidence, '--at', viteAt, '--json'],
        {
          cwd: dir,
        },
      );

      expect(implicit.stderr).toBe('');
      expect(explicit.stdout).not.toBe('');
      expect(implicit.stdout).toBe(explicit.stdout);
      expect(implicit.exitCode).toBe(explicit.exitCode);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('with both lockfiles in the directory, gate verify asks for --lockfile before fetching', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gate-cwd-'));
    try {
      copyFileSync(vue, join(dir, 'pnpm-lock.yaml'));
      copyFileSync(recordedLockPath('npm-cli'), join(dir, 'package-lock.json'));
      const run = raw(['verify'], {
        cwd: dir,
        env: { XDG_CACHE_HOME: join(dir, 'cache') },
      });

      expect(run.stderr).toContain(
        `gate verify: both package-lock.json and pnpm-lock.yaml in ${dir}; pass --lockfile`,
      );
      expect(run.stdout).toBe('');
      expect(existsSync(join(dir, 'cache', 'gate'))).toBe(false);
      expect(run.exitCode).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('vite in vuejs/core gets the decision vite gets in a package-lock.json', () => {
    const npm = decisions(
      verifyAt(
        fileURLToPath(
          new URL(
            'verify/cases/vite-8.3.0-benign/package-lock.json',
            import.meta.url,
          ),
        ),
      ).stdout,
    );
    const pnpm = decisions(verifyAt(vue).stdout).filter(
      (line) =>
        typeof line['path'] === 'string' && line['path'].startsWith('vite@'),
    );
    const decision = (line: Readonly<Record<string, unknown>>) =>
      Object.fromEntries(
        Object.entries(line).filter(([key]) => key !== 'path' && key !== 'dev'),
      );

    expect(npm).toHaveLength(1);
    expect(pnpm).toHaveLength(1);
    expect(pnpm.map(decision)).toEqual(npm.map(decision));
    expect(pnpm[0]).toMatchObject({ outcome: 'ACCEPT', dev: true });
  });

  test('a registry node without integrity quarantines on integrity_unknown', () => {
    const text = recordedPnpmLock('vuejs-core').replace(
      /resolution: \{integrity: sha512-lhZBV[^}]*\}/,
      'resolution: {}',
    );
    const run = withTempLock(text, verifyAt);
    const vite = summarizeOutput(run.stdout).find((node) =>
      node.path.startsWith('vite@'),
    );

    expect(vite).toMatchObject({ outcome: 'QUARANTINE' });
    expect(vite && 'reasons' in vite && vite.reasons).toContain(
      'integrity_unknown',
    );
    expect(run.exitCode).toBe(1);
  });

  test('the default report tells a pnpm user how to fix a missing integrity with pnpm', () => {
    const text = recordedPnpmLock('vuejs-core').replace(
      /resolution: \{integrity: sha512-lhZBV[^}]*\}/,
      'resolution: {}',
    );
    const run = withTempLock(text, (file) =>
      raw([
        'verify',
        '--lockfile',
        file,
        '--evidence',
        evidence,
        '--at',
        viteAt,
      ]),
    );

    expect(run.stdout).toContain('pnpm install --lockfile-only');
    expect(run.stdout).not.toContain('package-lock');
    expect(run.exitCode).toBe(1);
  });

  const addLink = (target: string) =>
    recordedPnpmLock('vuejs-core').replace(
      '  packages/vue:\n    dependencies:\n',
      `  packages/vue:\n    dependencies:\n      extra:\n        specifier: ${target}\n        version: ${target}\n`,
    );
  const rejectedAt = (text: string) =>
    withTempLock(text, (file) => {
      const run = verifyAt(file);

      return {
        exitCode: run.exitCode,
        rejected: summarizeOutput(run.stdout).flatMap((node) =>
          'outcome' in node &&
          node.outcome === 'REJECT' &&
          node.reasons.includes('exotic_source')
            ? [[node.path, node.dependency]]
            : [],
        ),
      };
    });

  test('a link outside the repository still rejects', () => {
    expect(rejectedAt(addLink('link:../../../outside'))).toEqual({
      exitCode: 1,
      rejected: [['packages/vue', 'extra']],
    });
  });

  test('a link to a path no importer names still rejects', () => {
    expect(rejectedAt(addLink('link:../../vendor/lib'))).toEqual({
      exitCode: 1,
      rejected: [['packages/vue', 'extra']],
    });
  });

  const unreadableAt = (text: string) =>
    withTempLock(text, (file) => {
      const run = verifyAt(file);

      return {
        exitCode: run.exitCode,
        unreadable: summarizeOutput(run.stdout).flatMap((node) =>
          'unreadable' in node ? [node.path] : [],
        ),
      };
    });

  test('a git dependency without a full commit is unreadable', () => {
    const key = 'g@git+https://example.com/o/r.git#main';
    const lock = recordedPnpmLock('vuejs-core');
    const main = lock.lastIndexOf('\nsnapshots:\n');
    const text =
      `${lock.slice(0, main)}\n  '${key}':\n    resolution: {commit: main, repo: https://example.com/o/r.git, type: git}\n    version: 1.0.0\n\nsnapshots:\n\n  '${key}': {}\n${lock.slice(main + '\nsnapshots:\n'.length)}`.replace(
        '  packages/vue:\n    dependencies:\n',
        `  packages/vue:\n    dependencies:\n      g:\n        specifier: git+https://example.com/o/r.git#main\n        version: git+https://example.com/o/r.git#main\n`,
      );

    expect(unreadableAt(text)).toEqual({ exitCode: 1, unreadable: [key] });
  });

  test('an unsupported lockfileVersion is unreadable', () => {
    expect(unreadableAt(recordedPnpmLock('rules-js-v60'))).toEqual({
      exitCode: 1,
      unreadable: [''],
    });
  });
});

describe('pnpm config dependencies', () => {
  const evidence = fileURLToPath(evidenceDir);
  const viteAt = '2026-09-23T12:17:15Z';
  const vite = (integrity: string) =>
    `configDependencies:\n  vite: '8.3.0+${integrity}'\n`;
  const viteSha512 =
    'sha512-lhZBVvEHefgE+HQZC9O7EBJgCU/nVzFNl7vkS4RE0APtWLP02/8QVIkQtzBxPquh7lq5/78NHipTj7ODQ6XuyQ==';
  const emptyLock = "lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n";
  const inRepository = <A>(
    files: Readonly<Record<string, string>>,
    run: (dir: string) => A,
  ): A => {
    const dir = mkdtempSync(join(tmpdir(), 'gate-config-'));
    try {
      for (const [name, text] of Object.entries(files)) {
        mkdirSync(join(dir, name, '..'), { recursive: true });
        writeFileSync(join(dir, name), text);
      }

      return run(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  const verifyIn = (dir: string, extra: readonly string[] = []) =>
    raw(
      ['verify', '--evidence', evidence, '--at', viteAt, '--json', ...extra],
      { cwd: dir },
    );
  const decodeLine = Schema.decodeUnknownSync(
    Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
  );
  const decisionOf = (stdout: string) =>
    stdout
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => decodeLine(line));

  test('a config dependency with sha512 integrity is decided like a registry node', () => {
    const npm = decisionOf(
      raw([
        'verify',
        '--lockfile',
        fileURLToPath(
          new URL(
            'verify/cases/vite-8.3.0-benign/package-lock.json',
            import.meta.url,
          ),
        ),
        '--evidence',
        evidence,
        '--at',
        viteAt,
        '--json',
      ]).stdout,
    );
    const run = inRepository(
      { 'pnpm-lock.yaml': emptyLock, 'pnpm-workspace.yaml': vite(viteSha512) },
      (dir) => verifyIn(dir),
    );
    const config = decisionOf(run.stdout);
    const withoutLocation = (line: Readonly<Record<string, unknown>>) =>
      Object.fromEntries(
        Object.entries(line).filter(
          ([key]) => !['path', 'dependency', 'dev'].includes(key),
        ),
      );

    expect(config).toMatchObject([
      {
        path: 'pnpm-workspace.yaml',
        dependency: 'vite',
        outcome: 'ACCEPT',
        dev: false,
      },
    ]);
    expect(config.map(withoutLocation)).toEqual(npm.map(withoutLocation));
    expect(run.exitCode).toBe(0);
  });

  test('a config dependency with a missing or sha1 integrity quarantines on integrity_unknown', () => {
    for (const workspace of [
      vite('sha1-2jmk2uB6XNwfJ9xCwhuS9fAjq1E='),
      'configDependencies:\n  vite: 8.3.0\n',
    ]) {
      const run = inRepository(
        { 'pnpm-lock.yaml': emptyLock, 'pnpm-workspace.yaml': workspace },
        (dir) => verifyIn(dir),
      );

      expect(summarizeOutput(run.stdout)).toEqual([
        {
          path: 'pnpm-workspace.yaml',
          dependency: 'vite',
          outcome: 'QUARANTINE',
          reasons: ['integrity_unknown'],
        },
      ]);
      expect(run.exitCode).toBe(1);
    }
  });

  test('a config dependency pnpm-workspace.yaml and the env document disagree on is unreadable', () => {
    const run = inRepository(
      {
        'pnpm-lock.yaml': recordedPnpmLock('rules-js-multi-document-v11'),
        'pnpm-workspace.yaml': recordedPnpmWorkspace('rules-js').replace(
          'semver: 7.7.4+',
          'semver: 7.7.3+',
        ),
      },
      (dir) => verifyIn(dir),
    );
    expect(
      summarizeOutput(run.stdout).map((node) => [
        node.path,
        node.dependency,
        'unreadable' in node,
      ]),
    ).toEqual([
      ['env:semver@7.7.4', undefined, false],
      ['ms@2.1.3', undefined, false],
      ['pnpm-workspace.yaml', 'semver', true],
    ]);
    expect(run.exitCode).toBe(1);
  });

  test('a pnpm-workspace.yaml gate cannot read is unreadable, never empty', () => {
    const run = inRepository(
      {
        'pnpm-lock.yaml': emptyLock,
        'pnpm-workspace.yaml': `pins: &pins\n  vite: '8.3.0+${viteSha512}'\nconfigDependencies: *pins\n`,
      },
      (dir) => verifyIn(dir),
    );

    expect(summarizeOutput(run.stdout)).toMatchObject([
      { path: 'pnpm-workspace.yaml', unreadable: 'YAML with an anchor' },
    ]);
    expect(run.exitCode).toBe(1);
  });

  test('--lockfile and a lockfile below the workspace root find the nearest pnpm-workspace.yaml', () => {
    inRepository(
      {
        'app/pnpm-lock.yaml': emptyLock,
        'pnpm-workspace.yaml': vite(viteSha512),
      },
      (dir) => {
        const explicit = raw([
          'verify',
          '--lockfile',
          join(dir, 'app', 'pnpm-lock.yaml'),
          '--evidence',
          evidence,
          '--at',
          viteAt,
          '--json',
        ]);
        const implicit = verifyIn(join(dir, 'app'));

        expect(summarizeOutput(explicit.stdout)).toEqual([
          {
            path: '../pnpm-workspace.yaml',
            dependency: 'vite',
            outcome: 'ACCEPT',
            reasons: [],
          },
        ]);
        expect(implicit.stdout).toBe(explicit.stdout);
      },
    );
  });

  test('a lockfile folder reached through a symlink finds the workspace file of the real folder', () => {
    inRepository(
      {
        'real/app/pnpm-lock.yaml': emptyLock,
        'real/pnpm-workspace.yaml': vite(viteSha512),
      },
      (dir) => {
        symlinkSync(join(dir, 'real', 'app'), join(dir, 'link'));
        const run = raw([
          'verify',
          '--lockfile',
          join(dir, 'link', 'pnpm-lock.yaml'),
          '--evidence',
          evidence,
          '--at',
          viteAt,
          '--json',
        ]);

        expect(
          summarizeOutput(run.stdout).map((node) => [
            node.path,
            node.dependency,
          ]),
        ).toEqual([['../pnpm-workspace.yaml', 'vite']]);
      },
    );
  });

  test('a package-lock.json does not read pnpm-workspace.yaml', () => {
    const lock = readFileSync(
      new URL(
        'verify/cases/vite-8.3.0-benign/package-lock.json',
        import.meta.url,
      ),
      'utf8',
    );
    const run = inRepository(
      { 'package-lock.json': lock, 'pnpm-workspace.yaml': '- not a map\n' },
      (dir) => verifyIn(dir),
    );

    expect(summarizeOutput(run.stdout).map((node) => node.path)).toEqual([
      'node_modules/vite',
    ]);
  });

  test('the log binds a config dependency to the bytes of pnpm-workspace.yaml', () => {
    const key = generateTestLogKey('gate.test/config');
    const workspace = vite(viteSha512);
    const lock = recordedPnpmLock('vuejs-core');
    inRepository(
      {
        'pnpm-lock.yaml': lock,
        'pnpm-workspace.yaml': workspace,
        'log.key': key.skey,
      },
      (dir) => {
        const run = verifyIn(dir, [
          '--log',
          join(dir, 'log'),
          '--log-key',
          join(dir, 'log.key'),
        ]);
        const read = readLog({
          dir: join(dir, 'log'),
          verifier: parseVerifierKey(key.vkey),
        });
        if (read.kind !== 'read') {
          throw new Error(read.error);
        }

        const bound = read.entries().flatMap((entry) => {
          const record =
            entry.kind === 'failed' ? undefined : decodeRecord(entry.bytes);

          return record?.kind === 'read'
            ? [[record.record.path, record.record.lockfile] as const]
            : [];
        });
        const digest = (text: string) =>
          lockfileDigest(new TextEncoder().encode(text));

        expect(run.stderr).toBe('');
        expect(bound).toContainEqual([
          'pnpm-workspace.yaml',
          digest(workspace),
        ]);
        expect(
          bound.filter(([path]) => path !== 'pnpm-workspace.yaml'),
        ).toEqual(
          bound
            .filter(([path]) => path !== 'pnpm-workspace.yaml')
            .map(([path]) => [path, digest(lock)]),
        );
        expect(bound.length).toBeGreaterThan(1);
      },
    );
  });

  test('the report tells a pnpm 10 user how to re-pin a config dependency', () => {
    const run = inRepository(
      {
        'pnpm-lock.yaml': emptyLock,
        'pnpm-workspace.yaml': 'configDependencies:\n  vite: 8.3.0\n',
      },
      (dir) =>
        raw(['verify', '--evidence', evidence, '--at', viteAt], { cwd: dir }),
    );

    expect(run.stdout).toContain('pnpm-workspace.yaml -> vite');
    expect(run.stdout).toContain('pnpm add --config vite@8.3.0');
    expect(run.stdout).not.toContain('pnpm-lock.yaml');
  });
});
