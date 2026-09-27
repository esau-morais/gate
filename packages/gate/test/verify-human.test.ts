import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Schema } from 'effect';
import { Waiver } from '../src/context';
import { evidenceDir } from './verify/cases';

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

const unsafe = /(?!\n)[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

describe('printed waivers', () => {
  const args = [
    'verify',
    '--lockfile',
    waiverLock,
    '--evidence',
    waiverEvidence,
    '--at',
    waiverAt,
  ];
  const human = gate(args);

  for (const [rule, name] of [
    ['publisher_changed', 'encodeurl'],
    ['publisher_recent', 'cookie'],
    ['trust_downgrade', 'rxjs'],
    ['new_install_script', 'unrs-resolver'],
  ] as const) {
    test(`the ${rule} waiver decodes and clears ${rule} on the same evidence`, () => {
      const path = `node_modules/${name}`;
      const before = decisions(gate([...args, '--json']).stdout).find(
        (line) => line.path === path,
      );
      expect(before?.reasons).toEqual([{ kind: 'fired', code: rule }]);

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
          gate([...args, '--json', '--context', context]).stdout,
        ).find((line) => line.path === path);

        expect(after?.outcome).toBe('ACCEPT');
        expect(after?.reasons).toEqual([{ kind: 'waived', code: rule }]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
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
