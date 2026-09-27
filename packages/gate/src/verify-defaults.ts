import { posix, win32 } from 'node:path';

export function defaultCacheDir(input: {
  platform: NodeJS.Platform;
  env: Readonly<Record<string, string | undefined>>;
  home: string;
}): string {
  const { platform, env, home } = input;
  if (platform === 'win32') {
    const local = env['LOCALAPPDATA'];

    return win32.join(
      local !== undefined && win32.isAbsolute(local)
        ? local
        : win32.join(home, 'AppData', 'Local'),
      'gate',
      'cache',
    );
  }

  if (platform === 'darwin') {
    return posix.join(home, 'Library', 'Caches', 'gate');
  }

  const xdg = env['XDG_CACHE_HOME'];

  return posix.join(
    xdg !== undefined && posix.isAbsolute(xdg)
      ? xdg
      : posix.join(home, '.cache'),
    'gate',
  );
}

export type EvidenceSource =
  | { readonly kind: 'recorded'; readonly dir: string }
  | { readonly kind: 'fetch'; readonly cacheDir: string }
  | { readonly kind: 'conflict' };

export function evidenceSource(
  flags: {
    readonly evidence: string | undefined;
    readonly fetch: string | undefined;
  },
  defaultCache: () => string,
): EvidenceSource {
  if (flags.evidence === undefined) {
    return { kind: 'fetch', cacheDir: flags.fetch ?? defaultCache() };
  }

  return flags.fetch === undefined
    ? { kind: 'recorded', dir: flags.evidence }
    : { kind: 'conflict' };
}

export const lockfileNames = ['package-lock.json', 'pnpm-lock.yaml'] as const;

export type LockfileChoice =
  | { readonly kind: 'found'; readonly path: string }
  | { readonly kind: 'none' }
  | { readonly kind: 'ambiguous' };

export function defaultLockfile(
  exists: (name: string) => boolean,
): LockfileChoice {
  const [found, ...others] = lockfileNames.filter(exists);
  if (found === undefined) {
    return { kind: 'none' };
  }

  return others.length === 0
    ? { kind: 'found', path: found }
    : { kind: 'ambiguous' };
}

export function lockfileFormat(
  path: string,
  text: string,
): 'package-lock' | 'pnpm-lock' {
  if (path.endsWith('.json')) {
    return 'package-lock';
  }

  if (path.endsWith('.yaml') || path.endsWith('.yml')) {
    return 'pnpm-lock';
  }

  return text.trimStart().startsWith('{') ? 'package-lock' : 'pnpm-lock';
}
