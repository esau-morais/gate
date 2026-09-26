import { afterEach, beforeEach, expect, test } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Schema } from 'effect';
import { appendToLog, openTree, readLog } from '../src/log/log';
import { hashChildren, hashLeaf, verifyInclusion } from '../src/log/merkle';
import { parseSignerKey, parseVerifierKey } from '../src/log/note';
import { entryBundlePath, tilePath } from '../src/log/tiles';
import {
  consistencyProof,
  generateTestLogKey,
  oracleCheckpoint,
  oracleConsistency,
} from './support/log';

const origin = 'gate.test/log';
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const fromHex = (text: string) => Uint8Array.from(Buffer.from(text, 'hex'));
const fromBase64 = (text: string) =>
  Uint8Array.from(Buffer.from(text, 'base64'));

const Base64 = Schema.String;
const Vectors = Schema.Struct({
  leafInputs: Schema.Array(Schema.String),
  rootHashes: Schema.Array(Schema.String),
  inclusion: Schema.Array(
    Schema.Struct({
      leafIdx: Schema.Int,
      treeSize: Schema.Int,
      root: Base64,
      leafHash: Base64,
      proof: Schema.Array(Base64),
      wantErr: Schema.Boolean,
    }),
  ),
});
const vectors = Schema.decodeUnknownSync(Schema.fromJsonString(Vectors))(
  readFileSync(new URL('./log/rfc6962-vectors.json', import.meta.url), 'utf8'),
);
const leaves = vectors.leafInputs.map(fromHex);

let dir = '';
let key = generateTestLogKey(origin);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gate-log-'));
  key = generateTestLogKey(origin);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const signer = () => parseSignerKey(key.skey);
const checkpointBytes = () => readFileSync(join(dir, 'checkpoint'));
const indexEntry = (index: number) => {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, index);

  return bytes;
};

test('tile and bundle paths follow the tlog-tiles encoding', () => {
  expect(tilePath({ level: 0, index: 1234067, width: 256 })).toBe(
    'tile/0/x001/x234/067',
  );
  expect(tilePath({ level: 2, index: 0, width: 1 })).toBe('tile/2/000.p/1');
  expect(entryBundlePath({ index: 273, width: 112 })).toBe(
    'tile/entries/273.p/112',
  );
});

test('each checkpoint of a log grown one entry at a time has the RFC 6962 root', () => {
  for (const [size, leaf] of leaves.entries()) {
    appendToLog({ dir, signer: signer(), entries: [leaf] });
    const checkpoint = oracleCheckpoint(checkpointBytes(), key.vkey);

    expect(checkpoint.origin).toBe(origin);
    expect(checkpoint.size).toBe(BigInt(size + 1));
    expect(hex(checkpoint.rootHash)).toBe(vectors.rootHashes[size + 1] ?? '');
  }
});

test('the root of a log past one full tile is the RFC 6962 hash of its entries', () => {
  const entries = Array.from({ length: 600 }, (_, index) => indexEntry(index));
  const leafHashes = entries.map(hashLeaf);
  const mth = (start: number, end: number): Uint8Array => {
    if (end - start === 1) {
      return leafHashes[start] ?? new Uint8Array();
    }

    let k = 1;
    while (k * 2 < end - start) {
      k *= 2;
    }

    return hashChildren(mth(start, start + k), mth(start + k, end));
  };

  appendToLog({ dir, signer: signer(), entries: entries.slice(0, 300) });
  appendToLog({ dir, signer: signer(), entries: entries.slice(300) });

  expect(hex(oracleCheckpoint(checkpointBytes(), key.vkey).rootHash)).toBe(
    hex(mth(0, 600)),
  );
});

test('an empty append signs the empty tree', () => {
  appendToLog({ dir, signer: signer(), entries: [] });
  const checkpoint = oracleCheckpoint(checkpointBytes(), key.vkey);

  expect(checkpoint.size).toBe(0n);
  expect(hex(checkpoint.rootHash)).toBe(vectors.rootHashes[0] ?? '');
});

test('inclusion proofs built from tiles match the transparency-dev vectors', () => {
  for (const vector of vectors.inclusion) {
    const leafHash = fromBase64(vector.leafHash);
    const proof = vector.proof.map(fromBase64);
    const root = fromBase64(vector.root);

    expect(
      verifyInclusion({
        index: vector.leafIdx,
        size: vector.treeSize,
        leafHash,
        proof,
        root,
      }),
    ).toBe(!vector.wantErr);
    if (vector.wantErr) {
      continue;
    }

    const caseDir = join(dir, `case-${vector.treeSize}-${vector.leafIdx}`);
    appendToLog({
      dir: caseDir,
      signer: signer(),
      entries: leaves.slice(0, vector.treeSize),
    });
    const tree = openTree(caseDir, vector.treeSize);

    expect(tree.inclusionProof(vector.leafIdx).map(hex)).toEqual(
      proof.map(hex),
    );
    expect(hex(tree.root())).toBe(hex(root));
  }
});

test("a 70,000-entry log has the spec's tile layout and stays consistent", () => {
  const sizes = [1, 255, 256, 257, 1000, 65536, 70000];
  const checkpoints: { size: bigint; rootHash: Uint8Array }[] = [];
  let size = 0;
  for (const next of sizes) {
    appendToLog({
      dir,
      signer: signer(),
      entries: Array.from({ length: next - size }, (_, offset) =>
        indexEntry(size + offset),
      ),
    });
    size = next;
    checkpoints.push(oracleCheckpoint(checkpointBytes(), key.vkey));
  }

  const width = (path: string) => statSync(join(dir, path)).size / 32;
  for (let index = 0; index < 273; index += 1) {
    expect(width(tilePath({ level: 0, index, width: 256 }))).toBe(256);
    expect(existsSync(join(dir, entryBundlePath({ index, width: 256 })))).toBe(
      true,
    );
  }

  expect(width('tile/0/273.p/112')).toBe(112);
  expect(width('tile/1/000')).toBe(256);
  expect(width('tile/1/001.p/17')).toBe(17);
  expect(width('tile/2/000.p/1')).toBe(1);
  expect(existsSync(join(dir, 'tile/2/000'))).toBe(false);
  expect(existsSync(join(dir, 'tile/entries/273.p/112'))).toBe(true);

  const tree = openTree(dir, 70000);
  const latest = checkpoints.at(-1);
  if (latest === undefined) {
    throw new Error('no checkpoint');
  }

  for (const earlier of checkpoints.slice(0, -1)) {
    oracleConsistency({
      proof: consistencyProof(tree, Number(earlier.size)),
      oldSize: earlier.size,
      oldRoot: earlier.rootHash,
      newSize: latest.size,
      newRoot: latest.rootHash,
    });
  }

  for (const index of [0, 255, 256, 65535, 65536, 69999]) {
    expect(
      verifyInclusion({
        index,
        size: 70000,
        leafHash: hashLeaf(indexEntry(index)),
        proof: tree.inclusionProof(index),
        root: latest.rootHash,
      }),
    ).toBe(true);
  }
});

test('entry bundles hold uint16 length-prefixed entries and refuse larger ones', () => {
  appendToLog({
    dir,
    signer: signer(),
    entries: [fromHex('61'), fromHex('6263')],
  });

  expect(hex(readFileSync(join(dir, 'tile/entries/000.p/2')))).toBe(
    '00016100026263',
  );

  const before = checkpointBytes();
  expect(() =>
    appendToLog({ dir, signer: signer(), entries: [new Uint8Array(65536)] }),
  ).toThrow('65535');
  expect(checkpointBytes()).toEqual(before);
});

test('append refuses a log whose tiles no longer match its checkpoint', () => {
  appendToLog({ dir, signer: signer(), entries: leaves.slice(0, 3) });
  const tile = join(dir, 'tile/0/000.p/3');
  const bytes = readFileSync(tile);
  bytes[0] = (bytes[0] ?? 0) ^ 1;
  writeFileSync(tile, bytes);

  expect(() =>
    appendToLog({ dir, signer: signer(), entries: leaves.slice(3) }),
  ).toThrow('checkpoint');
});

test('append refuses a log whose entries no longer match their tile', () => {
  appendToLog({ dir, signer: signer(), entries: leaves.slice(1, 4) });
  const bundle = join(dir, 'tile/entries/000.p/3');
  const bytes = readFileSync(bundle);
  bytes[2] = (bytes[2] ?? 0) ^ 1;
  writeFileSync(bundle, bytes);

  expect(() =>
    appendToLog({ dir, signer: signer(), entries: leaves.slice(4) }),
  ).toThrow('entry');
});

test('append refuses a checkpoint signed by another key', () => {
  appendToLog({ dir, signer: signer(), entries: leaves.slice(0, 2) });
  const other = parseSignerKey(generateTestLogKey(origin).skey);

  expect(() =>
    appendToLog({ dir, signer: other, entries: leaves.slice(2) }),
  ).toThrow('checkpoint');
});

test('a second writer is refused while the lock is held', () => {
  appendToLog({ dir, signer: signer(), entries: leaves.slice(0, 1) });
  writeFileSync(join(dir, 'lock'), '');

  expect(() =>
    appendToLog({ dir, signer: signer(), entries: leaves.slice(1) }),
  ).toThrow('lock');
  expect(existsSync(join(dir, 'lock'))).toBe(true);
  expect(oracleCheckpoint(checkpointBytes(), key.vkey).size).toBe(1n);
});

test('the signing key never reaches the log', () => {
  appendToLog({ dir, signer: signer(), entries: leaves });
  const encodedSeed = key.skey.split('+').slice(4).join('+');
  const seed = Buffer.from(encodedSeed, 'base64').subarray(1);
  expect(seed.length).toBe(32);

  const files = readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .map((path) => join(dir, path))
    .filter((path) => statSync(path).isFile());
  expect(files.length).toBeGreaterThan(0);
  for (const path of files) {
    const bytes = readFileSync(path);
    expect(bytes.includes(seed)).toBe(false);
    expect(bytes.includes(encodedSeed)).toBe(false);
    expect(bytes.includes('PRIVATE')).toBe(false);
  }
});

test('readLog proves every entry against the signed checkpoint', () => {
  appendToLog({ dir, signer: signer(), entries: leaves.slice(0, 5) });
  appendToLog({ dir, signer: signer(), entries: leaves.slice(5) });
  const log = readLog({ dir, verifier: parseVerifierKey(key.vkey) });
  if (log.kind !== 'read') {
    throw new Error(log.error);
  }

  expect(log.checkpoint.size).toBe(8);
  expect(
    log
      .entries()
      .map((entry) =>
        entry.kind === 'included' ? hex(entry.bytes) : entry.error,
      ),
  ).toEqual([...vectors.leafInputs]);
});

test('readLog refuses a log with no checkpoint or another key', () => {
  expect(readLog({ dir, verifier: parseVerifierKey(key.vkey) }).kind).toBe(
    'unreadable',
  );

  appendToLog({ dir, signer: signer(), entries: leaves });
  const other = parseVerifierKey(generateTestLogKey(origin).vkey);
  expect(readLog({ dir, verifier: other }).kind).toBe('unreadable');
});
