import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  Ed25519NoteVerifier,
  initSync as initSignedNote,
  newEncodedEd25519VerifierKey,
  Note,
  VerifierList,
} from '@cloudflare/signed-note-wasm';
import {
  CheckpointText,
  initSync as initTlogTiles,
  verifyConsistencyProof,
} from '@cloudflare/tlog-tiles-wasm';

const wasm = (specifier: string) =>
  readFileSync(fileURLToPath(import.meta.resolve(specifier)));

initSignedNote({
  module: wasm('@cloudflare/signed-note-wasm/signed_note_wasm_bg.wasm'),
});
initTlogTiles({
  module: wasm('@cloudflare/tlog-tiles-wasm/tlog_tiles_wasm_bg.wasm'),
});

export type TestLogKey = { readonly skey: string; readonly vkey: string };

export function generateTestLogKey(name: string): TestLogKey {
  const jwk = generateKeyPairSync('ed25519').privateKey.export({
    format: 'jwk',
  });
  if (jwk.d === undefined || jwk.x === undefined) {
    throw new Error('ed25519 JWK export lacks d or x');
  }

  const vkey = newEncodedEd25519VerifierKey(
    name,
    Buffer.from(jwk.x, 'base64url'),
  );
  const keyId = vkey.split('+')[1];
  const seed = Buffer.concat([
    Buffer.of(0x01),
    Buffer.from(jwk.d, 'base64url'),
  ]);

  return {
    skey: `PRIVATE+KEY+${name}+${keyId}+${seed.toString('base64')}`,
    vkey,
  };
}

export function oracleCheckpoint(
  signed: Uint8Array,
  vkey: string,
): { origin: string; size: bigint; rootHash: Uint8Array } {
  const verifiers = new VerifierList();
  verifiers.addEd25519(new Ed25519NoteVerifier(vkey));
  verifiers.build();
  const note = Note.fromBytes(signed);
  const result = note.verify(verifiers);
  if (result.verified_count !== 1) {
    throw new Error(`oracle verified ${result.verified_count} signatures`);
  }

  const text = CheckpointText.fromBytes(note.text());

  return {
    origin: text.origin(),
    size: text.size(),
    rootHash: text.rootHash(),
  };
}

type SubtreeHasher = {
  readonly size: number;
  readonly subtreeHash: (start: number, end: number) => Uint8Array;
};

function largestPowerOfTwoBelow(n: number): number {
  let k = 1;
  while (k * 2 < n) {
    k *= 2;
  }

  return k;
}

// RFC 9162 section 2.1.4.1, PROOF(m, D[n]).
export function consistencyProof(
  tree: SubtreeHasher,
  oldSize: number,
): Uint8Array[] {
  const subproof = (
    m: number,
    start: number,
    end: number,
    complete: boolean,
  ): Uint8Array[] => {
    if (m === end - start) {
      return complete ? [] : [tree.subtreeHash(start, end)];
    }

    const k = largestPowerOfTwoBelow(end - start);

    return m <= k
      ? [
          ...subproof(m, start, start + k, complete),
          tree.subtreeHash(start + k, end),
        ]
      : [
          ...subproof(m - k, start + k, end, false),
          tree.subtreeHash(start, start + k),
        ];
  };

  return subproof(oldSize, 0, tree.size, true);
}

export function oracleConsistency(input: {
  proof: readonly Uint8Array[];
  oldSize: bigint;
  oldRoot: Uint8Array;
  newSize: bigint;
  newRoot: Uint8Array;
}): void {
  verifyConsistencyProof(
    Buffer.concat(input.proof),
    input.oldSize,
    input.oldRoot,
    input.newSize,
    input.newRoot,
  );
}
