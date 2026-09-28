import { describe, expect, test } from 'bun:test';
import { noContext } from '../src/context';
import { Sha512Integrity } from '../src/evidence';
import type { LockfileNode } from '../src/npm/lockfile';
import { readOsvSnapshot } from '../src/npm/osv';
import { trustMaterialFrom } from '../src/npm/provenance';
import {
  verifyExitCode,
  verifyNodes,
  type EvidenceStore,
} from '../src/npm/verify';
import { trimPackument } from '../src/npm/registry';
import {
  loadSupplyChainPolicyV2,
  loadSupplyChainPolicyV4,
} from './support/policies';
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
    context: noContext,
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
    const accepted = verifyNodes({
      nodes: [vite],
      store,
      at,
      policy,
      context: noContext,
    });
    const unreadable = verifyNodes({
      nodes: [
        vite,
        { kind: 'unreadable', path: 'node_modules/x', error: 'bad' },
      ],
      store,
      at,
      policy,
      context: noContext,
    });

    expect(verifyExitCode(accepted)).toBe(0);
    expect(verifyExitCode(unreadable)).toBe(1);
    expect(verifyExitCode([])).toBe(0);
  });
});

describe('new dependencies', () => {
  const sha512 = `sha512-${'A'.repeat(86)}==`;
  const doc = (version: string, dependencies: Record<string, string>) => ({
    name: 'lib',
    version,
    dist: { integrity: sha512 },
    _npmUser: { name: 'maintainer' },
    dependencies,
  });
  const lib = trimPackument({
    name: 'lib',
    time: {
      '1.0.0': '2026-08-01T00:00:00.000Z',
      '1.1.0': '2026-09-20T00:00:00.000Z',
    },
    versions: {
      '1.0.0': doc('1.0.0', { old: '^1.0.0' }),
      '1.1.0': doc('1.1.0', { old: '^1.0.0', fresh: '^0.1.0' }),
    },
  });
  const fresh = {
    name: 'fresh',
    time: {
      created: '2026-09-19T00:00:00.000Z',
      '0.1.0': '2026-09-19T00:00:00.000Z',
    },
  };
  const node = {
    kind: 'package',
    path: 'node_modules/lib',
    name: 'lib',
    version: '1.1.0',
    source: { kind: 'registry', integrity: Sha512Integrity.make(sha512) },
    dev: false,
    optional: false,
    hasInstallScript: false,
  } as const satisfies LockfileNode;
  const run = (packuments: Record<string, unknown>) => {
    const [record] = verifyNodes({
      nodes: [node],
      store: {
        ...store,
        packument: (name) =>
          Object.hasOwn(packuments, name) ? packuments[name] : undefined,
        attestations: () => new Map(),
      },
      at: new Date('2026-09-28T00:00:00Z'),
      policy: loadSupplyChainPolicyV4(),
      context: noContext,
    });
    if (record?.kind !== 'decision') {
      throw new Error('expected a decision');
    }

    return record;
  };

  test("an added dependency's first publish comes from its recorded packument", () => {
    const record = run({ lib, fresh });

    expect(record.evidence.newDependencies).toEqual({
      kind: 'added',
      added: [
        {
          name: 'fresh',
          spec: '^0.1.0',
          firstPublish: {
            kind: 'packument',
            at: new Date('2026-09-19T00:00:00.000Z'),
          },
        },
      ],
    });
    expect(record.reasons.map((reason) => reason.code)).toContain(
      'new_dependency_young',
    );
  });

  test("without the added dependency's packument its first publish is unknown", () => {
    expect(run({ lib }).reasons.map((reason) => reason.code)).toContain(
      'new_dependencies_unknown',
    );
  });

  test('a node gate has no packument for has unknown new dependencies', () => {
    expect(run({}).evidence.newDependencies).toEqual({
      kind: 'unknown',
      reason: 'no packument recorded',
    });
  });
});
