/*
Copyright 2025 The Sigstore Authors.

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

// Ported from sigstore-js packages/verify/src/tlog/checkpoint.ts at
// 769a53d8713248a8bf49edfc2a5d1955b0dcc24d. Changed for gate to follow
// c2sp.org/signed-note and c2sp.org/tlog-checkpoint strictly: the text ends
// at the last blank line, every signature line must parse, a signature counts
// only when its key name and computed key ID both match, and the checkpoint
// size, root and extension lines are validated. Adds Ed25519 signing, and
// signer and verifier keys in the golang.org/x/mod/sumdb/note encoding.

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';

export class NoteError extends Error {
  override readonly name = 'NoteError';
}

const ed25519 = 0x01;
const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
const pkcs8Prefix = Buffer.from('302e020100300506032b657004220420', 'hex');
const maxNoteBytes = 1 << 20;
const maxSignatures = 100;

export type NoteVerifier = {
  readonly name: string;
  readonly keyId: number;
  readonly key: KeyObject;
  readonly encoded: string;
};

export type NoteSigner = {
  readonly name: string;
  readonly keyId: number;
  readonly key: KeyObject;
  readonly verifier: NoteVerifier;
};

function isKeyName(name: string): boolean {
  return name !== '' && !/[\s\u0085+\p{Cc}]/u.test(name);
}

function decodeBase64(text: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) {
    return undefined;
  }

  const bytes = Buffer.from(text, 'base64');

  return bytes.toString('base64') === text ? Uint8Array.from(bytes) : undefined;
}

const toBase64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

function computeKeyId(name: string, keyData: Uint8Array): number {
  return createHash('sha256')
    .update(`${name}\n`)
    .update(keyData)
    .digest()
    .readUInt32BE(0);
}

const hexId = (keyId: number) => keyId.toString(16).padStart(8, '0');

function ed25519KeyData(text: string | undefined): Uint8Array {
  const data = text === undefined ? undefined : decodeBase64(text);
  if (data?.length !== 33 || data[0] !== ed25519) {
    throw new NoteError('key data is not an Ed25519 key');
  }

  return data;
}

function checkedId(name: string, id: string | undefined, keyData: Uint8Array) {
  if (!isKeyName(name)) {
    throw new NoteError(`invalid key name ${JSON.stringify(name)}`);
  }

  const keyId = computeKeyId(name, keyData);
  if (id === undefined || !/^[0-9a-f]{8}$/.test(id) || id !== hexId(keyId)) {
    throw new NoteError(`key ID for ${name} does not match its key`);
  }

  return keyId;
}

function verifierFrom(name: string, keyId: number, keyData: Uint8Array) {
  return {
    name,
    keyId,
    key: createPublicKey({
      key: Buffer.concat([spkiPrefix, keyData.subarray(1)]),
      format: 'der',
      type: 'spki',
    }),
    encoded: `${name}+${hexId(keyId)}+${toBase64(keyData)}`,
  };
}

function cutFields(text: string, fields: number): string[] | undefined {
  const parts: string[] = [];
  let rest = text;
  while (parts.length < fields - 1) {
    const plus = rest.indexOf('+');
    if (plus < 0) {
      return undefined;
    }

    parts.push(rest.slice(0, plus));
    rest = rest.slice(plus + 1);
  }

  return [...parts, rest];
}

export function parseVerifierKey(text: string): NoteVerifier {
  const parts = cutFields(text, 3);
  if (parts === undefined) {
    throw new NoteError('a verifier key has three parts separated by +');
  }

  const [name = '', id, data] = parts;
  const keyData = ed25519KeyData(data);

  return verifierFrom(name, checkedId(name, id, keyData), keyData);
}

export function parseSignerKey(text: string): NoteSigner {
  const parts = cutFields(text, 5);
  if (parts?.[0] !== 'PRIVATE' || parts[1] !== 'KEY') {
    throw new NoteError('a signer key reads PRIVATE+KEY+<name>+<id>+<key>');
  }

  const [, , name = '', id, data] = parts;
  const seed = ed25519KeyData(data).subarray(1);
  const key = createPrivateKey({
    key: Buffer.concat([pkcs8Prefix, seed]),
    format: 'der',
    type: 'pkcs8',
  });
  const publicKey = createPublicKey(key)
    .export({ format: 'der', type: 'spki' })
    .subarray(spkiPrefix.length);
  const keyData = Buffer.concat([Uint8Array.of(ed25519), publicKey]);
  const keyId = checkedId(name, id, keyData);

  return { name, keyId, key, verifier: verifierFrom(name, keyId, keyData) };
}

function checkNoteText(text: string): void {
  if (!text.endsWith('\n')) {
    throw new NoteError('note text must end with a newline');
  }

  if ([...text].some((char) => char < ' ' && char !== '\n')) {
    throw new NoteError('note contains a control character');
  }
}

export function signNote(text: string, signer: NoteSigner): Uint8Array {
  checkNoteText(text);
  const message = new TextEncoder().encode(text);
  const keyId = Buffer.alloc(4);
  keyId.writeUInt32BE(signer.keyId);
  const signature = Buffer.concat([keyId, sign(null, message, signer.key)]);

  return new TextEncoder().encode(
    `${text}\n— ${signer.name} ${toBase64(signature)}\n`,
  );
}

type Signature = {
  readonly name: string;
  readonly keyId: number;
  readonly signature: Uint8Array;
};

function parseSignatureLine(line: string): Signature {
  const match = /^— ([^ ]+) ([^ ]+)$/.exec(line);
  const bytes = match?.[2] === undefined ? undefined : decodeBase64(match[2]);
  const name = match?.[1];
  if (name === undefined || !isKeyName(name) || bytes === undefined) {
    throw new NoteError('malformed signature line');
  }

  if (bytes.length < 5) {
    throw new NoteError('malformed signature line');
  }

  return {
    name,
    keyId: Buffer.from(bytes).readUInt32BE(0),
    signature: bytes.subarray(4),
  };
}

export function openNote(bytes: Uint8Array, verifier: NoteVerifier): string {
  if (bytes.length > maxNoteBytes) {
    throw new NoteError('note is too large');
  }

  let note: string;
  try {
    note = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new NoteError('note is not valid UTF-8');
  }

  checkNoteText(note);
  const split = note.lastIndexOf('\n\n');
  if (split < 0) {
    throw new NoteError('note has no signature block');
  }

  const text = note.slice(0, split + 1);
  const lines = note.slice(split + 2, -1).split('\n');
  if (lines.length > maxSignatures) {
    throw new NoteError('note has too many signatures');
  }

  const known = lines
    .map(parseSignatureLine)
    .filter(
      (signature) =>
        signature.name === verifier.name && signature.keyId === verifier.keyId,
    );
  if (known.length === 0) {
    throw new NoteError(`note is not signed by ${verifier.name}`);
  }

  const message = new TextEncoder().encode(text);
  for (const { signature } of known) {
    if (!verify(null, message, verifier.key, signature)) {
      throw new NoteError(`signature by ${verifier.name} does not verify`);
    }
  }

  return text;
}

export type Checkpoint = {
  readonly origin: string;
  readonly size: number;
  readonly root: Uint8Array;
  readonly extensions: readonly string[];
};

export function parseCheckpoint(text: string): Checkpoint {
  const lines = text.split('\n');
  if (lines.pop() !== '' || lines.length < 3 || lines.includes('')) {
    throw new NoteError(
      'a checkpoint has at least three non-empty lines, each ending in a newline',
    );
  }

  const [origin = '', sizeLine = '', rootLine = '', ...extensions] = lines;
  const size = /^(0|[1-9][0-9]*)$/.test(sizeLine) ? Number(sizeLine) : NaN;
  if (!Number.isSafeInteger(size)) {
    throw new NoteError(
      `checkpoint size ${JSON.stringify(sizeLine)} is invalid`,
    );
  }

  const root = decodeBase64(rootLine);
  if (root?.length !== 32) {
    throw new NoteError('checkpoint root is not a base64 SHA-256 hash');
  }

  return { origin, size, root, extensions };
}

export function formatCheckpoint(checkpoint: Checkpoint): string {
  return [
    checkpoint.origin,
    String(checkpoint.size),
    toBase64(checkpoint.root),
    ...checkpoint.extensions,
    '',
  ].join('\n');
}
