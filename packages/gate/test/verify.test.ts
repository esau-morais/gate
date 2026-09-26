import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

function gate(args: readonly string[]) {
  const run = Bun.spawnSync(['bun', cli, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  return {
    exitCode: run.exitCode,
    stderr: run.stderr.toString(),
    nodes: summarizeOutput(run.stdout.toString()),
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
