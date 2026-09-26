import { describe, expect, test } from 'bun:test';
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
import { recordedEvidence, recordedViteAttestations } from './verify/cases';

const store: EvidenceStore = {
  packument: (name) =>
    name === 'vite' ? recordedEvidence('packuments/vite.json') : undefined,
  attestations: (name) =>
    name === 'vite' ? recordedViteAttestations() : new Map(),
  trust: {
    kind: 'loaded',
    material: trustMaterialFrom(recordedEvidence('trusted_root.json')),
  },
  osv: readOsvSnapshot({
    manifest: recordedEvidence('osv/manifest.json'),
    records: [recordedEvidence('osv/MAL-2026-3465.json')],
  }),
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
        'feeds_unavailable',
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

  test('a git source never reads as having no install scripts', () => {
    expect(
      decide({
        ...vite,
        version: '1.0.0',
        source: {
          kind: 'git',
          spec: `git+ssh://git@github.com/o/r.git#${'a'.repeat(40)}`,
        },
        hasInstallScript: false,
      }),
    ).toEqual({
      outcome: 'REJECT',
      reasons: ['exotic_source', 'install_scripts_unknown'],
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
    expect(
      decide(vite, {
        ...store,
        trust: { kind: 'unavailable', reason: 'no trusted root recorded' },
      }),
    ).toEqual({
      outcome: 'QUARANTINE',
      reasons: ['provenance_unavailable', 'publisher_unknown'],
    });
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
