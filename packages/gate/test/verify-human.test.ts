import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Schema } from 'effect';
import { AllowedSource, Waiver } from '../src/context';
import { evidenceDir } from './verify/cases';
import { unsafe } from './support/unsafe';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const waiverLock = fileURLToPath(
  new URL('waivers/package-lock.json', import.meta.url),
);
const waiverEvidence = fileURLToPath(
  new URL('waivers/evidence', import.meta.url),
);
const waiverAt = '2026-09-27T00:05:21.915Z';
const tanstackLock = fileURLToPath(
  new URL(
    'verify/cases/tanstack-react-router-1.169.8/package-lock.json',
    import.meta.url,
  ),
);

function gate(args: readonly string[], env: Record<string, string> = {}) {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => key !== 'FORCE_COLOR' && key !== 'NO_COLOR',
    ),
  );
  const run = Bun.spawnSync(['bun', cli, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...inherited, ...env },
  });

  return {
    exitCode: run.exitCode,
    stdout: run.stdout.toString(),
    stderr: run.stderr.toString(),
  };
}

const JsonReason = Schema.Struct({ kind: Schema.String, code: Schema.String });
const JsonLine = Schema.fromJsonString(
  Schema.Struct({
    path: Schema.String,
    dependency: Schema.optionalKey(Schema.String),
    outcome: Schema.String,
    reasons: Schema.Array(JsonReason),
  }),
);
const decodeLine = Schema.decodeUnknownSync(JsonLine);

function decisions(stdout: string) {
  return stdout
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => decodeLine(line));
}

const decodeWaiver = Schema.decodeUnknownSync(Schema.fromJsonString(Waiver));

function printedWaivers(stdout: string) {
  return stdout.split('\n').flatMap((line) => {
    const match = /^\s+waiver[^:]*: (\{.*\})$/.exec(line);

    return match?.[1] === undefined
      ? []
      : [{ text: match[1], waiver: decodeWaiver(match[1]) }];
  });
}

describe('printed waivers', () => {
  const args = (at: string) => [
    'verify',
    '--lockfile',
    waiverLock,
    '--evidence',
    waiverEvidence,
    '--at',
    at,
  ];

  // Identity rules stop 90 days after publish, so these run 30 days after each version.
  for (const [rule, name, at] of [
    ['publisher_changed', 'encodeurl', '2024-04-28T00:00:00Z'],
    ['publisher_recent', 'cookie', '2024-11-06T00:00:00Z'],
    ['trust_downgrade', 'rxjs', '2025-03-24T00:00:00Z'],
    ['new_install_script', 'unrs-resolver', waiverAt],
  ] as const) {
    test(`the ${rule} waiver decodes and clears ${rule} on the same evidence`, () => {
      const path = `node_modules/${name}`;
      const before = decisions(gate([...args(at), '--json']).stdout).find(
        (line) => line.path === path,
      );
      expect(before?.reasons).toEqual([{ kind: 'fired', code: rule }]);

      const human = gate(args(at));
      expect(human.stderr).toBe('');
      const printed = printedWaivers(human.stdout).find(
        ({ waiver }) => waiver.rule === rule && waiver.package === name,
      );
      if (printed === undefined) {
        throw new Error(`no ${rule} waiver printed for ${name}`);
      }

      const dir = mkdtempSync(join(tmpdir(), 'gate-waiver-'));
      try {
        const context = join(dir, 'context.json');
        writeFileSync(
          context,
          `{"allowedSources": [], "waivers": [${printed.text}]}`,
        );
        const after = decisions(
          gate([...args(at), '--json', '--context', context]).stdout,
        ).find((line) => line.path === path);

        expect(after?.outcome).toBe('ACCEPT');
        expect(after?.reasons).toEqual([{ kind: 'waived', code: rule }]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

const decodeAllowed = Schema.decodeUnknownSync(
  Schema.fromJsonString(AllowedSource),
);

test('the printed allowedSources entry decodes and clears exotic_source', () => {
  const args = [
    'verify',
    '--lockfile',
    tanstackLock,
    '--evidence',
    fileURLToPath(evidenceDir),
    '--at',
    '2026-05-11T20:14:12Z',
  ];
  const text = /^\s+allow[^:]*: (\{.*\})$/m.exec(gate(args).stdout)?.[1];
  if (text === undefined) {
    throw new Error('no allowedSources entry printed');
  }

  expect(decodeAllowed(text).name).toBe('@tanstack/setup');
  const dir = mkdtempSync(join(tmpdir(), 'gate-allow-'));
  try {
    const context = join(dir, 'context.json');
    writeFileSync(context, `{"allowedSources": [${text}], "waivers": []}`);
    const edge = decisions(
      gate([...args, '--json', '--context', context]).stdout,
    ).find((line) => line.dependency === '@tanstack/setup');

    expect(edge?.reasons).toEqual([
      { kind: 'fired', code: 'install_scripts_unknown' },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('lockfile shapes', () => {
  function verifyLock(lock: unknown) {
    const dir = mkdtempSync(join(tmpdir(), 'gate-shape-'));
    try {
      const lockfile = join(dir, 'package-lock.json');
      writeFileSync(lockfile, JSON.stringify(lock));

      return gate([
        'verify',
        '--lockfile',
        lockfile,
        '--evidence',
        fileURLToPath(evidenceDir),
        '--at',
        '2026-09-26T00:00:00Z',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test('an unsupported lockfile prints an UNREADABLE block and exits 1', () => {
    const run = verifyLock({ lockfileVersion: 1, dependencies: {} });

    expect(run.stdout).toContain('UNREADABLE  1 lockfile entry');
    expect(run.stdout).toContain('not a package-lock.json v2 or v3');
    expect(run.exitCode).toBe(1);
  });

  test('a lockfile with no nodes says there is nothing to check', () => {
    const run = verifyLock({ lockfileVersion: 3, packages: { '': {} } });

    expect(run.stdout).toContain('No nodes to check.');
    expect(run.exitCode).toBe(0);
  });
});

describe('release_age', () => {
  test('the printed clear time is the first moment release_age stops firing', () => {
    const args = ['verify', '--lockfile', tanstackLock, '--evidence'];
    const evidence = fileURLToPath(evidenceDir);
    const run = gate([...args, evidence, '--at', '2026-05-11T20:14:12Z']);
    const clears = /clears release_age at (\S+Z)/.exec(run.stdout)?.[1];
    if (clears === undefined) {
      throw new Error(`no clear time printed:\n${run.stdout}`);
    }

    const codesAt = (at: Date) =>
      decisions(
        gate([...args, evidence, '--at', at.toISOString(), '--json']).stdout,
      )
        .filter((line) => line.path === 'node_modules/@tanstack/react-router')
        .flatMap((line) => line.reasons.map((reason) => reason.code));
    const at = new Date(clears);

    expect(codesAt(new Date(at.getTime() - 1))).toContain('release_age');
    expect(codesAt(at)).not.toContain('release_age');
  });
});

describe('unknown evidence', () => {
  test('a version whose document npm removed says a rerun will not help', () => {
    const run = gate([
      'verify',
      '--lockfile',
      tanstackLock,
      '--evidence',
      fileURLToPath(evidenceDir),
      '--at',
      '2026-09-26T16:19:55Z',
    ]);

    expect(run.stdout).toContain('version document missing');
    expect(run.stdout).toContain(
      "rerun: won't help, npm removed this version's document",
    );
  });
});

describe('package data', () => {
  const name = '\u001b[31mevil\u001b[0m\u009b2J\u202eok';

  function verifyForged(env: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), 'gate-inert-'));
    try {
      const lockfile = join(dir, 'package-lock.json');
      writeFileSync(
        lockfile,
        JSON.stringify({
          lockfileVersion: 3,
          packages: {
            '': { name: 'forged' },
            [`node_modules/${name}`]: { version: '1.0.0\r\nREJECT' },
          },
        }),
      );

      return gate(
        [
          'verify',
          '--lockfile',
          lockfile,
          '--evidence',
          fileURLToPath(evidenceDir),
          '--at',
          '2026-09-26T00:00:00Z',
        ],
        env,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test('a name with escape sequences prints inert', () => {
    const run = verifyForged({});

    expect(run.exitCode).toBe(1);
    expect(run.stdout).not.toMatch(unsafe);
    expect(run.stdout).toContain('\\x1b[31mevil\\x1b[0m\\x9b2J\\u202eok');
    expect(run.stdout).toContain('1.0.0\\r\\nREJECT');
  });

  test('with color forced, only gate emits escape sequences', () => {
    const run = verifyForged({ FORCE_COLOR: '1' });
    const withoutStyles = run.stdout.replaceAll(/\p{Cc}\[[0-9;]*m/gu, '');

    expect(run.stdout).toContain('\u001b[');
    expect(withoutStyles).not.toMatch(unsafe);
    expect(run.stdout).toContain('\\x1b[31mevil\\x1b[0m\\x9b2J\\u202eok');
  });
});

describe('output format', () => {
  const args = [
    'verify',
    '--lockfile',
    waiverLock,
    '--evidence',
    waiverEvidence,
    '--at',
    waiverAt,
  ];

  test('without a terminal, gate prints plain text, not JSON', () => {
    const run = gate(args);

    expect(run.stdout.startsWith('{')).toBe(false);
    expect(run.stdout).not.toContain('\u001b');
    expect(run.exitCode).toBe(1);
  });

  test('FORCE_COLOR turns color on without a terminal, even with NO_COLOR', () => {
    expect(gate(args, { FORCE_COLOR: '1' }).stdout).toContain('\u001b[');
    expect(gate(args, { FORCE_COLOR: '1', NO_COLOR: '1' }).stdout).toContain(
      '\u001b[',
    );
    expect(gate(args, { FORCE_COLOR: '0' }).stdout).not.toContain('\u001b');
  });

  test('--json prints one decision per line and the same exit code', () => {
    const human = gate(args);
    const json = gate([...args, '--json']);

    expect(decisions(json.stdout)).toHaveLength(4);
    expect(json.exitCode).toBe(human.exitCode);
  });
});
