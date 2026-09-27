import { expect, test } from 'bun:test';
import {
  defaultCacheDir,
  defaultLockfile,
  evidenceSource,
  lockfileFormat,
} from '../src/verify-defaults';

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

test('without --lockfile, the one lockfile in the directory is chosen', () => {
  const inDir =
    (...names: string[]) =>
    (name: string) =>
      names.includes(name);

  expect(defaultLockfile(inDir('package-lock.json'))).toEqual({
    kind: 'found',
    path: 'package-lock.json',
  });
  expect(defaultLockfile(inDir('pnpm-lock.yaml'))).toEqual({
    kind: 'found',
    path: 'pnpm-lock.yaml',
  });
  expect(defaultLockfile(inDir('package-lock.json', 'pnpm-lock.yaml'))).toEqual(
    { kind: 'ambiguous' },
  );
  expect(defaultLockfile(inDir())).toEqual({ kind: 'none' });
});

test('the format comes from the file name, then the content', () => {
  expect(lockfileFormat('a/package-lock.json', '')).toBe('package-lock');
  expect(lockfileFormat('npm-shrinkwrap.json', '')).toBe('package-lock');
  expect(lockfileFormat('pnpm-lock.yaml', '{}')).toBe('pnpm-lock');
  expect(lockfileFormat('x.pnpm-lock.yml', '{}')).toBe('pnpm-lock');
  expect(lockfileFormat('lock', ' \n{"lockfileVersion": 3}')).toBe(
    'package-lock',
  );
  expect(lockfileFormat('lock', "lockfileVersion: '9.0'")).toBe('pnpm-lock');
  expect(lockfileFormat('lock', '---\nlockfileVersion: 9.0')).toBe('pnpm-lock');
});
