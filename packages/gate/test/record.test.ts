import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Schema } from 'effect';
import { DecisionContext } from '../src/context';
import { readEvidenceDirectory } from '../src/npm/evidence-directory';
import { readPackageLock } from '../src/npm/lockfile';
import { decisionRecords, verifyNodes } from '../src/npm/verify';
import { decodeRecord, encodeRecord, lockfileDigest } from '../src/record';
import { loadSupplyChainPolicyV2 } from './support/policies';
import { evidenceDir, loadVerifyCases } from './verify/cases';

const context = Schema.decodeUnknownSync(DecisionContext)({
  allowedSources: [
    {
      kind: 'git',
      name: '@tanstack/setup',
      spec: 'github:tanstack/router#79ac49eedf774dd4b0cfa308722bc463cfe5885c',
    },
  ],
  waivers: [
    {
      policy: 'SupplyChainPolicy/v2',
      package: 'vite',
      version: '8.3.0',
      integrity:
        'sha512-lhZBVvEHefgE+HQZC9O7EBJgCU/nVzFNl7vkS4RE0APtWLP02/8QVIkQtzBxPquh7lq5/78NHipTj7ODQ6XuyQ==',
      rule: 'publisher_changed',
      reason: 'reviewed the new workflow',
      author: 'reviewer@example.com',
      expiresAt: '2026-12-01T00:00:00Z',
    },
  ],
});

function recordedRecords() {
  const store = readEvidenceDirectory(fileURLToPath(evidenceDir));
  const policy = loadSupplyChainPolicyV2();

  return loadVerifyCases().flatMap(({ dir, fixture }) => {
    const bytes = readFileSync(new URL(fixture.lockfile, dir));
    const lock = readPackageLock(new TextDecoder().decode(bytes));
    if (lock.kind !== 'read') {
      throw new Error(lock.error);
    }

    return fixture.evaluations.flatMap(({ at }) =>
      decisionRecords({
        records: verifyNodes({ nodes: lock.nodes, store, at, policy, context }),
        context,
        lockfile: lockfileDigest(bytes),
      }),
    );
  });
}

test('re-encoding a decoded record gives identical bytes', () => {
  const records = recordedRecords();
  expect(records.length).toBe(
    loadVerifyCases()
      .flatMap(({ fixture }) => fixture.evaluations)
      .flatMap(({ nodes }) => nodes).length,
  );

  for (const record of records) {
    const bytes = encodeRecord(record);
    const decoded = decodeRecord(bytes);
    if (decoded.kind !== 'read') {
      throw new Error(decoded.error);
    }

    expect(decoded.record).toEqual(record);
    expect(encodeRecord(decoded.record)).toEqual(bytes);
  }
});

test('a record in any other byte form is unreadable', () => {
  const [record] = recordedRecords();
  if (record === undefined) {
    throw new Error('no record');
  }

  const text = new TextDecoder().decode(encodeRecord(record));
  const json: unknown = JSON.parse(text);
  if (typeof json !== 'object' || json === null) {
    throw new Error('record is not an object');
  }

  const atLast = {
    ...Object.fromEntries(Object.entries(json).filter(([key]) => key !== 'at')),
    at: '2026-05-11T20:14:12.000Z',
  };
  const variants = [
    JSON.stringify(json, null, 2),
    `${text}\n`,
    JSON.stringify(atLast),
    text.replace(
      '"at":"2026-05-11T20:14:12.000Z"',
      '"at":"2026-05-11T20:14:12Z"',
    ),
    text.replace('{"allowedSources"', '{"note":"x","allowedSources"'),
    text.replace('"type":"gate.decision/v1"', '"type":"gate.decision/v2"'),
  ];
  expect(new Set(variants).size).toBe(variants.length);
  expect(variants).not.toContain(text);

  for (const variant of variants) {
    expect(decodeRecord(new TextEncoder().encode(variant)).kind).toBe(
      'unreadable',
    );
  }
});

test('lockfile digests name the bytes, not the parsed lockfile', () => {
  expect<string>(lockfileDigest(new TextEncoder().encode('{}'))).toBe(
    'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
  );
});
