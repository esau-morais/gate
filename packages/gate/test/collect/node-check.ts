import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { noContext } from '../../src/context';
import { collectEvidence } from '../../src/npm/collect';
import { readEvidenceDirectory } from '../../src/npm/evidence-directory';
import { readPackageLock } from '../../src/npm/lockfile';
import { verifyExitCode, verifyNodes } from '../../src/npm/verify';
import { canonicalPolicy } from '../../src/pinned-policies';
import {
  expectedNodes,
  loadVerifyCases,
  recordedEvidence,
} from '../verify/cases';
import { fakeNetwork, recordedRoutes } from './recorded';

const [testDir] = process.argv.slice(2);
if (testDir === undefined) {
  throw new Error('usage: node-check <packages/gate/test directory>');
}

const root = pathToFileURL(`${testDir}/`);
const evidence = new URL('verify/evidence/', root);
const failures: string[] = [];

for (const { name, dir, fixture } of loadVerifyCases(
  new URL('verify/cases/', root),
)) {
  const cache = mkdtempSync(join(tmpdir(), 'gate-node-collect-'));
  try {
    const lock = readPackageLock(
      readFileSync(new URL(fixture.lockfile, dir), 'utf8'),
    );
    if (lock.kind !== 'read') {
      throw new Error(lock.error);
    }

    const network = fakeNetwork(
      recordedRoutes(evidence, new URL('collect/', root)),
      () => Promise.resolve(recordedEvidence('trusted_root.json', evidence)),
    );
    const collected = await collectEvidence({
      nodes: lock.nodes,
      cacheDir: cache,
      sources: network.sources,
    });
    for (const evaluation of fixture.evaluations) {
      const records = verifyNodes({
        nodes: lock.nodes,
        store: readEvidenceDirectory(collected.dir),
        at: evaluation.at,
        policy: canonicalPolicy(),
        context: noContext,
      });
      const actual = records.map((record) =>
        record.kind === 'decision'
          ? {
              path: record.path,
              ...(record.dependency === undefined
                ? {}
                : { dependency: record.dependency }),
              outcome: record.outcome,
              reasons: record.reasons.map((reason) => reason.code).toSorted(),
            }
          : { path: record.path, unreadable: record.error },
      );
      if (
        JSON.stringify(actual) !== JSON.stringify(expectedNodes(evaluation)) ||
        verifyExitCode(records) !== evaluation.exitCode
      ) {
        failures.push(
          `${name} at ${evaluation.at.toISOString()}: ${JSON.stringify(actual)}`,
        );
      }
    }
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
}

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(
    `collect then verify matches every lockfile case on Node ${process.version}`,
  );
}
