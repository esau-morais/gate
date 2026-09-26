import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Option, Schema } from 'effect';
import { request, type HttpClient } from '../http';
import { UtcTimestamp } from '../time';
import { npmRegistry } from './lockfile';

export type Fetched =
  | {
      readonly kind: 'fetched';
      readonly url: string;
      readonly fetchedAt: Date;
      readonly body: unknown;
    }
  | { readonly kind: 'failed'; readonly url: string; readonly reason: string };

const CacheEntry = Schema.fromJsonString(
  Schema.Struct({
    url: Schema.String,
    fetchedAt: UtcTimestamp,
    maxAgeSeconds: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    etag: Schema.optionalKey(Schema.String),
    body: Schema.Unknown,
  }),
);
type CacheEntry = typeof CacheEntry.Type;
const decodeEntry = Schema.decodeUnknownOption(CacheEntry);
const encodeEntry = Schema.encodeSync(CacheEntry);

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const keep = (value: unknown) => value;

function pick(
  value: unknown,
  fields: Readonly<Record<string, (field: unknown) => unknown>>,
): unknown {
  if (!isRecord(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(fields)
      .filter(([key]) => Object.hasOwn(value, key))
      .map(([key, trim]) => [key, trim(value[key])]),
  );
}

const trimVersion = (doc: unknown) =>
  pick(doc, {
    name: keep,
    version: keep,
    scripts: keep,
    gypfile: keep,
    _npmUser: (user) => pick(user, { name: keep }),
    dist: (dist) =>
      pick(dist, {
        integrity: keep,
        shasum: keep,
        tarball: keep,
        attestations: keep,
      }),
  });

export function trimPackument(packument: unknown): unknown {
  return pick(packument, {
    name: keep,
    time: keep,
    versions: (versions) =>
      isRecord(versions)
        ? Object.fromEntries(
            Object.entries(versions).map(([version, doc]) => [
              version,
              trimVersion(doc),
            ]),
          )
        : versions,
  });
}

function escapedName(name: string): string {
  return name.replace('/', '%2f');
}

export function packumentUrl(name: string): string {
  return `${npmRegistry}/${escapedName(name)}`;
}

export function attestationsUrl(name: string, version: string): string {
  return `${npmRegistry}/-/npm/v1/attestations/${escapedName(name)}@${encodeURIComponent(version)}`;
}

function maxAgeSeconds(response: Response): number {
  const header = response.headers.get('cache-control') ?? '';
  if (/(^|,)\s*(no-store|no-cache)\s*(,|$)/.test(header)) {
    return 0;
  }

  const match = /(^|,)\s*max-age=(\d+)\s*(,|$)/.exec(header);

  return match?.[2] === undefined ? 0 : Number(match[2]);
}

function readEntry(path: string): CacheEntry | undefined {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }

  return Option.getOrUndefined(decodeEntry(text));
}

function writeEntry(path: string, entry: CacheEntry): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, encodeEntry(entry));
  renameSync(temporary, path);
}

async function jsonBody(
  response: Response,
): Promise<{ kind: 'parsed'; body: unknown } | { kind: 'unparsable' }> {
  try {
    return { kind: 'parsed', body: JSON.parse(await response.text()) };
  } catch {
    return { kind: 'unparsable' };
  }
}

export type RegistryCache = { readonly dir: string; readonly http: HttpClient };

export async function fetchPackument(
  cache: RegistryCache,
  name: string,
): Promise<Fetched> {
  const url = packumentUrl(name);
  const path = join(cache.dir, 'packuments', `${name}.json`);
  const cached = readEntry(path);
  const now = cache.http.now();
  const age =
    cached === undefined
      ? undefined
      : now.getTime() - cached.fetchedAt.getTime();
  const fresh =
    cached?.url === url &&
    age !== undefined &&
    age >= 0 &&
    age < cached.maxAgeSeconds * 1000;
  if (cached !== undefined && fresh) {
    return {
      kind: 'fetched',
      url,
      fetchedAt: cached.fetchedAt,
      body: cached.body,
    };
  }

  const headers: Record<string, string> = { accept: 'application/json' };
  if (cached?.url === url && cached.etag !== undefined) {
    headers['if-none-match'] = cached.etag;
  }

  const result = await request(cache.http, url, headers);
  if (result.kind === 'failed') {
    return { kind: 'failed', url, reason: result.reason };
  }

  const { response } = result;
  const fetchedAt = cache.http.now();
  if (
    response.status === 304 &&
    cached !== undefined &&
    headers['if-none-match'] !== undefined
  ) {
    await response.body?.cancel();
    writeEntry(path, {
      ...cached,
      fetchedAt,
      maxAgeSeconds: maxAgeSeconds(response),
    });

    return { kind: 'fetched', url, fetchedAt, body: cached.body };
  }

  if (response.status !== 200) {
    await response.body?.cancel();

    return { kind: 'failed', url, reason: `HTTP ${response.status}` };
  }

  const parsed = await jsonBody(response);
  if (parsed.kind === 'unparsable') {
    return { kind: 'failed', url, reason: 'response is not JSON' };
  }

  const body = trimPackument(parsed.body);
  const etag = response.headers.get('etag');
  writeEntry(path, {
    url,
    fetchedAt,
    maxAgeSeconds: maxAgeSeconds(response),
    ...(etag === null ? {} : { etag }),
    body,
  });

  return { kind: 'fetched', url, fetchedAt, body };
}

export async function fetchAttestations(
  cache: RegistryCache,
  name: string,
  version: string,
): Promise<Fetched> {
  const url = attestationsUrl(name, version);
  const path = join(cache.dir, 'attestations', `${name}@${version}.json`);
  const cached = readEntry(path);
  if (cached?.url === url) {
    return {
      kind: 'fetched',
      url,
      fetchedAt: cached.fetchedAt,
      body: cached.body,
    };
  }

  const result = await request(cache.http, url, { accept: 'application/json' });
  if (result.kind === 'failed') {
    return { kind: 'failed', url, reason: result.reason };
  }

  const { response } = result;
  if (response.status !== 200) {
    await response.body?.cancel();

    return { kind: 'failed', url, reason: `HTTP ${response.status}` };
  }

  const parsed = await jsonBody(response);
  if (parsed.kind === 'unparsable') {
    return { kind: 'failed', url, reason: 'response is not JSON' };
  }

  const fetchedAt = cache.http.now();
  writeEntry(path, { url, fetchedAt, maxAgeSeconds: 0, body: parsed.body });

  return { kind: 'fetched', url, fetchedAt, body: parsed.body };
}
