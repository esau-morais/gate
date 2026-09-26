import { describe, expect, test } from 'bun:test';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evidenceDir,
  expectedNodes,
  loadVerifyCases,
  summarizeOutput,
  verifyArgs,
} from './verify/cases';
import {
  linkNoPatternCovers,
  linkOutsideRepository,
  recordedLockPath,
  rootWithoutWorkspaces,
} from './workspaces/locks';

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
    }
  });
}

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
      ]);
      const implicit = raw(['verify', '--evidence', evidence, '--at', at], {
        cwd: dir,
      });

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
        `gate verify: no package-lock.json in ${dir}; pass --lockfile`,
      );
      expect(run.stdout).toBe('');
      expect(existsSync(join(dir, 'cache', 'gate'))).toBe(false);
      expect(run.exitCode).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

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
    ]);

  test('links to the workspaces npm/cli and sigstore-js declare do not reject', () => {
    for (const name of ['npm-cli', 'sigstore-js'] as const) {
      const run = verifyLock(recordedLockPath(name));

      expect(run.stderr).toBe('');
      expect(run.nodes).toEqual([]);
      expect(run.exitCode).toBe(0);
    }
  });

  test('a link outside the repository, a link no pattern covers, and a root without workspaces still reject', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gate-workspaces-'));
    try {
      const rejected = Object.entries({
        outside: linkOutsideRepository(),
        uncovered: linkNoPatternCovers(),
        undeclared: rootWithoutWorkspaces(),
      }).map(([name, lock]) => {
        const file = join(dir, `${name}.json`);
        writeFileSync(file, JSON.stringify(lock));
        const run = verifyLock(file);

        return [
          name,
          run.exitCode,
          run.nodes.flatMap((node) =>
            'outcome' in node &&
            node.outcome === 'REJECT' &&
            node.reasons.includes('exotic_source')
              ? [node.path]
              : [],
          ).length,
        ];
      });

      expect(rejected).toEqual([
        ['outside', 1, 1],
        ['uncovered', 1, 1],
        ['undeclared', 1, 16],
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
