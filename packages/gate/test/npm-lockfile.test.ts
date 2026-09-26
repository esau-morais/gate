import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Sha512Integrity } from '../src/evidence';
import { readPackageLock, type LockfileNode } from '../src/npm/lockfile';
import { recordedLock } from './workspaces/locks';

const sha512 = Sha512Integrity.make(`sha512-${'A'.repeat(86)}==`);

function lock(packages: Record<string, unknown>, lockfileVersion = 3) {
  return JSON.stringify({
    name: 'app',
    lockfileVersion,
    packages: { '': { name: 'app' }, ...packages },
  });
}

function nodes(text: string): readonly LockfileNode[] {
  const read = readPackageLock(text);
  if (read.kind !== 'read') {
    throw new Error(read.error);
  }

  return read.nodes;
}

function only(text: string): LockfileNode {
  const [node, ...rest] = nodes(text);
  if (node === undefined || rest.length > 0) {
    throw new Error('expected exactly one node');
  }

  return node;
}

const registryEntry = {
  version: '1.0.0',
  resolved: 'https://registry.npmjs.org/lib/-/lib-1.0.0.tgz',
  integrity: sha512,
};

describe('lockfile versions', () => {
  test('v1 and unknown versions are unreadable, not empty', () => {
    for (const version of [1, 4]) {
      expect(readPackageLock(lock({}, version)).kind).toBe('unreadable');
    }

    expect(readPackageLock('{"lockfileVersion":3}').kind).toBe('unreadable');
    expect(readPackageLock('not json').kind).toBe('unreadable');
  });

  test('v2 and v3 read the packages map', () => {
    for (const version of [2, 3]) {
      expect(
        nodes(lock({ 'node_modules/lib': registryEntry }, version)),
      ).toHaveLength(1);
    }
  });
});

describe('registry entries', () => {
  test('keep name, version, sha512 integrity and flags', () => {
    expect(
      only(
        lock({
          'node_modules/a/node_modules/@s/lib': {
            ...registryEntry,
            resolved: 'https://registry.npmjs.org/@s/lib/-/lib-1.0.0.tgz',
            dev: true,
            optional: true,
            hasInstallScript: true,
          },
        }),
      ),
    ).toEqual({
      kind: 'package',
      path: 'node_modules/a/node_modules/@s/lib',
      name: '@s/lib',
      version: '1.0.0',
      source: { kind: 'registry', integrity: sha512 },
      dev: true,
      optional: true,
      hasInstallScript: true,
    });
  });

  test('a tarball of another package or version is unreadable', () => {
    for (const resolved of [
      'https://registry.npmjs.org/lib/-/lib-1.0.1.tgz',
      'https://registry.npmjs.org/evil/-/evil-1.0.0.tgz',
    ]) {
      expect(
        only(lock({ 'node_modules/lib': { ...registryEntry, resolved } })).kind,
      ).toBe('unreadable');
    }
  });

  test('a tarball on another host is a url source', () => {
    const resolved = 'https://example.com/lib/-/lib-1.0.0.tgz';

    expect(
      only(lock({ 'node_modules/lib': { ...registryEntry, resolved } })),
    ).toMatchObject({ source: { kind: 'url', spec: resolved } });
  });

  test('an alias is evaluated as the package it installs', () => {
    expect(
      only(
        lock({
          'node_modules/alias': {
            ...registryEntry,
            name: 'lib',
          },
        }),
      ),
    ).toMatchObject({ path: 'node_modules/alias', name: 'lib' });
  });

  test('only a sha512 integrity ties the entry to bytes', () => {
    const sha1 = 'sha1-2jmj7l5rSw0yVb/vlWAYkK/YBwk=';
    const read = (integrity: string) =>
      only(lock({ 'node_modules/lib': { ...registryEntry, integrity } }));

    expect(read(sha1)).toMatchObject({
      source: { kind: 'registry', integrity: null },
    });
    expect(read(`${sha1} ${sha512}`)).toMatchObject({
      source: { kind: 'registry', integrity: sha512 },
    });
    expect(read('sha512-short')).toMatchObject({
      source: { kind: 'registry', integrity: null },
    });
  });

  test('two different sha512 digests tie the entry to no bytes', () => {
    const other = `sha512-${'B'.repeat(86)}==`;
    const read = (integrity: string) =>
      only(lock({ 'node_modules/lib': { ...registryEntry, integrity } }));

    expect(read(`${sha512} ${other}`)).toMatchObject({
      source: { kind: 'registry', integrity: null },
    });
    expect(read(`${sha512} ${sha512}`)).toMatchObject({
      source: { kind: 'registry', integrity: sha512 },
    });
  });

  test('a registry entry without a version is unreadable', () => {
    expect(
      only(lock({ 'node_modules/lib': { resolved: registryEntry.resolved } }))
        .kind,
    ).toBe('unreadable');
  });

  test('an unreadable entry does not hide the others', () => {
    expect(
      nodes(
        lock({
          'node_modules/bad': { version: 1 },
          'node_modules/lib': registryEntry,
        }),
      ).map((node) => node.kind),
    ).toEqual(['unreadable', 'package']);
  });

  test('bundled entries ship inside their parent and are not nodes', () => {
    expect(
      nodes(
        lock({
          'node_modules/lib': registryEntry,
          'node_modules/lib/node_modules/inner': {
            version: '2.0.0',
            inBundle: true,
          },
        }),
      ).map((node) => node.path),
    ).toEqual(['node_modules/lib']);
  });
});

describe('exotic sources', () => {
  const commit = '79ac49eedf774dd4b0cfa308722bc463cfe5885c';

  test('git entries must pin a full commit', () => {
    const git = (resolved: string) =>
      only(lock({ 'node_modules/g': { version: '1.0.0', resolved } }));

    expect(git(`git+ssh://git@github.com/o/r.git#${commit}`)).toMatchObject({
      source: {
        kind: 'git',
        spec: `git+ssh://git@github.com/o/r.git#${commit}`,
      },
    });
    for (const resolved of [
      'git+ssh://git@github.com/o/r.git#main',
      'git+ssh://git@github.com/o/r.git#79ac49e',
      'git+ssh://git@github.com/o/r.git',
    ]) {
      expect(git(resolved).kind).toBe('unreadable');
    }
  });

  test('links and file: entries are file sources', () => {
    expect(
      nodes(
        lock({
          'node_modules/w': { resolved: 'packages/w', link: true },
          'node_modules/t': { version: '1.0.0', resolved: 'file:vendor/t.tgz' },
        }),
      ).map((node) => node.kind === 'package' && node.source),
    ).toEqual([
      { kind: 'file', spec: 'packages/w' },
      { kind: 'file', spec: 'file:vendor/t.tgz' },
    ]);
  });

  test('a declared git dependency with no entry becomes its own node', () => {
    expect(
      nodes(
        lock({
          'node_modules/lib': {
            ...registryEntry,
            optionalDependencies: { setup: `github:o/r#${commit}` },
          },
        }),
      ),
    ).toEqual([
      expect.objectContaining({ kind: 'package', path: 'node_modules/lib' }),
      {
        kind: 'package',
        path: 'node_modules/lib',
        dependency: 'setup',
        name: 'setup',
        version: null,
        source: { kind: 'git', spec: `github:o/r#${commit}` },
        dev: false,
        optional: true,
        hasInstallScript: null,
      },
    ]);
  });

  test('a declared exotic devDependency is a dev node', () => {
    expect(
      nodes(
        lock({
          '': {
            name: 'app',
            devDependencies: { tool: `github:o/r#${commit}` },
          },
        }),
      ),
    ).toMatchObject([{ dependency: 'tool', dev: true, optional: false }]);
  });

  test('a declared exotic dependency without a pinned commit is unreadable', () => {
    expect(
      nodes(
        lock({
          'node_modules/lib': {
            ...registryEntry,
            dependencies: { setup: 'o/r#main' },
          },
        }),
      ).map((node) => node.kind),
    ).toEqual(['package', 'unreadable']);
  });

  test('a declared exotic dependency that is installed is read from its entry', () => {
    const spec = `github:o/r#${commit}`;
    const entry = {
      version: '1.0.0',
      resolved: `git+ssh://git@github.com/o/r.git#${commit}`,
    };

    expect(
      nodes(
        lock({
          '': { name: 'app', dependencies: { setup: spec } },
          'node_modules/lib': {
            ...registryEntry,
            dependencies: { setup: spec },
          },
          'node_modules/setup': entry,
        }),
      ).map((node) => node.path),
    ).toEqual(['node_modules/lib', 'node_modules/setup']);
  });

  test('declared registry ranges are not nodes', () => {
    expect(
      nodes(
        lock({
          'node_modules/lib': {
            ...registryEntry,
            dependencies: { a: '^1.0.0', b: 'npm:c@^2.0.0', d: 'latest' },
          },
        }),
      ),
    ).toHaveLength(1);
  });
});

test('the recorded TanStack lockfile declares the injected git dependency', () => {
  const text = readFileSync(
    new URL(
      './verify/cases/tanstack-react-router-1.169.8/package-lock.json',
      import.meta.url,
    ),
    'utf8',
  );

  expect(
    nodes(text).map((node) =>
      node.kind === 'package'
        ? [node.name, node.version, node.source.kind]
        : node,
    ),
  ).toEqual([
    ['@tanstack/react-router', '1.169.8', 'registry'],
    ['@tanstack/setup', null, 'git'],
  ]);
});

describe('workspace links', () => {
  const linkNodes = (value: unknown) =>
    nodes(JSON.stringify(value)).flatMap((node) =>
      node.kind === 'package' && node.source.kind === 'file'
        ? [[node.path, node.source.spec]]
        : [],
    );
  const workspace = (
    workspaces: unknown,
    packages: Record<string, unknown>,
  ) => ({
    lockfileVersion: 3,
    packages: { '': { name: 'app', workspaces }, ...packages },
  });

  test('links to the workspaces npm/cli declares are not nodes', () => {
    expect(linkNodes(recordedLock('npm-cli'))).toEqual([]);
  });

  test('links to the workspaces sigstore-js declares with ./packages/* are not nodes', () => {
    expect(linkNodes(recordedLock('sigstore-js'))).toEqual([]);
  });

  test('a link named differently from its workspace stays a file source', () => {
    const lock = recordedLock('sigstore-js');

    expect(
      linkNodes({
        ...lock,
        packages: {
          ...lock.packages,
          'node_modules/sigstore-jest-extended': {
            resolved: 'packages/jest-types',
            link: true,
          },
        },
      }),
    ).toEqual([['node_modules/sigstore-jest-extended', 'packages/jest-types']]);
  });

  test('a link whose target has no entry stays a file source', () => {
    expect(
      linkNodes(
        workspace(['packages/*'], {
          'node_modules/a': { resolved: 'packages/a', link: true },
        }),
      ),
    ).toEqual([['node_modules/a', 'packages/a']]);
  });

  test('a link to a workspace entry that is itself a link stays a file source', () => {
    expect(
      linkNodes(
        workspace(['packages/*'], {
          'node_modules/a': { resolved: 'packages/a', link: true },
          'packages/a': { name: 'a', resolved: '../evil', link: true },
        }),
      ),
    ).toEqual([['node_modules/a', 'packages/a']]);
  });

  test('links to two workspaces with the same name stay file sources', () => {
    expect(
      linkNodes(
        workspace(['packages/*'], {
          'node_modules/a': { resolved: 'packages/a', link: true },
          'packages/a': { version: '1.0.0' },
          'node_modules/b/node_modules/a': {
            resolved: 'packages/c',
            link: true,
          },
          'packages/c': { name: 'a' },
        }),
      ),
    ).toEqual([
      ['node_modules/a', 'packages/a'],
      ['node_modules/b/node_modules/a', 'packages/c'],
    ]);
  });

  test('the {"packages": [...]} form declares workspaces too', () => {
    expect(
      linkNodes(
        workspace(
          { packages: ['packages/*'] },
          {
            'node_modules/a': { resolved: 'packages/a', link: true },
            'packages/a': { version: '1.0.0' },
          },
        ),
      ),
    ).toEqual([]);
  });

  test('* and ** do not match folders that start with a dot', () => {
    const packages = {
      'node_modules/a': { resolved: 'packages/.a', link: true },
      'packages/.a': { name: 'a' },
      'node_modules/b': { resolved: 'libs/.hidden/b', link: true },
      'libs/.hidden/b': { version: '1.0.0' },
      'node_modules/c': { resolved: 'libs/x/y/c', link: true },
      'libs/x/y/c': { version: '1.0.0' },
    };

    expect(linkNodes(workspace(['packages/*', 'libs/**'], packages))).toEqual([
      ['node_modules/a', 'packages/.a'],
      ['node_modules/b', 'libs/.hidden/b'],
    ]);
  });

  test('a declaration with a pattern gate cannot match exactly passes no link', () => {
    const packages = {
      'node_modules/a': { resolved: 'packages/a', link: true },
      'packages/a': { version: '1.0.0' },
    };

    for (const unsupported of [
      '!packages/b',
      'packages/{a,b}',
      'packages/[ab]',
      'packages/@(a|b)',
      '#packages/*',
      'packages/*/',
      '../packages/*',
      'packages\\*',
    ]) {
      expect(
        linkNodes(workspace(['packages/*', unsupported], packages)),
      ).toEqual([['node_modules/a', 'packages/a']]);
    }
  });
});

describe('entries outside node_modules', () => {
  const kinds = (packages: Record<string, unknown>) =>
    nodes(lock(packages)).map((node) => [node.path, node.kind]);

  test('a link entry outside node_modules is unreadable', () => {
    expect(
      kinds({
        'vendor/x': { resolved: '../evil', link: true },
        '../evil': { name: 'evil', version: '1.0.0' },
      }),
    ).toEqual([['vendor/x', 'unreadable']]);
  });

  test('a folder entry npm left behind after removing a file: dependency is not a node', () => {
    expect(
      kinds({
        'libs/x': {
          version: '1.0.0',
          extraneous: true,
          hasInstallScript: true,
        },
      }),
    ).toEqual([]);
  });

  test('a declared workspace no link points at is not a node', () => {
    expect(
      nodes(
        JSON.stringify({
          lockfileVersion: 3,
          packages: {
            '': { name: 'app', workspaces: ['packages/*'] },
            'packages/a': { name: 'a', version: '1.0.0' },
          },
        }),
      ),
    ).toEqual([]);
  });

  test('the target of a link is read through the link', () => {
    expect(
      kinds({
        'node_modules/x': { resolved: '../x', link: true },
        '../x': { name: 'x', version: '1.0.0' },
      }),
    ).toEqual([['node_modules/x', 'package']]);
  });
});
