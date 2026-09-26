/*
Copyright 2023 The Sigstore Authors.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

// Ported from sigstore-js packages/verify/src/tlog/merkle.ts at
// 769a53d8713248a8bf49edfc2a5d1955b0dcc24d. Changed for gate: takes the leaf
// hash, proof and root directly instead of a Rekor bundle, returns a boolean
// instead of throwing, uses node:crypto, and adds the empty-tree root.

import { createHash } from 'node:crypto';

const leafPrefix = Uint8Array.of(0x00);
const nodePrefix = Uint8Array.of(0x01);

export const emptyRoot: Uint8Array = createHash('sha256').digest();

export function hashLeaf(entry: Uint8Array): Uint8Array {
  return createHash('sha256').update(leafPrefix).update(entry).digest();
}

export function hashChildren(left: Uint8Array, right: Uint8Array): Uint8Array {
  return createHash('sha256')
    .update(nodePrefix)
    .update(left)
    .update(right)
    .digest();
}

export function sameHash(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

export function verifyInclusion(input: {
  index: number;
  size: number;
  leafHash: Uint8Array;
  proof: readonly Uint8Array[];
  root: Uint8Array;
}): boolean {
  if (!Number.isSafeInteger(input.index) || !Number.isSafeInteger(input.size)) {
    return false;
  }

  const index = BigInt(input.index);
  const size = BigInt(input.size);
  if (index < 0n || index >= size) {
    return false;
  }

  const { inner, border } = decompInclProof(index, size);
  if (input.proof.length !== inner + border) {
    return false;
  }

  const calculated = chainBorderRight(
    chainInner(input.leafHash, input.proof.slice(0, inner), index),
    input.proof.slice(inner),
  );

  return sameHash(calculated, input.root);
}

function decompInclProof(
  index: bigint,
  size: bigint,
): { inner: number; border: number } {
  const inner = innerProofSize(index, size);
  const border = onesCount(index >> BigInt(inner));

  return { inner, border };
}

function chainInner(
  seed: Uint8Array,
  hashes: readonly Uint8Array[],
  index: bigint,
): Uint8Array {
  return hashes.reduce(
    (acc, h, i) =>
      ((index >> BigInt(i)) & 1n) === 1n
        ? hashChildren(h, acc)
        : hashChildren(acc, h),
    seed,
  );
}

function chainBorderRight(
  seed: Uint8Array,
  hashes: readonly Uint8Array[],
): Uint8Array {
  return hashes.reduce((acc, h) => hashChildren(h, acc), seed);
}

function innerProofSize(index: bigint, size: bigint): number {
  return bitLength(index ^ (size - 1n));
}

function onesCount(num: bigint): number {
  return num.toString(2).split('1').length - 1;
}

function bitLength(n: bigint): number {
  if (n === 0n) {
    return 0;
  }

  return n.toString(2).length;
}
