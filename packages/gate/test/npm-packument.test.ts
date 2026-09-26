import { describe, expect, test } from 'bun:test';
import { npmPackumentFacts } from '../src/npm/packument';
import { trustMaterialFrom, type TrustRoot } from '../src/npm/provenance';
import { loadReplayFixtures } from './replay/fixture';
import { recordedEvidence, recordedViteAttestations } from './verify/cases';

const trust: TrustRoot = {
  kind: 'loaded',
  material: trustMaterialFrom(recordedEvidence('trusted_root.json')),
};
const vitePackument = recordedEvidence('packuments/vite.json');
const viteAttestations = recordedViteAttestations();

const sha512 = `sha512-${'A'.repeat(86)}==`;

function packument(versions: Record<string, Record<string, unknown>>) {
  return {
    name: 'lib',
    time: {
      created: '2026-01-01T00:00:00.000Z',
      modified: '2026-03-01T00:00:00.000Z',
      '1.0.0': '2026-01-01T00:00:00.000Z',
      '1.1.0': '2026-02-01T00:00:00.000Z',
    },
    versions: Object.fromEntries(
      Object.entries(versions).map(([version, doc]) => [
        version,
        {
          name: 'lib',
          version,
          dist: { integrity: sha512 },
          _npmUser: { name: 'maintainer' },
          ...doc,
        },
      ]),
    ),
  };
}

function lib(
  versions: Record<string, Record<string, unknown>>,
  options: { trust?: TrustRoot } = {},
) {
  return npmPackumentFacts({
    packument: packument(versions),
    name: 'lib',
    version: '1.1.0',
    attestations: new Map(),
    trust: options.trust ?? trust,
  });
}

describe('recorded packuments', () => {
  test('reproduce the hand-assembled vite replay facts', () => {
    const fixture = loadReplayFixtures().find(
      ({ name }) => name === 'vite-8.3.0-benign',
    )?.fixture;
    if (fixture === undefined) {
      throw new Error('vite replay fixture missing');
    }

    expect(
      npmPackumentFacts({
        packument: vitePackument,
        name: 'vite',
        version: '8.3.0',
        attestations: viteAttestations,
        trust,
      }),
    ).toEqual({
      kind: 'read',
      target: fixture.target,
      earlier: fixture.earlier,
    });
  });

  test('a version document npm removed keeps its publish time and nothing else', () => {
    const read = npmPackumentFacts({
      packument: recordedEvidence('packuments/@tanstack/react-router.json'),
      name: '@tanstack/react-router',
      version: '1.169.8',
      attestations: new Map(),
      trust,
    });

    expect(read).toMatchObject({
      kind: 'read',
      target: {
        version: '1.169.8',
        time: new Date('2026-05-11T19:26:17.716Z'),
        integrity: null,
        provenance: { kind: 'unavailable', reason: 'version document missing' },
        npmUser: null,
        scripts: 'unknown',
      },
    });
    expect(
      read.kind === 'read' && read.earlier.map((facts) => facts.version),
    ).toEqual([
      '1.168.21',
      '1.168.22',
      '1.168.23',
      '1.168.24',
      '1.168.25',
      '1.168.26',
      '1.169.0',
      '1.169.1',
      '1.169.2',
      '1.169.5',
    ]);
  });
});

describe('provenance', () => {
  const attested = {
    dist: {
      integrity: sha512,
      attestations: {
        url: 'https://registry.npmjs.org/-/npm/v1/attestations/lib@1.1.0',
        provenance: { predicateType: 'https://slsa.dev/provenance/v1' },
      },
    },
  };

  test('a version without attestations has none', () => {
    expect(lib({ '1.1.0': {} })).toMatchObject({
      target: { provenance: { kind: 'absent' } },
    });
  });

  test('an advertised attestation that was not recorded is unavailable, not absent', () => {
    expect(lib({ '1.1.0': attested })).toMatchObject({
      target: {
        provenance: {
          kind: 'unavailable',
          reason: 'attestation bundle not recorded',
        },
      },
    });
  });

  test('without a trusted root nothing verifies, and the reason says why', () => {
    const reason = 'trusted root is unreadable: not a Sigstore trusted root';

    expect(
      lib({ '1.1.0': attested }, { trust: { kind: 'unavailable', reason } }),
    ).toMatchObject({
      target: { provenance: { kind: 'unavailable', reason } },
    });
  });

  test('an attestation needs a sha512 integrity to match', () => {
    expect(
      lib({ '1.1.0': { dist: { ...attested.dist, integrity: 'sha1-x' } } }),
    ).toMatchObject({
      target: {
        integrity: null,
        provenance: {
          kind: 'unavailable',
          reason: 'no sha512 integrity to match',
        },
      },
    });
  });
});

describe('install scripts', () => {
  test('a gypfile without an install hook runs node-gyp rebuild', () => {
    expect(lib({ '1.1.0': { gypfile: true } })).toMatchObject({
      target: { scripts: { install: 'node-gyp rebuild' } },
    });
    expect(
      lib({
        '1.1.0': { gypfile: true, scripts: { preinstall: 'node x.js' } },
      }),
    ).toMatchObject({ target: { scripts: { preinstall: 'node x.js' } } });
  });
});

describe('unreadable input', () => {
  test('a version missing from time is unreadable', () => {
    expect(
      npmPackumentFacts({
        packument: packument({}),
        name: 'lib',
        version: '9.9.9',
        attestations: new Map(),
        trust,
      }).kind,
    ).toBe('unreadable');
  });

  test('a packument for another package is unreadable', () => {
    expect(
      npmPackumentFacts({
        packument: packument({}),
        name: 'other',
        version: '1.1.0',
        attestations: new Map(),
        trust,
      }).kind,
    ).toBe('unreadable');
  });

  test('a document that names another version is not read as this one', () => {
    expect(
      lib({ '1.1.0': { version: '1.0.0', scripts: { install: 'x' } } }),
    ).toMatchObject({
      target: { scripts: 'unknown', npmUser: null, integrity: null },
    });
  });
});
