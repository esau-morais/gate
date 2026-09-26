import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Sha512Integrity } from '../src/evidence';
import type { LockfileNode } from '../src/npm/lockfile';
import { readOsvSnapshot } from '../src/npm/osv';
import { trustMaterialFrom } from '../src/npm/provenance';
import {
  verifyExitCode,
  verifyNodes,
  type EvidenceStore,
} from '../src/npm/verify';
import { loadSupplyChainPolicyV2 } from './support/policies';

const evidence = new URL('./verify/evidence/', import.meta.url);

function recorded(path: string): unknown {
  return JSON.parse(readFileSync(new URL(path, evidence), 'utf8'));
}

const viteVersions = [
  '8.1.2',
  '8.1.3',
  '8.1.4',
  '8.1.5',
  '8.2.0-beta.0',
  '8.2.0',
  '8.2.1',
  '8.2.2',
  '8.3.0-beta.0',
  '8.3.0-beta.1',
  '8.3.0',
];

const store: EvidenceStore = {
  packument: (name) =>
    name === 'vite' ? recorded('packuments/vite.json') : undefined,
  attestations: (name) =>
    new Map(
      name === 'vite'
        ? viteVersions.map((version) => [
            version,
            recorded(`attestations/vite@${version}.json`),
          ])
        : [],
    ),
  trust: trustMaterialFrom(recorded('trusted_root.json')),
  osv: readOsvSnapshot([recorded('osv/MAL-2026-3465.json')]),
};

const policy = loadSupplyChainPolicyV2();
const at = new Date('2026-09-23T12:17:15Z');
const published = Sha512Integrity.make(
  'sha512-lhZBVvEHefgE+HQZC9O7EBJgCU/nVzFNl7vkS4RE0APtWLP02/8QVIkQtzBxPquh7lq5/78NHipTj7ODQ6XuyQ==',
);

const vite = {
  kind: 'package',
  path: 'node_modules/vite',
  name: 'vite',
  version: '8.3.0',
  source: { kind: 'registry', integrity: published },
  dev: true,
  optional: false,
  hasInstallScript: false,
} as const satisfies LockfileNode;

function decide(node: LockfileNode, evidenceStore = store) {
  const [record] = verifyNodes({
    nodes: [node],
    store: evidenceStore,
    at,
    policy,
  });
  if (record?.kind !== 'decision') {
    throw new Error('expected a decision');
  }

  return {
    outcome: record.outcome,
    reasons: record.reasons.map((reason) => reason.code).toSorted(),
  };
}

describe('gate verify', () => {
  test('the recorded vite lockfile node is accepted', () => {
    expect(decide(vite)).toEqual({ outcome: 'ACCEPT', reasons: [] });
  });

  test('a lockfile pinning bytes the registry does not list is rejected', () => {
    const other = Sha512Integrity.make(
      'sha512-cFKLV/PRgAUlIRm5WjMjJ86jrftzpqcgH+Us+DS8mI3CDNiH30Whrz8uHL3+MOLPAgqbMBAqWdAHAphOAM+z/Q==',
    );

    expect(
      decide({ ...vite, source: { kind: 'registry', integrity: other } }),
    ).toEqual({ outcome: 'REJECT', reasons: ['integrity_mismatch'] });
  });

  test('a registry node without a recorded packument fails closed', () => {
    expect(decide({ ...vite, name: 'unrecorded' })).toEqual({
      outcome: 'QUARANTINE',
      reasons: [
        'install_scripts_unknown',
        'integrity_unknown',
        'provenance_unavailable',
        'publish_time_unknown',
        'publisher_unknown',
      ],
    });
  });

  test('an install script the packument does not list is unknown', () => {
    expect(decide({ ...vite, hasInstallScript: true })).toEqual({
      outcome: 'QUARANTINE',
      reasons: ['install_scripts_unknown'],
    });
  });

  test('a missing feed snapshot quarantines instead of passing', () => {
    expect(
      decide(vite, {
        ...store,
        osv: { kind: 'unavailable', reason: 'no OSV snapshot' },
      }),
    ).toEqual({ outcome: 'QUARANTINE', reasons: ['feeds_unavailable'] });
  });

  test('without a trusted root, verified provenance is unavailable', () => {
    expect(decide(vite, { ...store, trust: null })).toEqual({
      outcome: 'QUARANTINE',
      reasons: ['provenance_unavailable', 'publisher_unknown'],
    });
  });

  test('a package name that could leave the evidence directory is not looked up', () => {
    const looked: string[] = [];
    const spy: EvidenceStore = {
      ...store,
      packument: (name) => {
        looked.push(name);

        return undefined;
      },
    };

    decide({ ...vite, name: '../../etc/passwd' }, spy);
    expect(looked).toEqual([]);
  });

  test('only a run where every node is accepted exits 0', () => {
    const accepted = verifyNodes({ nodes: [vite], store, at, policy });
    const unreadable = verifyNodes({
      nodes: [
        vite,
        { kind: 'unreadable', path: 'node_modules/x', error: 'bad' },
      ],
      store,
      at,
      policy,
    });

    expect(verifyExitCode(accepted)).toBe(0);
    expect(verifyExitCode(unreadable)).toBe(1);
    expect(verifyExitCode([])).toBe(0);
  });
});
