import { readFileSync } from 'node:fs';
import type { Fetch, HttpClient } from '../../src/http';
import type { CollectSources } from '../../src/npm/collect';
import { maliciousPackagesUrl } from '../../src/npm/malware-feed';
import { attestationsUrl, packumentUrl } from '../../src/npm/registry';
import { evidenceDir, recordedEvidence, viteVersions } from '../verify/cases';

export const collectedAt = new Date('2026-09-26T16:50:56Z');

export type Route = (headers: Record<string, string>) => Response;

export const packumentHeaders = {
  'content-type': 'application/json',
  'cache-control': 'public, max-age=300',
};

export function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
}

const collectDir = new URL('./', import.meta.url);

export function feedArchive(dir = collectDir): Uint8Array {
  return new Uint8Array(
    readFileSync(new URL('malicious-packages.tar.gz', dir)),
  );
}

export function recordedRoutes(
  evidence = evidenceDir,
  collect = collectDir,
): Map<string, Route> {
  return new Map<string, Route>([
    ...['vite', '@tanstack/react-router'].map((name): [string, Route] => [
      packumentUrl(name),
      () =>
        json(recordedEvidence(`packuments/${name}.json`, evidence), {
          headers: packumentHeaders,
        }),
    ]),
    ...viteVersions.map((version): [string, Route] => [
      attestationsUrl('vite', version),
      () =>
        json(recordedEvidence(`attestations/vite@${version}.json`, evidence)),
    ]),
    [maliciousPackagesUrl, () => new Response(feedArchive(collect))],
  ]);
}

export type FakeNetwork = {
  readonly sources: CollectSources;
  readonly requests: string[];
  readonly sleeps: number[];
  readonly routes: Map<string, Route>;
  advance(ms: number): void;
};

export function fakeNetwork(
  routes: Map<string, Route> = recordedRoutes(),
  trustedRoot: () => Promise<unknown> = () =>
    Promise.resolve(recordedEvidence('trusted_root.json')),
): FakeNetwork {
  let now = collectedAt.getTime();
  const requests: string[] = [];
  const sleeps: number[] = [];
  const fetch: Fetch = (url, init) => {
    requests.push(url);
    const route = routes.get(url);

    return route === undefined
      ? Promise.reject(new TypeError(`${url} is not recorded`))
      : Promise.resolve(route(init.headers));
  };

  const http: HttpClient = {
    fetch,
    now: () => new Date(now),
    sleep: (ms) => {
      sleeps.push(ms);
      now += ms;

      return Promise.resolve();
    },
  };

  return {
    sources: { http, trustedRoot },
    requests,
    sleeps,
    routes,
    advance: (ms) => {
      now += ms;
    },
  };
}
