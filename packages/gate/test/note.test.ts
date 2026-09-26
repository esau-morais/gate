import { expect, test } from 'bun:test';
import {
  Ed25519NoteVerifier,
  Note,
  VerifierList,
} from '@cloudflare/signed-note-wasm';
import {
  formatCheckpoint,
  openNote,
  parseCheckpoint,
  parseSignerKey,
  parseVerifierKey,
  signNote,
} from '../src/log/note';
import { generateTestLogKey } from './support/log';

const encode = (text: string) => new TextEncoder().encode(text);

// https://github.com/C2SP/C2SP/blob/d4c16da5e7687a016619074e78dad84b2c7238cc/signed-note.md#example
const specVkey =
  'example.com/foo+530d903a+AekyeRrm56hApGFkyQR4ZCbV54Id2LKaANYcrnKv3U2k';
const specNote =
  'This is an example message.\n\n— example.com/foo Uw2QOkn8srV1yJGh2VYRlL1Tnagv1YEq6TfXppzi2ONncAlTgK7Ztg1ERYNZXsYjOBH3mFXmRKuwHjG1Yu72IneyaQM=\n';

// https://github.com/golang/mod/blob/master/sumdb/note/note.go (package doc)
const goVkey =
  'PeterNeumann+c74f20a3+ARpc2QcUPDhMQegwxbzhKqiBfsVkmqq/LDE4izWy10TW';
const goNote =
  "If you think cryptography is the answer to your problem,\nthen you don't know what your problem is.\n\n— PeterNeumann x08go/ZJkuBS9UG/SffcvIAQxVBtiFupLLr8pAcElZInNIuGUgYN1FFYC2pZSNXgKvqfqdngotpRZb6KE6RyyBwJnAM=\n";

test('opens the signed-note spec example and the Go note example', () => {
  expect(openNote(encode(specNote), parseVerifierKey(specVkey))).toBe(
    'This is an example message.\n',
  );
  expect(openNote(encode(goNote), parseVerifierKey(goVkey))).toBe(
    "If you think cryptography is the answer to your problem,\nthen you don't know what your problem is.\n",
  );
});

test('signatures from unknown keys are ignored next to a valid one', () => {
  const withUnknown = `${specNote}— other.example/key AAAAAAB0ZXN0\n`;

  expect(openNote(encode(withUnknown), parseVerifierKey(specVkey))).toBe(
    'This is an example message.\n',
  );
});

test('a note is refused unless the known key signed exactly its text', () => {
  const verifier = parseVerifierKey(specVkey);
  const refused = [
    specNote.replace('example message', 'exemplary message'),
    specNote.replace('Uw2QOkn8', 'Uw2QOkn9'),
    goNote,
    `${specNote.slice(0, -1)}`,
    specNote.replace('This', 'This\u0007'),
    specNote.replace('\n\n', '\n'),
  ];

  for (const note of refused) {
    expect(() => openNote(encode(note), verifier)).toThrow();
  }

  expect(() => openNote(Uint8Array.of(0xff, 0x0a, 0x0a), verifier)).toThrow();
});

test('notes gate signs verify with the signed-note oracle', () => {
  const key = generateTestLogKey('gate.test/log');
  const signer = parseSignerKey(key.skey);
  const note = signNote(
    'gate.test/log\n0\n47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=\n',
    signer,
  );

  const verifiers = new VerifierList();
  verifiers.addEd25519(new Ed25519NoteVerifier(key.vkey));
  verifiers.build();
  expect(Note.fromBytes(note).verify(verifiers).verified_count).toBe(1);
  expect(signer.verifier.encoded).toBe(key.vkey);
});

test('keys whose ID does not match their name and key are refused', () => {
  const key = generateTestLogKey('gate.test/log');
  const [, , name, id] = key.skey.split('+');
  const data = key.skey.split('+').slice(4).join('+');
  const otherId = id === '00000000' ? '00000001' : '00000000';

  expect(() =>
    parseSignerKey(`PRIVATE+KEY+${name}+${otherId}+${data}`),
  ).toThrow();
  expect(() =>
    parseSignerKey(`PRIVATE+KEY+other.test/log+${id}+${data}`),
  ).toThrow();
  expect(() =>
    parseVerifierKey(key.vkey.replace(/\+[0-9a-f]{8}\+/, `+${otherId}+`)),
  ).toThrow();
  expect(() =>
    parseVerifierKey(
      'a b+530d903a+AekyeRrm56hApGFkyQR4ZCbV54Id2LKaANYcrnKv3U2k',
    ),
  ).toThrow();
});

test('checkpoint text round-trips and malformed text is refused', () => {
  // https://github.com/C2SP/C2SP/blob/d4c16da5e7687a016619074e78dad84b2c7238cc/tlog-checkpoint.md
  const text =
    'example.com/behind-the-sofa\n20852163\nCsUYapGGPo4dkMgIAUqom/Xajj7h2fB2MPA3j2jxq2I=\n';
  const checkpoint = parseCheckpoint(text);

  expect(checkpoint.origin).toBe('example.com/behind-the-sofa');
  expect(checkpoint.size).toBe(20852163);
  expect(checkpoint.root.length).toBe(32);
  expect(formatCheckpoint(checkpoint)).toBe(text);

  for (const bad of [
    'example.com/log\n020852163\nCsUYapGGPo4dkMgIAUqom/Xajj7h2fB2MPA3j2jxq2I=\n',
    'example.com/log\n-1\nCsUYapGGPo4dkMgIAUqom/Xajj7h2fB2MPA3j2jxq2I=\n',
    'example.com/log\n1\nCsUYapGGPo4dkMgIAUqom/Xajj7h2fB2MPA3j2jxq2I\n',
    'example.com/log\n1\nCsUY\n',
    'example.com/log\n1\n',
    '\n1\nCsUYapGGPo4dkMgIAUqom/Xajj7h2fB2MPA3j2jxq2I=\n',
    'example.com/log\n1\nCsUYapGGPo4dkMgIAUqom/Xajj7h2fB2MPA3j2jxq2I=\n\n',
    'example.com/log\n9007199254740992\nCsUYapGGPo4dkMgIAUqom/Xajj7h2fB2MPA3j2jxq2I=\n',
  ]) {
    expect(() => parseCheckpoint(bad)).toThrow();
  }
});

test('keys whose base64 data contains + parse, as in the Go note encoding', () => {
  const key = Array.from({ length: 200 }, () =>
    generateTestLogKey('gate.test/log'),
  ).find(
    ({ skey, vkey }) =>
      skey.split('+').length > 5 && vkey.split('+').length > 3,
  );
  if (key === undefined) {
    throw new Error('no generated key had + in its data');
  }

  expect(parseSignerKey(key.skey).verifier.encoded).toBe(key.vkey);
  expect(parseVerifierKey(key.vkey).encoded).toBe(key.vkey);
});
