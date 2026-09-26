import { emptyRoot, hashChildren } from './merkle';

export class LogError extends Error {
  override readonly name = 'LogError';
}

export const tileWidth = 256;
export const hashSize = 32;
const maxEntryBytes = 0xffff;

function indexPath(index: number): string {
  const groups: string[] = [];
  let rest = index;
  do {
    groups.unshift(String(rest % 1000).padStart(3, '0'));
    rest = Math.floor(rest / 1000);
  } while (rest > 0);

  return groups
    .map((group, position) =>
      position < groups.length - 1 ? `x${group}` : group,
    )
    .join('/');
}

function widthSuffix(width: number): string {
  return width === tileWidth ? '' : `.p/${width}`;
}

export function tilePath(tile: {
  level: number;
  index: number;
  width: number;
}): string {
  return `tile/${tile.level}/${indexPath(tile.index)}${widthSuffix(tile.width)}`;
}

export function entryBundlePath(bundle: {
  index: number;
  width: number;
}): string {
  return `tile/entries/${indexPath(bundle.index)}${widthSuffix(bundle.width)}`;
}

export function encodeBundle(entries: readonly Uint8Array[]): Uint8Array {
  const size = entries.reduce((total, entry) => total + 2 + entry.length, 0);
  const bundle = new Uint8Array(size);
  const view = new DataView(bundle.buffer);
  let offset = 0;
  for (const entry of entries) {
    if (entry.length > maxEntryBytes) {
      throw new LogError(
        `an entry of ${entry.length} bytes exceeds the ${maxEntryBytes}-byte limit of an entry bundle`,
      );
    }

    view.setUint16(offset, entry.length);
    bundle.set(entry, offset + 2);
    offset += 2 + entry.length;
  }

  return bundle;
}

export function decodeBundle(bundle: Uint8Array): Uint8Array[] {
  const view = new DataView(bundle.buffer, bundle.byteOffset, bundle.length);
  const entries: Uint8Array[] = [];
  let offset = 0;
  while (offset < bundle.length) {
    if (offset + 2 > bundle.length) {
      throw new LogError('entry bundle ends inside a length prefix');
    }

    const length = view.getUint16(offset);
    if (offset + 2 + length > bundle.length) {
      throw new LogError('entry bundle ends inside an entry');
    }

    entries.push(bundle.subarray(offset + 2, offset + 2 + length));
    offset += 2 + length;
  }

  return entries;
}

export type StoredHash = (level: number, index: number) => Uint8Array;

export type Tree = {
  readonly size: number;
  readonly root: () => Uint8Array;
  readonly subtreeHash: (start: number, end: number) => Uint8Array;
  readonly inclusionProof: (index: number) => Uint8Array[];
};

function largestPowerOfTwoBelow(n: number): number {
  let k = 1;
  while (k * 2 < n) {
    k *= 2;
  }

  return k;
}

function levelOf(n: number): number | undefined {
  let level = 0;
  while (2 ** level < n) {
    level += 1;
  }

  return 2 ** level === n ? level : undefined;
}

export function merkleTree(size: number, stored: StoredHash): Tree {
  const memo = new Map<string, Uint8Array>();
  const remember = (key: string, compute: () => Uint8Array) => {
    const known = memo.get(key);
    if (known !== undefined) {
      return known;
    }

    const hash = compute();
    memo.set(key, hash);

    return hash;
  };

  const storedHash = (level: number, index: number): Uint8Array => {
    const count = Math.floor(size / tileWidth ** level);
    if (index >= count) {
      throw new LogError(
        `a tree of ${size} has no level ${level} hash ${index}`,
      );
    }

    return stored(level, index);
  };

  const nodeHash = (height: number, index: number): Uint8Array =>
    remember(`n${height}/${index}`, () =>
      height % 8 === 0
        ? storedHash(height / 8, index)
        : hashChildren(
            nodeHash(height - 1, index * 2),
            nodeHash(height - 1, index * 2 + 1),
          ),
    );

  const subtreeHash = (start: number, end: number): Uint8Array => {
    const width = end - start;
    if (start < 0 || width < 1 || end > size) {
      throw new LogError(`no subtree [${start}, ${end}) in a tree of ${size}`);
    }

    const height = levelOf(width);
    if (height !== undefined && start % width === 0) {
      return nodeHash(height, start / width);
    }

    return remember(`s${start}-${end}`, () => {
      const k = largestPowerOfTwoBelow(width);

      return hashChildren(
        subtreeHash(start, start + k),
        subtreeHash(start + k, end),
      );
    });
  };

  const path = (index: number, start: number, end: number): Uint8Array[] => {
    if (end - start === 1) {
      return [];
    }

    const k = largestPowerOfTwoBelow(end - start);

    return index < start + k
      ? [...path(index, start, start + k), subtreeHash(start + k, end)]
      : [...path(index, start + k, end), subtreeHash(start, start + k)];
  };

  return {
    size,
    root: () => (size === 0 ? emptyRoot : subtreeHash(0, size)),
    subtreeHash,
    inclusionProof: (index) => {
      if (!Number.isSafeInteger(index) || index < 0 || index >= size) {
        throw new LogError(`no entry ${index} in a tree of ${size}`);
      }

      return path(index, 0, size);
    },
  };
}
