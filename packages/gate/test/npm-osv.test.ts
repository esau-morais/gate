import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { feedsFor, readOsvSnapshot } from '../src/npm/osv';

const tanstack = JSON.parse(
  readFileSync(
    new URL('./verify/evidence/osv/MAL-2026-3465.json', import.meta.url),
    'utf8',
  ),
) as unknown;

function entry(affected: Record<string, unknown>, extra = {}) {
  return {
    id: 'MAL-2026-0001',
    published: '2026-01-01T00:00:00Z',
    modified: '2026-01-01T00:00:00Z',
    affected: [{ package: { ecosystem: 'npm', name: 'lib' }, ...affected }],
    ...extra,
  };
}

const capturedAt = '2026-09-26T16:50:56Z';

function snapshotOf(
  records: readonly unknown[],
  manifest: unknown = { capturedAt, packages: 'all' },
) {
  return readOsvSnapshot({ manifest, records });
}

const at = (time: string) => new Date(time);
const hitIds = (feeds: ReturnType<typeof feedsFor>) =>
  feeds.kind === 'checked' ? feeds.hits.map((hit) => hit.id) : feeds;

describe('OSV malicious-packages snapshot', () => {
  const snapshot = snapshotOf([tanstack]);

  test('a listed version hits once the feed imported it', () => {
    const query = { name: '@tanstack/react-router', version: '1.169.8' };

    expect(
      hitIds(feedsFor(snapshot, { ...query, at: at('2026-05-12T01:08:51Z') })),
    ).toEqual([]);
    expect(
      hitIds(feedsFor(snapshot, { ...query, at: at('2026-05-12T01:08:52Z') })),
    ).toEqual(['MAL-2026-3465']);
  });

  test('other versions and packages do not hit', () => {
    const later = at('2026-09-26T00:00:00Z');

    expect(
      hitIds(
        feedsFor(snapshot, {
          name: '@tanstack/react-router',
          version: '1.169.2',
          at: later,
        }),
      ),
    ).toEqual([]);
    expect(
      hitIds(feedsFor(snapshot, { name: 'vite', version: '8.3.0', at: later })),
    ).toEqual([]);
  });

  test('a source with no version hits on any entry for its name', () => {
    expect(
      hitIds(
        feedsFor(snapshot, {
          name: '@tanstack/react-router',
          version: null,
          at: at('2026-09-26T00:00:00Z'),
        }),
      ),
    ).toEqual(['MAL-2026-3465']);
  });

  test('an open range from 0 covers every version', () => {
    const all = snapshotOf([
      entry({ ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }] }] }),
    ]);

    expect(
      hitIds(
        feedsFor(all, {
          name: 'lib',
          version: '9.0.0',
          at: at('2026-02-01T00:00:00Z'),
        }),
      ),
    ).toEqual(['MAL-2026-0001']);
  });

  test('a range gate does not evaluate leaves that package unchecked', () => {
    const bounded = snapshotOf([
      entry({
        ranges: [
          {
            type: 'SEMVER',
            events: [{ introduced: '1.0.0' }, { fixed: '1.2.0' }],
          },
        ],
      }),
    ]);
    const query = { version: '1.1.0', at: at('2026-02-01T00:00:00Z') };

    expect(feedsFor(bounded, { ...query, name: 'lib' }).kind).toBe(
      'unavailable',
    );
    expect(feedsFor(bounded, { ...query, name: 'other' }).kind).toBe('checked');
  });

  test('a withdrawn entry stops hitting when withdrawn', () => {
    const withdrawn = snapshotOf([
      entry({ versions: ['1.0.0'] }, { withdrawn: '2026-01-10T00:00:00Z' }),
    ]);
    const query = { name: 'lib', version: '1.0.0' };

    expect(
      hitIds(feedsFor(withdrawn, { ...query, at: at('2026-01-05T00:00:00Z') })),
    ).toEqual(['MAL-2026-0001']);
    expect(
      hitIds(feedsFor(withdrawn, { ...query, at: at('2026-01-10T00:00:00Z') })),
    ).toEqual([]);
  });

  test('entries for other ecosystems are ignored', () => {
    const pypi = snapshotOf([
      entry({
        package: { ecosystem: 'PyPI', name: 'lib' },
        versions: ['1.0.0'],
      }),
    ]);

    expect(
      hitIds(
        feedsFor(pypi, {
          name: 'lib',
          version: '1.0.0',
          at: at('2026-02-01T00:00:00Z'),
        }),
      ),
    ).toEqual([]);
  });

  test('one unreadable record makes the whole snapshot unavailable', () => {
    const broken = snapshotOf([tanstack, { id: 'MAL-2026-0002' }]);

    expect(
      feedsFor(broken, {
        name: 'vite',
        version: '8.3.0',
        at: at('2026-09-26T00:00:00Z'),
      }).kind,
    ).toBe('unavailable');
  });

  test('without a manifest the snapshot proves nothing', () => {
    for (const manifest of [undefined, {}, { capturedAt, packages: [] }]) {
      expect(
        feedsFor(readOsvSnapshot({ manifest, records: [] }), {
          name: 'vite',
          version: '8.3.0',
          at: at('2026-09-26T00:00:00Z'),
        }).kind,
      ).toBe('unavailable');
    }
  });

  test('a package the snapshot does not cover is unchecked', () => {
    const partial = snapshotOf([tanstack], {
      capturedAt,
      packages: ['@tanstack/react-router'],
    });
    const query = { version: '8.3.0', at: at('2026-09-26T00:00:00Z') };

    expect(feedsFor(partial, { ...query, name: 'vite' }).kind).toBe(
      'unavailable',
    );
    expect(
      feedsFor(partial, { ...query, name: '@tanstack/react-router' }).kind,
    ).toBe('checked');
  });

  test('a snapshot more than a day old at evaluation time is unavailable', () => {
    const query = { name: 'vite', version: '8.3.0' };

    expect(
      feedsFor(snapshot, { ...query, at: at('2026-09-27T16:50:56Z') }).kind,
    ).toBe('checked');
    expect(
      feedsFor(snapshot, { ...query, at: at('2026-09-27T16:50:57Z') }).kind,
    ).toBe('unavailable');
  });
});
