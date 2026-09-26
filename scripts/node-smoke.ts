import { writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  expectedNodes,
  loadVerifyCases,
  replayLines,
  summarizeMatch,
  summarizeOutput,
  verifyArgs,
} from '../packages/gate/test/verify/cases';
import { generateTestLogKey } from '../packages/gate/test/support/log';

const outdir = await mkdtemp(join(tmpdir(), 'gate-node-smoke-'));

try {
  const build = await Bun.build({
    entrypoints: [
      'packages/cel/src/index.ts',
      'packages/gate/src/index.ts',
      'packages/gate/src/cli.ts',
    ],
    target: 'node',
    outdir,
    root: 'packages',
  });
  if (!build.success) {
    throw new AggregateError(build.logs, 'bundling for Node failed');
  }

  const cel = pathToFileURL(join(outdir, 'cel/src/index.js')).href;
  const gate = pathToFileURL(join(outdir, 'gate/src/index.js')).href;
  const policy = join(
    import.meta.dir,
    '../packages/gate/policies/supply-chain-policy-v1.json',
  );
  const script = `
    import { readFileSync } from 'node:fs';
    import { evaluate } from ${JSON.stringify(cel)};
    import * as gate from ${JSON.stringify(gate)};
    const deps = JSON.parse('{"constructor":"1.0.0","left-pad":"1.3.0"}');
    const checks = [
      ["size(deps) == 2 && 'constructor' in deps", { deps }],
      ["int('9223372036854775807') == 9223372036854775807", {}],
      ["string(b'\\\\303\\\\277') == 'ÿ'", {}],
      ["timestamp('2026-01-01T00:00:00Z') + duration('1h') > timestamp('2026-01-01T00:00:00Z')", {}],
    ];
    for (const [expr, context] of checks) {
      if (evaluate(expr, context) !== true) throw new Error('failed on Node: ' + expr);
    }
    const canonical = gate.loadPolicy(readFileSync(${JSON.stringify(policy)}), gate.supplyChainPolicyV1Digest);
    const version = (v, time) => ({ version: v, time: new Date(time), integrity: 'sha512-' + 'A'.repeat(86) + '==', provenance: { kind: 'absent' }, npmUser: 'm', scripts: {} });
    const evidence = gate.npmVersionEvidence({
      name: 'lib', registry: 'https://registry.npmjs.org',
      target: version('1.1.0', '2026-01-02T00:00:00Z'), earlier: [version('1.0.0', '2025-12-01T00:00:00Z')],
      feeds: { kind: 'checked', hits: [] }, claims: [],
    });
    const decision = gate.decide({ evidence, now: new Date('2026-01-02T01:00:00Z'), context: { allowedSources: [], waivers: [] }, canonical });
    if (decision.outcome !== 'QUARANTINE' || decision.reasons.map((r) => r.code).join() !== 'release_age') {
      throw new Error('policy decision differs on Node: ' + JSON.stringify(decision));
    }
    console.log('@gate/cel and @gate/gate bundles ok on Node ' + process.version);
  `;
  const node = Bun.spawnSync(['node', '--input-type=module', '-e', script], {
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if (node.exitCode !== 0) {
    process.exitCode = 1;
  }

  const cli = join(outdir, 'gate/src/cli.js');
  for (const { name, dir, fixture } of loadVerifyCases()) {
    for (const evaluation of fixture.evaluations) {
      const run = Bun.spawnSync(
        ['node', cli, ...verifyArgs(dir, fixture, evaluation)],
        { stdout: 'pipe', stderr: 'inherit' },
      );
      const actual = summarizeOutput(run.stdout.toString());
      if (
        run.exitCode !== evaluation.exitCode ||
        JSON.stringify(actual) !== JSON.stringify(expectedNodes(evaluation))
      ) {
        console.error(
          `gate verify differs on Node for ${name} at ${evaluation.at.toISOString()}: exit ${run.exitCode}`,
          actual,
        );
        process.exitCode = 1;
      }
    }
  }

  if (process.exitCode !== 1) {
    console.log('gate verify bundle replays every lockfile case on Node');
  }

  const key = generateTestLogKey('gate.test/node-smoke');
  const skey = join(outdir, 'log.key');
  const vkey = join(outdir, 'log.vkey');
  const log = join(outdir, 'log');
  writeFileSync(skey, key.skey, { mode: 0o600 });
  writeFileSync(vkey, key.vkey);
  const logged = loadVerifyCases().flatMap(({ dir, fixture }) =>
    fixture.evaluations.map((evaluation) => {
      const run = Bun.spawnSync(
        [
          'node',
          cli,
          ...verifyArgs(dir, fixture, evaluation),
          '--log',
          log,
          '--log-key',
          skey,
        ],
        { stdout: 'pipe', stderr: 'inherit' },
      );
      if (run.exitCode !== evaluation.exitCode) {
        console.error(`gate verify --log failed on Node: exit ${run.exitCode}`);
        process.exitCode = 1;
      }

      return summarizeOutput(run.stdout.toString());
    }),
  );
  const expected = JSON.stringify(
    logged.flat().map((node) => ({ result: 'match', ...node })),
  );
  const runtimes = [
    ['node', cli],
    ['bun', 'packages/gate/src/cli.ts'],
  ];
  for (const runtime of runtimes) {
    const run = Bun.spawnSync(
      [...runtime, 'replay', '--log', log, '--public-key', vkey],
      { stdout: 'pipe', stderr: 'inherit' },
    );
    const replayed = replayLines(run.stdout.toString()).map((line) => ({
      result: line.result,
      ...summarizeMatch(line),
    }));
    if (run.exitCode !== 0 || JSON.stringify(replayed) !== expected) {
      console.error(
        `gate replay under ${runtime[0]} differs from the decisions Node logged: exit ${run.exitCode}`,
        replayed,
      );
      process.exitCode = 1;
    }
  }

  if (process.exitCode !== 1) {
    console.log(
      'gate replay verifies a log written on Node, under Node and Bun',
    );
  }
} finally {
  await rm(outdir, { recursive: true, force: true });
}
