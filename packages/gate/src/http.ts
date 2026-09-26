export type Fetch = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<Response>;

export type HttpClient = {
  readonly fetch: Fetch;
  readonly now: () => Date;
  readonly sleep: (ms: number) => Promise<void>;
};

export type HttpResult =
  | { readonly kind: 'response'; readonly response: Response }
  | { readonly kind: 'failed'; readonly reason: string };

const attempts = 3;
const defaultRetryMs = 1_000;
const maxRetryMs = 60_000;

function retryAfterMs(response: Response, now: Date): number {
  const header = response.headers.get('retry-after');
  if (header === null) {
    return defaultRetryMs;
  }

  if (/^\d+$/.test(header.trim())) {
    return Number(header.trim()) * 1000;
  }

  const date = Date.parse(header);

  return Number.isNaN(date)
    ? defaultRetryMs
    : Math.max(0, date - now.getTime());
}

export async function request(
  client: HttpClient,
  url: string,
  headers: Record<string, string> = {},
  timeoutMs = 60_000,
): Promise<HttpResult> {
  let reason = 'not attempted';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let response: Response;
    try {
      response = await client.fetch(url, {
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      return {
        kind: 'failed',
        reason: `request failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    if (response.status !== 429 && response.status !== 503) {
      return { kind: 'response', response };
    }

    await response.body?.cancel();
    const wait = retryAfterMs(response, client.now());
    reason = `HTTP ${response.status} after ${attempt} attempts`;
    if (wait > maxRetryMs) {
      return {
        kind: 'failed',
        reason: `HTTP ${response.status}, retry after ${Math.ceil(wait / 1000)}s`,
      };
    }

    if (attempt < attempts) {
      await client.sleep(wait);
    }
  }

  return { kind: 'failed', reason };
}

export async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      const item = items[index];
      if (item !== undefined) {
        results[index] = await run(item);
      }
    }
  };

  await Promise.all(Array.from({ length: limit }, worker));

  return results;
}
