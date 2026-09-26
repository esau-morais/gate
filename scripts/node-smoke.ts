import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  expectedNodes,
  loadVerifyCases,
  summarizeOutput,
  verifyArgs,
} from '../packages/gate/test/verify/cases';

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
    const version = (v, time) => ({ version: v, time: new Date(time), integrity: 'sha512-' + 'A'.repeat(86) + '==', provenance: 'absent', npmUser: 'm', scripts: {} });
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
} finally {
  await rm(outdir, { recursive: true, force: true });
}
