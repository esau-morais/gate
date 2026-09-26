import { expect, test } from 'bun:test';
import { defaultCacheDir, evidenceSource } from '../src/verify-defaults';

const home = '/home/u';

test('Linux uses XDG_CACHE_HOME, or ~/.cache when it is unset, empty or relative', () => {
  const linux = (env: Record<string, string>) =>
    defaultCacheDir({ platform: 'linux', env, home });

  expect(linux({ XDG_CACHE_HOME: '/var/cache/u' })).toBe('/var/cache/u/gate');
  for (const env of [{}, { XDG_CACHE_HOME: '' }, { XDG_CACHE_HOME: 'c' }]) {
    expect(linux(env)).toBe('/home/u/.cache/gate');
  }
});

test('macOS uses ~/Library/Caches and ignores XDG_CACHE_HOME', () => {
  expect(
    defaultCacheDir({
      platform: 'darwin',
      env: { XDG_CACHE_HOME: '/x' },
      home: '/Users/u',
    }),
  ).toBe('/Users/u/Library/Caches/gate');
});

test('Windows uses LOCALAPPDATA, or its documented default under the profile', () => {
  const windows = (env: Record<string, string>) =>
    defaultCacheDir({ platform: 'win32', env, home: 'C:\\Users\\u' });

  expect(windows({ LOCALAPPDATA: 'D:\\Local' })).toBe('D:\\Local\\gate\\cache');
  for (const env of [{}, { LOCALAPPDATA: '' }, { LOCALAPPDATA: 'Local' }]) {
    expect(windows(env)).toBe('C:\\Users\\u\\AppData\\Local\\gate\\cache');
  }
});

const cache = () => '/home/u/.cache/gate';

test('without --evidence or --fetch, evidence is fetched into the default cache', () => {
  expect(
    evidenceSource({ evidence: undefined, fetch: undefined }, cache),
  ).toEqual({ kind: 'fetch', cacheDir: '/home/u/.cache/gate' });
});

test('--fetch and --evidence override the default cache', () => {
  expect(evidenceSource({ evidence: undefined, fetch: '/c' }, cache)).toEqual({
    kind: 'fetch',
    cacheDir: '/c',
  });
  expect(evidenceSource({ evidence: '/e', fetch: undefined }, cache)).toEqual({
    kind: 'recorded',
    dir: '/e',
  });
});

test('--evidence and --fetch together conflict', () => {
  expect(evidenceSource({ evidence: '/e', fetch: '/c' }, cache)).toEqual({
    kind: 'conflict',
  });
});
