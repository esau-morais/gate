import { describe, expect, test } from 'bun:test';
import { npmFirstPublish, npmPackumentFacts } from '../src/npm/packument';
import { trimPackument } from '../src/npm/registry';
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
        removed: true,
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

describe('removed versions', () => {
  test('a listed document is not removed, even when it is unreadable', () => {
    const read = lib({ '1.0.0': { dist: 42 }, '1.1.0': {} });

    expect(read).toMatchObject({
      earlier: [
        {
          provenance: {
            kind: 'unavailable',
            reason: 'version document unreadable',
          },
        },
      ],
    });
    expect(
      read.kind === 'read' &&
        [read.target, ...read.earlier].map((facts) => 'removed' in facts),
    ).toEqual([false, false]);
  });
});

describe('dependencies', () => {
  const trimmed = (versions: Record<string, Record<string, unknown>>) =>
    npmPackumentFacts({
      packument: trimPackument(packument(versions)),
      name: 'lib',
      version: '1.1.0',
      attestations: new Map(),
      trust,
    });

  test('dependencies, optional dependencies and required peers are what an install fetches', () => {
    expect(
      trimmed({
        '1.1.0': {
          dependencies: { a: '^1.0.0', shared: '^2.0.0' },
          optionalDependencies: { b: '~1.2.0' },
          peerDependencies: { c: '>=3', shared: '*', d: '^4' },
          peerDependenciesMeta: { d: { optional: true } },
          devDependencies: { e: '^5' },
          bundleDependencies: ['f'],
        },
      }),
    ).toMatchObject({
      target: {
        dependencies: { a: '^1.0.0', shared: '^2.0.0', b: '~1.2.0', c: '>=3' },
      },
    });
  });

  test('a version without dependency fields has none once gate has trimmed the packument', () => {
    expect(trimmed({ '1.1.0': {} })).toMatchObject({
      target: { dependencies: {} },
    });
  });

  test('without the trim mark, a version without dependency fields is unknown, since an older trim dropped them', () => {
    expect(lib({ '1.1.0': {} })).toMatchObject({
      target: { dependencies: 'unknown' },
    });
    expect(lib({ '1.1.0': { dependencies: { a: '1' } } })).toMatchObject({
      target: { dependencies: { a: '1' } },
    });
  });

  test('a malformed dependency field is unknown and leaves the rest of the document readable', () => {
    for (const dependencies of [['a'], 'a', { a: 1 }]) {
      expect(trimmed({ '1.1.0': { dependencies } })).toMatchObject({
        target: {
          dependencies: 'unknown',
          npmUser: 'maintainer',
          provenance: { kind: 'absent' },
        },
      });
    }
  });

  test('a removed or unreadable document has unknown dependencies', () => {
    expect(trimmed({ '1.0.0': { dist: 42 }, '1.1.0': {} })).toMatchObject({
      earlier: [{ dependencies: 'unknown' }],
    });
    expect(trimmed({ '1.1.0': {} })).toMatchObject({
      earlier: [{ dependencies: 'unknown', removed: true }],
    });
  });
});

describe('first publish', () => {
  const first = (time: Record<string, unknown>, name = 'lib') =>
    npmFirstPublish({ packument: { name, time, versions: {} }, name: 'lib' });

  test('is the earliest of created and every version time, whether or not the version is still listed', () => {
    expect(
      first({
        created: '2018-11-29T16:56:02.864Z',
        modified: '2022-05-02T14:26:06.405Z',
        '0.0.1-security': '2018-11-29T16:56:02.951Z',
        '0.1.0': '2018-09-05T08:23:42.256Z',
        unpublished: { time: '2018-11-26T17:18:17.658Z' },
      }),
    ).toEqual({ kind: 'packument', at: new Date('2018-09-05T08:23:42.256Z') });
  });

  test('is unknown without a packument, for another package, or with an unreadable time', () => {
    expect(npmFirstPublish({ packument: undefined, name: 'lib' })).toEqual({
      kind: 'unknown',
      reason: 'no packument recorded',
    });
    expect(first({ '1.0.0': '2026-01-01T00:00:00Z' }, 'other')).toMatchObject({
      kind: 'unknown',
    });
    expect(
      first({ '1.0.0': '2026-01-01T00:00:00Z', '1.1.0': 'soon' }),
    ).toMatchObject({ kind: 'unknown' });
    expect(first({ modified: '2026-01-01T00:00:00Z' })).toMatchObject({
      kind: 'unknown',
    });
  });
});

describe('declared repository', () => {
  test('is read from a string or from the url of an object', () => {
    expect(
      lib({
        '1.0.0': { repository: 'acme/lib' },
        '1.1.0': {
          repository: {
            type: 'git',
            url: 'git+https://github.com/acme/lib.git',
            directory: 'packages/lib',
          },
        },
      }),
    ).toMatchObject({
      target: { repository: 'github.com/acme/lib' },
      earlier: [{ repository: 'github.com/acme/lib' }],
    });
  });

  test('npm shorthand, ssh and monorepo URLs name the same GitHub repository', () => {
    for (const repository of [
      'github:acme/lib',
      'git@github.com:acme/lib.git',
      'git+ssh://git@github.com/acme/lib.git',
      'git://github.com/acme/lib.git',
      'https://www.github.com/Acme/Lib',
      'https://github.com/acme/lib/tree/main/packages/lib',
      'https://github.com/acme/lib#readme',
    ]) {
      expect({
        repository,
        read: lib({ '1.1.0': { repository } }),
      }).toMatchObject({
        repository,
        read: { target: { repository: 'github.com/acme/lib' } },
      });
    }
  });

  test('another host keeps its whole path', () => {
    expect(
      lib({ '1.1.0': { repository: 'https://gitlab.com/acme/group/lib.git' } }),
    ).toMatchObject({ target: { repository: 'gitlab.com/acme/group/lib' } });
  });

  test('a repository gate cannot read is unknown, not absent', () => {
    for (const repository of [
      { type: 'git' },
      { url: '' },
      '',
      42,
      'not a repository',
      'gitlab:acme/lib',
      'https://github.com/acme/lib/issues',
      'https://github.com/acme',
    ]) {
      expect({
        repository,
        read: lib({ '1.1.0': { repository } }),
      }).toMatchObject({
        repository,
        read: { target: { repository: 'unknown' } },
      });
    }

    const undeclared = lib({ '1.1.0': {} });
    expect(
      undeclared.kind === 'read' && 'repository' in undeclared.target,
    ).toBe(false);
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
