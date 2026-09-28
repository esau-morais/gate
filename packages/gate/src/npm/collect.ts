import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { mapConcurrent, type HttpClient } from '../http';
import { formatGap, isEvidenceName } from './evidence-directory';
import type { LockfileNode } from './lockfile';
import { fetchMalwareFeed, type FeedSnapshot } from './malware-feed';
import { addedDependencyPackages } from './evidence';
import { attestedVersions, npmPackumentFacts } from './packument';
import {
  fetchAttestations,
  fetchPackument,
  type Fetched,
  type RegistryCache,
} from './registry';
import { trustedRootUrl } from './trusted-root';

const concurrency = 16;
const safeVersion = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/;

export type CollectSources = {
  readonly http: HttpClient;
  readonly trustedRoot: () => Promise<unknown>;
};

export type Collected = {
  readonly dir: string;
  readonly gaps: readonly string[];
};

type SourceFile = {
  path: string;
  url: string;
  fetchedAt: string;
  sha256?: string;
  commit?: string;
};

type TrustResult =
  | { kind: 'fetched'; fetchedAt: Date; body: unknown }
  | { kind: 'failed'; reason: string };

async function fetchTrust(sources: CollectSources): Promise<TrustResult> {
  try {
    const body = await sources.trustedRoot();

    return { kind: 'fetched', fetchedAt: sources.http.now(), body };
  } catch (error) {
    return {
      kind: 'failed',
      reason: `trusted root: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function registryTargets(
  nodes: readonly LockfileNode[],
): Map<string, Set<string>> {
  const targets = new Map<string, Set<string>>();
  for (const node of nodes) {
    if (
      node.kind === 'package' &&
      node.source.kind === 'registry' &&
      node.version !== null &&
      isEvidenceName(node.name)
    ) {
      targets.set(
        node.name,
        (targets.get(node.name) ?? new Set()).add(node.version),
      );
    }
  }

  return targets;
}

function writeJson(root: string, path: string, value: unknown): void {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}

function writeFeed(
  root: string,
  feed: FeedSnapshot,
  names: readonly string[],
): SourceFile[] {
  const [first, ...rest] = names;
  if (feed.kind === 'unavailable' || first === undefined) {
    return [];
  }

  const fetchedAt = feed.fetchedAt.toISOString();
  writeJson(root, 'osv/manifest.json', {
    capturedAt: fetchedAt,
    packages: [first, ...rest],
    source: {
      url: feed.url,
      commit: feed.commit,
      committedAt: feed.committedAt.toISOString(),
    },
  });
  for (const record of feed.records) {
    writeJson(root, `osv/${record.id}.json`, record.body);
  }

  return [
    {
      path: 'osv/',
      url: feed.url,
      fetchedAt,
      commit: feed.commit,
    },
  ];
}

export async function collectEvidence(input: {
  nodes: readonly LockfileNode[];
  cacheDir: string;
  sources: CollectSources;
}): Promise<Collected> {
  const { cacheDir, sources } = input;
  const registry: RegistryCache = {
    dir: join(cacheDir, 'registry'),
    http: sources.http,
  };
  const names = [
    ...new Set(
      input.nodes.flatMap((node) =>
        node.kind === 'package' && isEvidenceName(node.name) ? [node.name] : [],
      ),
    ),
  ].toSorted();
  const targets = registryTargets(input.nodes);

  const feed = fetchMalwareFeed({
    http: sources.http,
    dir: join(cacheDir, 'feed'),
    names: new Set(names),
  }).catch((error: unknown): FeedSnapshot => ({
    kind: 'unavailable',
    reason: `malicious-packages snapshot: ${error instanceof Error ? error.message : String(error)}`,
  }));
  const trust = fetchTrust(sources);
  const packuments = await mapConcurrent(
    [...targets.keys()],
    concurrency,
    async (name) => ({
      name,
      fetched: await fetchPackument(registry, name),
    }),
  );
  const dependencyNames = new Set<string>();
  for (const { name, fetched } of packuments) {
    if (fetched.kind === 'failed') {
      continue;
    }

    for (const version of targets.get(name) ?? []) {
      const facts = npmPackumentFacts({
        packument: fetched.body,
        name,
        version,
        attestations: new Map(),
        trust: {
          kind: 'unavailable',
          reason: 'not needed to list dependencies',
        },
      });
      if (facts.kind === 'read') {
        for (const added of addedDependencyPackages(
          facts.target,
          facts.earlier,
        )) {
          if (!targets.has(added) && isEvidenceName(added)) {
            dependencyNames.add(added);
          }
        }
      }
    }
  }

  const dependencyPackuments = await mapConcurrent(
    [...dependencyNames].toSorted(),
    concurrency,
    async (name) => ({
      name,
      fetched: await fetchPackument(registry, name),
    }),
  );
  const wanted = new Map<string, { name: string; version: string }>();
  const skipped: string[] = [];
  for (const { name, fetched } of packuments) {
    if (fetched.kind === 'failed') {
      continue;
    }

    for (const target of targets.get(name) ?? []) {
      for (const version of attestedVersions({
        packument: fetched.body,
        name,
        version: target,
      })) {
        if (safeVersion.test(version)) {
          wanted.set(`${name}@${version}`, { name, version });
        } else {
          skipped.push(
            formatGap({
              path: `attestations/${name}`,
              reason: `version ${JSON.stringify(version)} is not safe as a file name`,
            }),
          );
        }
      }
    }
  }

  const attestations = await mapConcurrent(
    [...wanted.values()],
    concurrency,
    async ({ name, version }) => ({
      path: `attestations/${name}@${version}.json`,
      fetched: await fetchAttestations(registry, name, version),
    }),
  );

  const dir = join(cacheDir, 'evidence');
  const staging = `${dir}.${process.pid}.tmp`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  const files: SourceFile[] = [];
  const gaps: string[] = [...skipped];
  const record = (path: string, fetched: Fetched) => {
    if (fetched.kind === 'failed') {
      gaps.push(formatGap({ path, url: fetched.url, reason: fetched.reason }));

      return;
    }

    writeJson(staging, path, fetched.body);
    files.push({
      path,
      url: fetched.url,
      fetchedAt: fetched.fetchedAt.toISOString(),
    });
  };

  for (const { name, fetched } of [...packuments, ...dependencyPackuments]) {
    record(`packuments/${name}.json`, fetched);
  }

  for (const { path, fetched } of attestations) {
    record(path, fetched);
  }

  const snapshot = await feed;
  if (snapshot.kind === 'unavailable') {
    gaps.push(formatGap({ path: 'osv/', reason: snapshot.reason }));
  }

  files.push(...writeFeed(staging, snapshot, names));

  const root = await trust;
  if (root.kind === 'failed') {
    gaps.push(formatGap({ path: 'trusted_root.json', reason: root.reason }));
  } else {
    const text = JSON.stringify(root.body);
    writeFileSync(join(staging, 'trusted_root.json'), text);
    files.push({
      path: 'trusted_root.json',
      url: trustedRootUrl,
      fetchedAt: root.fetchedAt.toISOString(),
      sha256: createHash('sha256').update(text).digest('hex'),
    });
  }

  writeFileSync(
    join(staging, 'SOURCES.json'),
    `${JSON.stringify(
      {
        collectedAt: sources.http.now().toISOString(),
        files,
        gaps,
      },
      null,
      2,
    )}\n`,
  );
  rmSync(dir, { recursive: true, force: true });
  renameSync(staging, dir);

  return { dir, gaps };
}
