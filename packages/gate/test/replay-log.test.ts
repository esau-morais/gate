import { afterEach, beforeEach, expect, test } from 'bun:test';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeBundle } from '../src/log/tiles';
import { decodeRecord } from '../src/record';
import { openTree } from '../src/log/log';
import { generateTestLogKey, oracleCheckpoint } from './support/log';
import {
  expectedNodes,
  loadVerifyCases,
  replayLines,
  summarizeMatch,
  summarizeOutput,
  verifyArgs,
} from './verify/cases';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const origin = 'gate.test/decisions';

const tanstack = (() => {
  const found = loadVerifyCases().find(
    ({ name }) => name === 'tanstack-react-router-1.169.8',
  );
  if (found === undefined) {
    throw new Error('the TanStack lockfile case is missing');
  }

  return found;
})();

const evaluation = tanstack.fixture.evaluations[0];

function gate(args: readonly string[]) {
  const run = Bun.spawnSync(['bun', cli, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  return {
    exitCode: run.exitCode,
    stdout: run.stdout.toString(),
    stderr: run.stderr.toString(),
  };
}

let dir = '';
let log = '';

function writeKey(name: string, key = generateTestLogKey(origin)) {
  const skey = join(dir, `${name}.key`);
  const vkey = join(dir, `${name}.vkey`);
  writeFileSync(skey, key.skey, { mode: 0o600 });
  writeFileSync(vkey, key.vkey);

  return { skey, vkey };
}

function verifyInto(logDir: string, skey: string) {
  return gate([
    ...verifyArgs(tanstack.dir, tanstack.fixture, evaluation),
    '--log',
    logDir,
    '--log-key',
    skey,
  ]);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gate-replay-'));
  log = join(dir, 'log');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test('replay reproduces every logged TanStack decision from the log alone', () => {
  const key = writeKey('log');
  const verify = verifyInto(log, key.skey);
  expect(verify.stderr).toBe('');
  expect(verify.exitCode).toBe(evaluation.exitCode);

  const checkpoint = oracleCheckpoint(
    readFileSync(join(log, 'checkpoint')),
    readFileSync(key.vkey, 'utf8'),
  );
  expect(checkpoint.origin).toBe(origin);
  expect(checkpoint.size).toBe(2n);
  expect(Buffer.from(openTree(log, 2).root()).equals(checkpoint.rootHash)).toBe(
    true,
  );

  const replay = gate(['replay', '--log', log, '--public-key', key.vkey]);

  expect(replay.stderr).toBe('');
  const lines = replayLines(replay.stdout);
  expect(lines.map((line) => [line.index, line.result])).toEqual([
    [0, 'match'],
    [1, 'match'],
  ]);
  expect(lines.map(summarizeMatch)).toEqual(expectedNodes(evaluation));
  expect(replay.exitCode).toBe(0);
});

test('an edited entry fails its inclusion proof and replay exits non-zero', () => {
  const key = writeKey('log');
  expect(verifyInto(log, key.skey).stderr).toBe('');

  const bundlePath = join(log, 'tile/entries/000.p/2');
  const bundle = readFileSync(bundlePath);
  const at = bundle.indexOf('"outcome":"REJECT"');
  expect(at).toBeGreaterThan(0);
  bundle.write('"outcome":"ACCEPT"', at);
  writeFileSync(bundlePath, bundle);

  const replay = gate(['replay', '--log', log, '--public-key', key.vkey]);
  const lines = replayLines(replay.stdout);

  expect(lines.map((line) => [line.index, line.result])).toEqual([
    [0, 'match'],
    [1, 'failed'],
  ]);
  const edited = lines[1];
  expect(edited?.result === 'failed' ? edited.error : '').toContain(
    'inclusion',
  );
  expect(replay.exitCode).toBe(1);
});

test('a missing entry bundle fails every entry it held', () => {
  const key = writeKey('log');
  expect(verifyInto(log, key.skey).stderr).toBe('');
  rmSync(join(log, 'tile/entries/000.p/2'));

  const replay = gate(['replay', '--log', log, '--public-key', key.vkey]);

  expect(
    replayLines(replay.stdout).map((line) => [line.index, line.result]),
  ).toEqual([
    [0, 'failed'],
    [1, 'failed'],
  ]);
  expect(replay.exitCode).toBe(1);
});

test('a checkpoint signed by another key with the same name is refused', () => {
  const key = writeKey('log');
  const other = writeKey('other');
  const otherLog = join(dir, 'other-log');
  expect(verifyInto(log, key.skey).stderr).toBe('');
  expect(verifyInto(otherLog, other.skey).stderr).toBe('');
  copyFileSync(join(otherLog, 'checkpoint'), join(log, 'checkpoint'));

  const replay = gate(['replay', '--log', log, '--public-key', key.vkey]);

  expect(replay.stdout).toBe('');
  expect(replay.stderr).toContain('checkpoint');
  expect(replay.exitCode).toBe(1);
});

const setupEdge = {
  kind: 'git' as const,
  name: '@tanstack/setup',
  spec: 'github:tanstack/router#79ac49eedf774dd4b0cfa308722bc463cfe5885c',
};

test('an allowlisted TanStack git edge clears exotic_source, stays quarantined, and its context is logged', () => {
  const key = writeKey('log');
  const context = join(dir, 'context.json');
  writeFileSync(
    context,
    JSON.stringify({ allowedSources: [setupEdge], waivers: [] }),
  );

  const verify = gate([
    ...verifyArgs(tanstack.dir, tanstack.fixture, evaluation),
    '--context',
    context,
    '--log',
    log,
    '--log-key',
    key.skey,
  ]);
  expect(verify.stderr).toBe('');
  expect(summarizeOutput(verify.stdout)).toEqual([
    ...expectedNodes(evaluation).slice(0, 1),
    {
      path: 'node_modules/@tanstack/react-router',
      dependency: '@tanstack/setup',
      outcome: 'QUARANTINE',
      reasons: ['install_scripts_unknown'],
    },
  ]);
  expect(verify.exitCode).toBe(1);

  const logged = decodeBundle(readFileSync(join(log, 'tile/entries/000.p/2')))
    .map(decodeRecord)
    .map((read) => (read.kind === 'read' ? read.record.context : read.error));
  expect(logged).toEqual([
    { allowedSources: [setupEdge], waivers: [] },
    { allowedSources: [setupEdge], waivers: [] },
  ]);

  const replay = gate(['replay', '--log', log, '--public-key', key.vkey]);
  expect(replayLines(replay.stdout).map(summarizeMatch)).toEqual(
    summarizeOutput(verify.stdout),
  );
  expect(replay.exitCode).toBe(0);
});

test('a context file gate cannot decode is refused before anything is logged', () => {
  const key = writeKey('log');
  const context = join(dir, 'context.json');
  for (const bad of [
    {
      allowedSources: [{ ...setupEdge, spec: 'github:tanstack/router#main' }],
      waivers: [],
    },
    { allowedSources: [setupEdge], waivers: [], waiver: [] },
    { allowedSources: [setupEdge] },
  ]) {
    writeFileSync(context, JSON.stringify(bad));
    const verify = gate([
      ...verifyArgs(tanstack.dir, tanstack.fixture, evaluation),
      '--context',
      context,
      '--log',
      log,
      '--log-key',
      key.skey,
    ]);

    expect(verify.stdout).toBe('');
    expect(verify.stderr).toContain('context');
    expect(verify.exitCode).toBe(1);
    expect(existsSync(log)).toBe(false);
  }
});

test('--log without --log-key is refused', () => {
  const verify = gate([
    ...verifyArgs(tanstack.dir, tanstack.fixture, evaluation),
    '--log',
    log,
  ]);

  expect(verify.stderr).toContain('--log-key');
  expect(verify.exitCode).toBe(1);
  expect(existsSync(log)).toBe(false);
});
