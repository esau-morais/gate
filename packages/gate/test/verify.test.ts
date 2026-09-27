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
import { Schema } from 'effect';
import {
  evidenceDir,
  expectedNodes,
  loadVerifyCases,
  summarizeOutput,
  verifyArgs,
} from './verify/cases';
import { recordedPnpmLock, recordedPnpmLockPath } from './pnpm/locks';
import { recordedLock, recordedLockPath, type Lock } from './workspaces/locks';

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
