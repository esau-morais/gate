import { afterEach, beforeEach, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEvidenceDirectory } from '../src/npm/evidence-directory';
import { feedsFor } from '../src/npm/osv';
import { evidenceDir } from './verify/cases';

let root: string;
let evidence: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gate-evidence-'));
  evidence = join(root, 'evidence');
  cpSync(fileURLToPath(evidenceDir), evidence, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const query = {
  name: 'vite',
  version: '8.3.0',
  at: new Date('2026-09-26T00:00:00Z'),
};

test('the recorded evidence directory loads', () => {
  const store = readEvidenceDirectory(evidence);

  expect(store.trust.kind).toBe('loaded');
  expect(feedsFor(store.osv, query)).toEqual({ kind: 'checked', hits: [] });
  expect(store.packument('vite')).toBeDefined();
  expect([...store.attestations('vite').keys()]).toHaveLength(11);
});

test('a package name cannot read outside the evidence directory', () => {
  writeFileSync(join(root, 'outside.json'), '{"name":"outside"}');
  const store = readEvidenceDirectory(evidence);

  expect(store.packument('../outside')).toBeUndefined();
  expect(store.packument('../../outside')).toBeUndefined();
  expect(store.attestations('../outside').size).toBe(0);
});

test('an OSV directory without a manifest proves nothing', () => {
  rmSync(join(evidence, 'osv'), { recursive: true });
  mkdirSync(join(evidence, 'osv'));

  expect(feedsFor(readEvidenceDirectory(evidence).osv, query).kind).toBe(
    'unavailable',
  );
});

test('a corrupt trusted root is reported as unreadable, not missing', () => {
  writeFileSync(join(evidence, 'trusted_root.json'), '{"mediaType":"x"}');
  const corrupt = readEvidenceDirectory(evidence).trust;
  rmSync(join(evidence, 'trusted_root.json'));
  const missing = readEvidenceDirectory(evidence).trust;

  expect(corrupt.kind === 'unavailable' && corrupt.reason).toStartWith(
    'trusted root is unreadable',
  );
  expect(missing).toEqual({
    kind: 'unavailable',
    reason: 'no trusted root recorded',
  });
});
