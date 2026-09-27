import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Schema } from 'effect';
import { noContext } from '../src/context';
import { collectEvidence } from '../src/npm/collect';
import {
  readEvidenceDirectory,
  readFetchGaps,
} from '../src/npm/evidence-directory';
import { readPackageLock, type LockfileNode } from '../src/npm/lockfile';
import { maliciousPackagesUrl } from '../src/npm/malware-feed';
import { feedsFor } from '../src/npm/osv';
import { npmPackumentFacts } from '../src/npm/packument';
import {
  attestationsUrl,
  packumentUrl,
  trimPackument,
} from '../src/npm/registry';
import { verifyExitCode, verifyNodes } from '../src/npm/verify';
import {
  collectedAt,
  fakeNetwork,
  feedArchive,
  packumentHeaders,
  recordedResponse,
  recordedRoutes,
  type FakeNetwork,
} from './collect/recorded';
import { loadSupplyChainPolicyV2 } from './support/policies';
import {
  expectedNodes,
  loadVerifyCases,
  viteVersions,
  type NodeSummary,
} from './verify/cases';

const caches: string[] = [];

afterEach(() => {
  for (const dir of caches.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function cacheDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gate-collect-'));
  caches.push(dir);

  return dir;
}

function caseNodes(name: string): readonly LockfileNode[] {
  const found = loadVerifyCases().find((entry) => entry.name === name);
  if (found === undefined) {
    throw new Error(`no verify case ${name}`);
  }

  const lock = readPackageLock(
    readFileSync(new URL(found.fixture.lockfile, found.dir), 'utf8'),
  );
  if (lock.kind !== 'read') {
    throw new Error(lock.error);
  }

  return lock.nodes;
}

function registryNode(name: string, version: string): LockfileNode {
  return {
    kind: 'package',
    path: `node_modules/${name}`,
    name,
    version,
    source: { kind: 'registry', integrity: null },
    dev: false,
    optional: false,
    hasInstallScript: null,
  };
}

function decide(dir: string, nodes: readonly LockfileNode[], at: Date) {
  const records = verifyNodes({
    nodes,
    store: readEvidenceDirectory(dir),
    at,
    policy: loadSupplyChainPolicyV2(),
    context: noContext,
  });

  return {
    records,
    exitCode: verifyExitCode(records),
    nodes: records.map((record): NodeSummary =>
      record.kind === 'decision'
        ? {
            path: record.path,
            ...(record.dependency === undefined
              ? {}
              : { dependency: record.dependency }),
            outcome: record.outcome,
            reasons: record.reasons.map((reason) => reason.code).toSorted(),
          }
        : { path: record.path, unreadable: record.error },
    ),
  };
}

const decodeSources = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      files: Schema.Array(
        Schema.Struct({
          path: Schema.String,
          url: Schema.String,
          fetchedAt: Schema.String,
        }),
      ),
      gaps: Schema.Array(Schema.String),
    }),
  ),
);

function sourcesOf(dir: string) {
  return decodeSources(readFileSync(join(dir, 'SOURCES.json'), 'utf8'));
}

const viteNodes = () => caseNodes('vite-8.3.0-benign');
const viteAt = new Date('2026-09-23T12:17:15Z');

async function collect(
  network: FakeNetwork,
  nodes: readonly LockfileNode[],
  dir = cacheDir(),
) {
  return collectEvidence({ nodes, cacheDir: dir, sources: network.sources });
}

describe('collect then verify', () => {
  for (const { name, fixture } of loadVerifyCases()) {
    test(`${name} decides as it does from the recorded evidence directory`, async () => {
      const network = fakeNetwork();
      const nodes = caseNodes(name);
      const collected = await collect(network, nodes);

      for (const evaluation of fixture.evaluations) {
        const run = decide(collected.dir, nodes, evaluation.at);

        expect(run.nodes).toEqual(expectedNodes(evaluation));
        expect(run.exitCode).toBe(evaluation.exitCode);
      }
    });
  }

  test('SOURCES.json names the URL and fetch time of every file it wrote', async () => {
    const collected = await collect(fakeNetwork(), viteNodes());
    const sources = sourcesOf(collected.dir);

    expect(sources.gaps).toEqual([]);
    expect(sources.files.map((file) => file.path).toSorted()).toEqual(
      [
        'osv/',
        'packuments/vite.json',
        'trusted_root.json',
        ...viteVersions.map((version) => `attestations/vite@${version}.json`),
      ].toSorted(),
    );
    expect(new Set(sources.files.map((file) => file.fetchedAt))).toEqual(
      new Set([collectedAt.toISOString()]),
    );
  });
});

describe('malware feed', () => {
  const longName =
    '-accion-pelicula-john-wick-4-keanu-reeves-peliculas-completa-varindo-allah-varindo-en-casa-lliena-';
  const feedNodes = [
    registryNode('AdultJS', '1.0.0'),
    registryNode(longName, '1.0.0'),
    registryNode('0x2ai-demo1', '2.0.2'),
    registryNode('left-pad', '1.3.0'),
  ];
  const feeds = (dir: string, name: string, version: string, at: Date) =>
    feedsFor(readEvidenceDirectory(dir).osv, { name, version, at });

  test('matches records by affected package, not by the directory they sit in', async () => {
    const collected = await collect(fakeNetwork(), feedNodes);

    expect(feeds(collected.dir, 'AdultJS', '1.0.0', collectedAt)).toEqual({
      kind: 'checked',
      hits: [{ feed: 'osv', id: 'MAL-2025-14119' }],
    });
    expect(feeds(collected.dir, longName, '1.0.0', collectedAt)).toEqual({
      kind: 'checked',
      hits: [{ feed: 'osv', id: 'MAL-2024-1677' }],
    });
    expect(feeds(collected.dir, 'left-pad', '1.3.0', collectedAt)).toEqual({
      kind: 'checked',
      hits: [],
    });
    expect(readdirSync(join(collected.dir, 'osv')).toSorted()).toEqual([
      'MAL-2024-1677.json',
      'MAL-2025-14119.json',
      'MAL-2026-5587.json',
      'manifest.json',
    ]);
  });

  test('the manifest names the commit and commit time the archive was cut from', async () => {
    const collected = await collect(fakeNetwork(), feedNodes);
    const manifest: unknown = JSON.parse(
      readFileSync(join(collected.dir, 'osv/manifest.json'), 'utf8'),
    );

    expect(manifest).toMatchObject({
      capturedAt: collectedAt.toISOString(),
      source: {
        commit: '673f2310ffc87df8cd80340bf43293eed5837dac',
        committedAt: '2026-09-26T15:18:56.000Z',
      },
    });
  });

  test('keeps withdrawn records, which count until their withdrawal', async () => {
    const collected = await collect(fakeNetwork(), feedNodes);

    expect(
      feeds(
        collected.dir,
        '0x2ai-demo1',
        '2.0.2',
        new Date('2026-06-20T00:00:00Z'),
      ),
    ).toEqual({
      kind: 'checked',
      hits: [{ feed: 'osv', id: 'MAL-2026-5587' }],
    });
    expect(feeds(collected.dir, '0x2ai-demo1', '2.0.2', collectedAt)).toEqual({
      kind: 'checked',
      hits: [],
    });
  });

  test('a download that stays rate limited leaves feeds unavailable', async () => {
    const network = fakeNetwork();
    network.routes.set(
      maliciousPackagesUrl,
      () =>
        new Response('slow down', {
          status: 429,
          headers: { 'retry-after': '1' },
        }),
    );
    const collected = await collect(network, viteNodes());

    expect(
      network.requests.filter((url) => url === maliciousPackagesUrl),
    ).toHaveLength(3);
    expect(network.sleeps).toEqual([1000, 1000]);
    expect(existsSync(join(collected.dir, 'osv'))).toBe(false);
    expect(sourcesOf(collected.dir).gaps).toEqual([
      'osv/: malicious-packages snapshot: HTTP 429 after 3 attempts',
    ]);
    expect(readFetchGaps(collected.dir)).toEqual({
      kind: 'listed',
      gaps: [
        {
          path: 'osv/',
          reason: 'malicious-packages snapshot: HTTP 429 after 3 attempts',
        },
      ],
    });
    expect(decide(collected.dir, viteNodes(), viteAt).nodes).toEqual([
      {
        path: 'node_modules/vite',
        outcome: 'QUARANTINE',
        reasons: ['feeds_unavailable'],
      },
    ]);
  });

  test('a server error leaves feeds unavailable without retrying', async () => {
    const network = fakeNetwork();
    network.routes.set(
      maliciousPackagesUrl,
      () => new Response('', { status: 500 }),
    );
    const collected = await collect(network, viteNodes());

    expect(network.sleeps).toEqual([]);
    expect(sourcesOf(collected.dir).gaps).toEqual([
      'osv/: malicious-packages snapshot: HTTP 500',
    ]);
  });

  test('an archive with no npm records is unavailable, not an empty feed', async () => {
    const network = fakeNetwork();
    network.routes.set(
      maliciousPackagesUrl,
      () =>
        new Response(
          feedArchive(undefined, 'malicious-packages-no-npm.tar.gz'),
        ),
    );
    const collected = await collect(network, viteNodes());

    expect(existsSync(join(collected.dir, 'osv'))).toBe(false);
    expect(sourcesOf(collected.dir).gaps).toEqual([
      'osv/: malicious-packages snapshot: archive holds no npm records',
    ]);
  });

  test('a cached archive stamped in the future is downloaded again', async () => {
    const network = fakeNetwork();
    const dir = cacheDir();
    network.advance(7 * 86_400_000);
    await collect(network, viteNodes(), dir);
    network.advance(-7 * 86_400_000);
    await collect(network, viteNodes(), dir);

    expect(
      network.requests.filter((url) => url === maliciousPackagesUrl),
    ).toHaveLength(2);
  });

  test('a truncated archive is not read as a partial snapshot, and is fetched again next run', async () => {
    const network = fakeNetwork();
    const archive = feedArchive();
    network.routes.set(
      maliciousPackagesUrl,
      () => new Response(archive.subarray(0, archive.length / 2)),
    );
    const dir = cacheDir();
    const collected = await collect(network, viteNodes(), dir);

    expect(existsSync(join(collected.dir, 'osv'))).toBe(false);
    expect(sourcesOf(collected.dir).gaps[0]).toStartWith(
      'osv/: malicious-packages snapshot: archive is unreadable',
    );

    network.routes.set(maliciousPackagesUrl, () => new Response(feedArchive()));
    await collect(network, viteNodes(), dir);

    expect(
      network.requests.filter((url) => url === maliciousPackagesUrl),
    ).toHaveLength(2);
  });
});

describe('registry cache', () => {
  const viteUrl = packumentUrl('vite');

  test('a packument inside its max-age, attestations and the feed are not fetched again', async () => {
    const network = fakeNetwork();
    const dir = cacheDir();
    await collect(network, viteNodes(), dir);
    const first = network.requests.length;
    network.advance(299_000);
    await collect(network, viteNodes(), dir);

    expect(first).toBe(13);
    expect(network.requests).toHaveLength(first);
  });

  test('a cached packument stamped in the future is revalidated', async () => {
    const network = fakeNetwork();
    const dir = cacheDir();
    network.advance(7 * 86_400_000);
    await collect(network, viteNodes(), dir);
    network.advance(-7 * 86_400_000);
    await collect(network, viteNodes(), dir);

    expect(network.requests.filter((url) => url === viteUrl)).toHaveLength(2);
  });

  test('an expired packument is revalidated with its etag, and a 304 keeps the cached body', async () => {
    const network = fakeNetwork();
    const recorded = recordedRoutes().get(viteUrl);
    if (recorded === undefined) {
      throw new Error('vite packument is not recorded');
    }

    const seen: (string | undefined)[] = [];
    network.routes.set(viteUrl, (headers) => {
      seen.push(headers['if-none-match']);
      if (headers['if-none-match'] === '"v1"') {
        return new Response(null, { status: 304, headers: packumentHeaders });
      }

      const response = recorded(headers);
      response.headers.set('etag', '"v1"');

      return response;
    });
    const dir = cacheDir();
    await collect(network, viteNodes(), dir);
    network.advance(301_000);
    const collected = await collect(network, viteNodes(), dir);

    expect(seen).toEqual([undefined, '"v1"']);
    expect(
      sourcesOf(collected.dir).files.find(
        (file) => file.path === 'packuments/vite.json',
      )?.fetchedAt,
    ).toBe(new Date(collectedAt.getTime() + 301_000).toISOString());
    expect(decide(collected.dir, viteNodes(), viteAt).nodes).toEqual([
      { path: 'node_modules/vite', outcome: 'ACCEPT', reasons: [] },
    ]);
  });

  test('a packument that cannot be refreshed is left out, not served stale', async () => {
    const network = fakeNetwork();
    const dir = cacheDir();
    await collect(network, viteNodes(), dir);
    network.advance(301_000);
    network.routes.delete(viteUrl);
    const collected = await collect(network, viteNodes(), dir);

    expect(existsSync(join(collected.dir, 'packuments/vite.json'))).toBe(false);
    expect(sourcesOf(collected.dir).gaps).toEqual([
      `packuments/vite.json: ${viteUrl}: request failed: ${viteUrl} is not recorded`,
    ]);
    const [record] = decide(collected.dir, viteNodes(), viteAt).records;
    expect(record?.kind === 'decision' && record.evidence.publishTime).toEqual({
      kind: 'unknown',
      reason: 'no packument recorded',
    });
    expect(record?.kind === 'decision' && record.outcome).toBe('QUARANTINE');
  });

  test('a packument that 404s reads as unknown evidence', async () => {
    const network = fakeNetwork();
    const name = 'this-package-does-not-exist-gate-probe';
    network.routes.set(packumentUrl(name), () =>
      recordedResponse('packument-404.json'),
    );
    const nodes = [registryNode(name, '1.0.0')];
    const collected = await collect(network, nodes);

    expect(sourcesOf(collected.dir).gaps).toEqual([
      `packuments/${name}.json: ${packumentUrl(name)}: HTTP 404`,
    ]);
    expect(readFetchGaps(collected.dir)).toEqual({
      kind: 'listed',
      gaps: [
        {
          path: `packuments/${name}.json`,
          url: packumentUrl(name),
          reason: 'HTTP 404',
        },
      ],
    });
    expect(decide(collected.dir, nodes, collectedAt).nodes).toEqual([
      {
        path: `node_modules/${name}`,
        outcome: 'QUARANTINE',
        reasons: [
          'install_scripts_unknown',
          'integrity_unknown',
          'provenance_unavailable',
          'publish_time_unknown',
          'publisher_unknown',
        ],
      },
    ]);
  });

  test('an advertised attestation that 404s reads as unavailable provenance', async () => {
    const network = fakeNetwork();
    const url = attestationsUrl('vite', '8.3.0');
    network.routes.set(url, () => recordedResponse('attestations-404.json'));
    const collected = await collect(network, viteNodes());

    expect(sourcesOf(collected.dir).gaps).toEqual([
      `attestations/vite@8.3.0.json: ${url}: HTTP 404`,
    ]);
    const [record] = decide(collected.dir, viteNodes(), viteAt).records;
    expect(record?.kind === 'decision' && record.evidence.provenance).toEqual({
      kind: 'unavailable',
      reason: 'attestation bundle not recorded',
    });
    expect(record?.kind === 'decision' && record.outcome).toBe('QUARANTINE');
  });

  test('a 429 is retried after Retry-After', async () => {
    const network = fakeNetwork();
    const recorded = network.routes.get(viteUrl);
    let calls = 0;
    network.routes.set(viteUrl, (headers) =>
      ++calls === 1 || recorded === undefined
        ? new Response('', { status: 429, headers: { 'retry-after': '2' } })
        : recorded(headers),
    );
    const collected = await collect(network, viteNodes());

    expect(network.sleeps).toEqual([2000]);
    expect(decide(collected.dir, viteNodes(), viteAt).nodes).toEqual([
      { path: 'node_modules/vite', outcome: 'ACCEPT', reasons: [] },
    ]);
  });

  test('a Retry-After over a minute fails the fetch instead of waiting', async () => {
    const network = fakeNetwork();
    network.routes.set(
      viteUrl,
      () =>
        new Response('', { status: 429, headers: { 'retry-after': '3600' } }),
    );
    const collected = await collect(network, viteNodes());

    expect(network.sleeps).toEqual([]);
    expect(sourcesOf(collected.dir).gaps).toEqual([
      `packuments/vite.json: ${viteUrl}: HTTP 429, retry after 3600s`,
    ]);
  });
});

test('without a trusted root, provenance reads as unavailable', async () => {
  const network = fakeNetwork(recordedRoutes(), () =>
    Promise.reject(new Error('tuf-repo-cdn.sigstore.dev unreachable')),
  );
  const collected = await collect(network, viteNodes());

  expect(existsSync(join(collected.dir, 'trusted_root.json'))).toBe(false);
  expect(sourcesOf(collected.dir).gaps).toEqual([
    'trusted_root.json: trusted root: tuf-repo-cdn.sigstore.dev unreachable',
  ]);
  const [record] = decide(collected.dir, viteNodes(), viteAt).records;
  expect(record?.kind === 'decision' && record.evidence.provenance).toEqual({
    kind: 'unavailable',
    reason: 'no trusted root recorded',
  });
  expect(record?.kind === 'decision' && record.outcome).toBe('QUARANTINE');
});

test('trimming a packument keeps every fact the verifier reads', () => {
  const text = readFileSync(
    new URL('collect/ms.json', import.meta.url),
    'utf8',
  );
  const raw: unknown = JSON.parse(text);
  const trimmed = trimPackument(raw);
  const versions = Object.keys(
    Schema.decodeUnknownSync(
      Schema.fromJsonString(
        Schema.Struct({ time: Schema.Record(Schema.String, Schema.String) }),
      ),
    )(text).time,
  ).filter((key) => key !== 'created' && key !== 'modified');
  const facts = (packument: unknown, version: string) =>
    npmPackumentFacts({
      packument,
      name: 'ms',
      version,
      attestations: new Map(),
      trust: { kind: 'unavailable', reason: 'not needed' },
    });

  expect(versions).toHaveLength(32);
  for (const version of versions) {
    expect(facts(trimmed, version)).toEqual(facts(raw, version));
  }

  expect(JSON.stringify(trimmed).length).toBeLessThan(
    JSON.stringify(raw).length / 2,
  );
});

test('a lockfile name that is not an npm name is never fetched or written', async () => {
  const network = fakeNetwork();
  const dir = cacheDir();
  const collected = await collect(
    network,
    [registryNode('../../escape', '1.0.0')],
    dir,
  );

  expect(network.requests.filter((url) => url.includes('escape'))).toEqual([]);
  expect(readdirSync(dir).toSorted()).toEqual(['evidence', 'feed']);
  expect(readdirSync(collected.dir).toSorted()).toEqual([
    'SOURCES.json',
    'trusted_root.json',
  ]);
});
