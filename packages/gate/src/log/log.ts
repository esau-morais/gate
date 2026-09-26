import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { hashChildren, hashLeaf, sameHash, verifyInclusion } from './merkle';
import {
  formatCheckpoint,
  NoteError,
  openNote,
  parseCheckpoint,
  signNote,
  type Checkpoint,
  type NoteSigner,
  type NoteVerifier,
} from './note';
import {
  decodeBundle,
  encodeBundle,
  entryBundlePath,
  hashSize,
  LogError,
  merkleTree,
  tilePath,
  tileWidth,
  type Tree,
} from './tiles';

export { LogError } from './tiles';

function isErrno(error: unknown, code?: string): error is Error {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    (code === undefined || error.code === code)
  );
}

function readLogFile(dir: string, path: string): Uint8Array {
  try {
    return readFileSync(join(dir, path));
  } catch (error) {
    if (isErrno(error)) {
      throw new LogError(`${path} is unreadable: ${error.message}`);
    }

    throw error;
  }
}

export function openTree(dir: string, size: number): Tree {
  const tiles = new Map<string, Uint8Array>();

  return merkleTree(size, (level, index) => {
    const tile = Math.floor(index / tileWidth);
    const count = Math.floor(size / tileWidth ** level);
    const width = Math.min(tileWidth, count - tile * tileWidth);
    const path = tilePath({ level, index: tile, width });
    let bytes = tiles.get(path);
    if (bytes === undefined) {
      bytes = readLogFile(dir, path);
      if (bytes.length !== width * hashSize) {
        throw new LogError(
          `${path} holds ${bytes.length} bytes, not ${width * hashSize}`,
        );
      }

      tiles.set(path, bytes);
    }

    const offset = (index - tile * tileWidth) * hashSize;

    return bytes.subarray(offset, offset + hashSize);
  });
}

function readCheckpoint(dir: string, verifier: NoteVerifier): Checkpoint {
  let checkpoint: Checkpoint;
  try {
    checkpoint = parseCheckpoint(
      openNote(readLogFile(dir, 'checkpoint'), verifier),
    );
  } catch (error) {
    if (error instanceof NoteError || error instanceof LogError) {
      throw new LogError(`checkpoint: ${error.message}`);
    }

    throw error;
  }

  if (checkpoint.origin !== verifier.name) {
    throw new LogError(
      `checkpoint origin ${checkpoint.origin} is not the key name ${verifier.name}`,
    );
  }

  return checkpoint;
}

function writeAtomically(path: string, bytes: Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  const fd = openSync(temporary, 'w', 0o644);
  try {
    writeSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  renameSync(temporary, path);
}

function perfectRoot(hashes: readonly Uint8Array[]): Uint8Array {
  let level = hashes;
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let index = 0; index < level.length; index += 2) {
      const left = level[index];
      const right = level[index + 1];
      if (left === undefined || right === undefined) {
        throw new LogError('a full tile has an odd number of hashes');
      }

      next.push(hashChildren(left, right));
    }

    level = next;
  }

  const [root] = level;
  if (root === undefined) {
    throw new LogError('cannot hash an empty tile');
  }

  return root;
}

function tileLevels(leafHashes: readonly Uint8Array[]): Uint8Array[][] {
  const levels = [[...leafHashes]];
  for (;;) {
    const below = levels.at(-1) ?? [];
    const count = Math.floor(below.length / tileWidth);
    if (count === 0) {
      return levels;
    }

    levels.push(
      Array.from({ length: count }, (_, index) =>
        perfectRoot(below.slice(index * tileWidth, (index + 1) * tileWidth)),
      ),
    );
  }
}

function levelsTree(size: number, levels: readonly Uint8Array[][]): Tree {
  return merkleTree(size, (level, index) => {
    const hash = levels[level]?.[index];
    if (hash === undefined) {
      throw new LogError(`no level ${level} hash ${index}`);
    }

    return hash;
  });
}

function lock(dir: string): () => void {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'lock');
  let fd: number;
  try {
    fd = openSync(path, 'wx');
  } catch (error) {
    if (isErrno(error, 'EEXIST')) {
      throw new LogError(
        `${path} exists: another writer holds the log, or a crashed writer left the lock behind`,
      );
    }

    throw error;
  }

  return () => {
    closeSync(fd);
    rmSync(path);
  };
}

function hasCheckpoint(dir: string): boolean {
  try {
    readFileSync(join(dir, 'checkpoint'));

    return true;
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      return false;
    }

    throw error;
  }
}

function readCarried(dir: string, oldSize: number): Uint8Array[] {
  const width = oldSize % tileWidth;
  if (width === 0) {
    return [];
  }

  const path = entryBundlePath({
    index: Math.floor(oldSize / tileWidth),
    width,
  });
  const entries = decodeBundle(readLogFile(dir, path));
  if (entries.length !== width) {
    throw new LogError(`${path} holds ${entries.length} entries, not ${width}`);
  }

  return entries;
}

export function appendToLog(input: {
  dir: string;
  signer: NoteSigner;
  entries: readonly Uint8Array[];
}): { first: number; size: number } {
  const { dir, signer } = input;
  encodeBundle(input.entries);
  const unlock = lock(dir);
  try {
    const checkpoint = hasCheckpoint(dir)
      ? readCheckpoint(dir, signer.verifier)
      : undefined;
    const oldSize = checkpoint?.size ?? 0;
    const stored = openTree(dir, oldSize);
    const oldLeaves = Array.from({ length: oldSize }, (_, index) =>
      stored.subtreeHash(index, index + 1),
    );
    const leaves = [...oldLeaves, ...input.entries.map(hashLeaf)];
    const levels = tileLevels(leaves);
    if (
      checkpoint !== undefined &&
      !sameHash(levelsTree(oldSize, levels).root(), checkpoint.root)
    ) {
      throw new LogError('log tiles do not match its checkpoint');
    }

    const carried = readCarried(dir, oldSize);
    const firstBundle = Math.floor(oldSize / tileWidth);
    for (const [offset, entry] of carried.entries()) {
      const index = firstBundle * tileWidth + offset;
      if (!sameHash(hashLeaf(entry), oldLeaves[index] ?? new Uint8Array())) {
        throw new LogError(`entry ${index} does not match its level 0 tile`);
      }
    }

    const size = leaves.length;
    for (const [level, hashes] of levels.entries()) {
      const oldCount = Math.floor(oldSize / tileWidth ** level);
      if (hashes.length === oldCount) {
        continue;
      }

      for (
        let index = Math.floor(oldCount / tileWidth);
        index * tileWidth < hashes.length;
        index += 1
      ) {
        const width = Math.min(tileWidth, hashes.length - index * tileWidth);
        writeAtomically(
          join(dir, tilePath({ level, index, width })),
          Buffer.concat(
            hashes.slice(index * tileWidth, index * tileWidth + width),
          ),
        );
      }
    }

    const pending = [...carried, ...input.entries];
    for (
      let index = firstBundle;
      size > oldSize && index * tileWidth < size;
      index += 1
    ) {
      const offset = (index - firstBundle) * tileWidth;
      const width = Math.min(tileWidth, size - index * tileWidth);
      writeAtomically(
        join(dir, entryBundlePath({ index, width })),
        encodeBundle(pending.slice(offset, offset + width)),
      );
    }

    writeAtomically(
      join(dir, 'checkpoint'),
      signNote(
        formatCheckpoint({
          origin: signer.name,
          size,
          root: levelsTree(size, levels).root(),
          extensions: [],
        }),
        signer,
      ),
    );

    return { first: oldSize, size };
  } finally {
    unlock();
  }
}

export type LogEntry =
  | {
      readonly index: number;
      readonly kind: 'included';
      readonly bytes: Uint8Array;
    }
  | { readonly index: number; readonly kind: 'failed'; readonly error: string };

export type LogRead =
  | {
      readonly kind: 'read';
      readonly checkpoint: Checkpoint;
      readonly entries: () => LogEntry[];
    }
  | { readonly kind: 'unreadable'; readonly error: string };

function bundleEntries(
  dir: string,
  bundle: { index: number; width: number },
): Uint8Array[] | string {
  const path = entryBundlePath(bundle);
  try {
    const entries = decodeBundle(readLogFile(dir, path));

    return entries.length === bundle.width
      ? entries
      : `${path} holds ${entries.length} entries, not ${bundle.width}`;
  } catch (error) {
    if (error instanceof LogError) {
      return `${path}: ${error.message}`;
    }

    throw error;
  }
}

function proveEntries(dir: string, checkpoint: Checkpoint): LogEntry[] {
  const { size, root } = checkpoint;
  const tree = openTree(dir, size);
  const results: LogEntry[] = [];
  for (let bundle = 0; bundle * tileWidth < size; bundle += 1) {
    const width = Math.min(tileWidth, size - bundle * tileWidth);
    const entries = bundleEntries(dir, { index: bundle, width });
    for (let offset = 0; offset < width; offset += 1) {
      const index = bundle * tileWidth + offset;
      const bytes = typeof entries === 'string' ? undefined : entries[offset];
      if (bytes === undefined) {
        results.push({
          index,
          kind: 'failed',
          error:
            typeof entries === 'string' ? entries : `entry ${index} is missing`,
        });
        continue;
      }

      let proof: Uint8Array[];
      try {
        proof = tree.inclusionProof(index);
      } catch (error) {
        if (error instanceof LogError) {
          results.push({ index, kind: 'failed', error: error.message });
          continue;
        }

        throw error;
      }

      results.push(
        verifyInclusion({ index, size, leafHash: hashLeaf(bytes), proof, root })
          ? { index, kind: 'included', bytes }
          : {
              index,
              kind: 'failed',
              error: `entry ${index} fails its inclusion proof against the checkpoint root`,
            },
      );
    }
  }

  return results;
}

export function readLog(input: {
  dir: string;
  verifier: NoteVerifier;
}): LogRead {
  let checkpoint: Checkpoint;
  try {
    checkpoint = readCheckpoint(input.dir, input.verifier);
  } catch (error) {
    if (error instanceof LogError) {
      return { kind: 'unreadable', error: error.message };
    }

    throw error;
  }

  return {
    kind: 'read',
    checkpoint,
    entries: () => proveEntries(input.dir, checkpoint),
  };
}
