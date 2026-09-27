import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  evidenceDir,
  expectedNodes,
  loadVerifyCases,
  replayLines,
  summarizeMatch,
  summarizeOutput,
  verifyArgs,
} from '../packages/gate/test/verify/cases';
import { generateTestLogKey } from '../packages/gate/test/support/log';
import {
  recordedPnpmLockPath,
  recordedPnpmWorkspacePath,
} from '../packages/gate/test/pnpm/locks';
import { recordedLockPath } from '../packages/gate/test/workspaces/locks';

const outdir = await mkdtemp(join(tmpdir(), 'gate-node-smoke-'));

try {
  const build = await Bun.build({
    entrypoints: [
      'packages/cel/src/index.ts',
      'packages/gate/src/index.ts',
      'packages/gate/src/cli.ts',
      'packages/gate/test/collect/node-check.ts',
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

  const waivers = join(import.meta.dir, '../packages/gate/test/waivers');
  const reports = [
    ...loadVerifyCases().flatMap(({ dir, fixture }) =>
      fixture.evaluations.map((evaluation) =>
        verifyArgs(dir, fixture, evaluation).filter((arg) => arg !== '--json'),
      ),
    ),
    [
      'verify',
      '--lockfile',
      join(waivers, 'package-lock.json'),
      '--evidence',
      join(waivers, 'evidence'),
      '--at',
      '2026-09-27T00:05:21.915Z',
    ],
  ];
  for (const args of reports) {
    const [onNode, onBun] = [
      ['node', cli],
      ['bun', 'packages/gate/src/cli.ts'],
    ].map((runtime) =>
      Bun.spawnSync([...runtime, ...args], {
        stdout: 'pipe',
        stderr: 'inherit',
      }),
    );
    const report = onNode?.stdout.toString() ?? '';
    if (
      !report.startsWith('gate verify: ') ||
      report !== onBun?.stdout.toString() ||
      onNode?.exitCode !== onBun.exitCode
    ) {
      console.error(
        `gate verify prints a different report on Node and Bun for ${args.join(' ')}`,
        report,
      );
      process.exitCode = 1;
    }
  }

  if (process.exitCode !== 1) {
    console.log('gate verify prints the same report on Node and Bun');
  }

  const repo = join(outdir, 'npm-cli');
  mkdirSync(repo);
  copyFileSync(recordedLockPath('npm-cli'), join(repo, 'package-lock.json'));
  const workspaces = Bun.spawnSync(
    [
      'node',
      cli,
      'verify',
      '--evidence',
      fileURLToPath(evidenceDir),
      '--at',
      '2026-09-26T00:00:00Z',
      '--json',
    ],
    { cwd: repo, stdout: 'pipe', stderr: 'inherit' },
  );
  if (workspaces.exitCode !== 0 || workspaces.stdout.toString() !== '') {
    console.error(
      `gate verify of ./package-lock.json with npm/cli's workspaces differs on Node: exit ${workspaces.exitCode}`,
      workspaces.stdout.toString(),
    );
    process.exitCode = 1;
  } else {
    console.log(
      "gate verify reads ./package-lock.json and passes npm/cli's workspace links on Node",
    );
  }

  const pnpmRepo = join(outdir, 'vuejs-core');
  mkdirSync(pnpmRepo);
  copyFileSync(
    recordedPnpmLockPath('vuejs-core'),
    join(pnpmRepo, 'pnpm-lock.yaml'),
  );
  const pnpmArgs = [
    'verify',
    '--evidence',
    fileURLToPath(evidenceDir),
    '--at',
    '2026-09-23T12:17:15Z',
    '--json',
  ];
  const runPnpm = (runtime: readonly string[]) =>
    Bun.spawnSync([...runtime, ...pnpmArgs], {
      cwd: pnpmRepo,
      stdout: 'pipe',
      stderr: 'inherit',
    });
  const pnpmNode = runPnpm(['node', cli]);
  const pnpmBun = runPnpm([
    'bun',
    join(import.meta.dir, '../packages/gate/src/cli.ts'),
  ]);
  const vite = summarizeOutput(pnpmNode.stdout.toString()).find((node) =>
    node.path.startsWith('vite@8.3.0('),
  );
  if (
    pnpmNode.stdout.toString() !== pnpmBun.stdout.toString() ||
    pnpmNode.exitCode !== pnpmBun.exitCode ||
    vite === undefined ||
    !('outcome' in vite) ||
    vite.outcome !== 'ACCEPT'
  ) {
    console.error(
      `gate verify of ./pnpm-lock.yaml from vuejs/core differs on Node: exit ${pnpmNode.exitCode}`,
      pnpmNode.stdout.toString(),
    );
    process.exitCode = 1;
  } else {
    console.log(
      "gate verify reads vuejs/core's ./pnpm-lock.yaml on Node as on Bun and accepts vite",
    );
  }

  const configRepo = join(outdir, 'rules-js-v101');
  mkdirSync(configRepo);
  copyFileSync(
    recordedPnpmLockPath('rules-js-v101'),
    join(configRepo, 'pnpm-lock.yaml'),
  );
  copyFileSync(
    recordedPnpmWorkspacePath('rules-js'),
    join(configRepo, 'pnpm-workspace.yaml'),
  );
  const runConfig = (runtime: readonly string[]) =>
    Bun.spawnSync([...runtime, ...pnpmArgs], {
      cwd: configRepo,
      stdout: 'pipe',
      stderr: 'inherit',
    });
  const configNode = runConfig(['node', cli]);
  const configBun = runConfig([
    'bun',
    join(import.meta.dir, '../packages/gate/src/cli.ts'),
  ]);
  const semver = summarizeOutput(configNode.stdout.toString()).filter(
    (node) => node.path === 'pnpm-workspace.yaml',
  );
  if (
    configNode.stdout.toString() !== configBun.stdout.toString() ||
    configNode.exitCode !== configBun.exitCode ||
    semver.length !== 1 ||
    semver[0]?.dependency !== 'semver' ||
    !('outcome' in semver[0])
  ) {
    console.error(
      `gate verify of rules_js's pnpm 10 config dependencies differs on Node: exit ${configNode.exitCode}`,
      semver,
    );
    process.exitCode = 1;
  } else {
    console.log(
      "gate verify decides rules_js's pnpm-workspace.yaml config dependency on Node as on Bun",
    );
  }

  const collect = Bun.spawnSync(
    [
      'node',
      join(outdir, 'gate/test/collect/node-check.js'),
      join(import.meta.dir, '../packages/gate/test'),
    ],
    { stdout: 'inherit', stderr: 'inherit' },
  );
  if (collect.exitCode !== 0) {
    process.exitCode = 1;
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
