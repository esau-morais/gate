import { describe, expect, test } from 'bun:test';
import { Schema } from 'effect';
import { format } from 'prettier';
import { Sha512Integrity } from '../src/evidence';
import type { LockfileNode } from '../src/npm/lockfile';
import { readPnpmLock } from '../src/npm/pnpm-lock';
import { recordedPnpmLock, type RecordedPnpmLock } from './pnpm/locks';

const sha512 = Sha512Integrity.make(`sha512-${'A'.repeat(86)}==`);
const commit = '79ac49eedf774dd4b0cfa308722bc463cfe5885c';

function nodes(text: string): readonly LockfileNode[] {
  const read = readPnpmLock(text);
  if (read.kind !== 'read') {
    throw new Error(read.error);
  }

  return read.nodes;
}

function recorded(name: RecordedPnpmLock): readonly LockfileNode[] {
  return nodes(recordedPnpmLock(name));
}

function byPath(
  list: readonly LockfileNode[],
  path: string,
  dependency?: string,
): LockfileNode {
  const [node, ...others] = list.filter(
    (candidate) =>
      candidate.path === path && candidate.dependency === dependency,
  );
  if (node === undefined || others.length > 0) {
    throw new Error(`expected one node at ${path}`);
  }

  return node;
}

function fileNodes(list: readonly LockfileNode[]): string[][] {
  return list.flatMap((node) =>
    node.kind === 'package' && node.source.kind === 'file'
      ? [[node.path, node.dependency ?? '', node.source.spec]]
      : [],
  );
}

type Dependency = { specifier: string; version: string };
type Importer = Partial<
  Record<
    'dependencies' | 'devDependencies' | 'optionalDependencies',
    Record<string, Dependency>
  >
>;

function importerBlock(id: string, importer: Importer): string[] {
  const groups = Object.entries(importer).flatMap(([group, deps]) => [
    `    ${group}:`,
    ...Object.entries(deps).flatMap(([alias, dep]) => [
      `      '${alias}':`,
      `        specifier: '${dep.specifier}'`,
      `        version: '${dep.version}'`,
    ]),
  ]);

  return groups.length === 0 ? [`  '${id}': {}`] : [`  '${id}':`, ...groups];
}

function pnpmLock(input: {
  importers?: Record<string, Importer>;
  packages?: Record<string, string>;
  snapshots?: Record<string, string>;
  version?: string;
  head?: string;
}): string {
  const section = (name: string, entries: Record<string, string>) =>
    Object.keys(entries).length === 0
      ? []
      : [
          `${name}:`,
          ...Object.entries(entries).map(([key, body]) =>
            body === '' ? `  '${key}': {}` : `  '${key}':\n${body}`,
          ),
        ];

  return [
    `lockfileVersion: ${input.version ?? "'9.0'"}`,
    ...(input.head === undefined ? [] : [input.head]),
    'importers:',
    ...Object.entries(input.importers ?? { '.': {} }).flatMap(([id, imp]) =>
      importerBlock(id, imp),
    ),
    ...section('packages', input.packages ?? {}),
    ...section('snapshots', input.snapshots ?? {}),
    '',
  ].join('\n');
}

const registryPackage = `    resolution: {integrity: ${sha512}}`;
const withLib = (importer: Importer = {}) =>
  pnpmLock({
    importers: {
      '.': {
        dependencies: { lib: { specifier: '^1.0.0', version: '1.0.0' } },
        ...importer,
      },
    },
    packages: { 'lib@1.0.0': registryPackage },
    snapshots: { 'lib@1.0.0': '' },
  });

describe('lockfile versions', () => {
  test('pnpm 7 and 8 lockfiles are unreadable, not empty', () => {
    for (const name of [
      'rules-js-v54',
      'rules-js-v60',
      'rules-js-v61',
    ] as const) {
      const read = readPnpmLock(recordedPnpmLock(name));

      expect(read).toMatchObject({ kind: 'unreadable' });
      expect(read.kind === 'unreadable' && read.error).toContain(
        'lockfileVersion',
      );
    }
  });

  test('versions pnpm does not write are unreadable', () => {
    for (const version of ["'9.1'", "'10.0'", "'12.0'", '9.0', '9', "'9'"]) {
      expect(readPnpmLock(withLib().replace("'9.0'", version)).kind).toBe(
        'unreadable',
      );
    }

    expect(readPnpmLock('importers: {}\n').kind).toBe('unreadable');
    expect(readPnpmLock('not: [yaml\n').kind).toBe('unreadable');
    expect(readPnpmLock('').kind).toBe('unreadable');
  });

  test('lockfiles written by pnpm 9, 10, 11 and 12 read', () => {
    for (const name of [
      'rules-js-v90',
      'rules-js-v101',
      'rules-js-v110',
      'rules-js-v120',
      'rules-js-multi-document-v11',
      'vuejs-core',
    ] as const) {
      expect(readPnpmLock(recordedPnpmLock(name)).kind).toBe('read');
    }
  });

  test('a byte order mark and CRLF line endings read as pnpm reads them', () => {
    const text = recordedPnpmLock('rules-js-multi-document-v11');

    expect(nodes(`\uFEFF${text.replaceAll('\n', '\r\n')}`)).toEqual(
      nodes(text),
    );
  });

  test('a lockfile prettier reformatted reads the same', async () => {
    for (const name of ['rules-js-v120', 'vuejs-core'] as const) {
      const text = recordedPnpmLock(name);
      const formatted = await format(text, { parser: 'yaml' });

      expect(formatted).not.toBe(text);
      expect(nodes(formatted)).toEqual(nodes(text));
    }
  });

  test('a third document or an env document alone is unreadable', () => {
    const text = recordedPnpmLock('rules-js-multi-document-v11');
    const env = text.slice(0, text.indexOf('\n---\n') + 1);

    expect(readPnpmLock(`${text}---\n${withLib()}`).kind).toBe('unreadable');
    expect(readPnpmLock(env).kind).toBe('unreadable');
  });

  test('anchors and merge keys are unreadable', () => {
    expect(
      readPnpmLock(withLib().replace('resolution: {', 'resolution: &r {')).kind,
    ).toBe('unreadable');
    expect(
      readPnpmLock(
        withLib().replace(
          `snapshots:\n  'lib@1.0.0': {}`,
          `snapshots:\n  'lib@1.0.0':\n    <<: {dependencies: {evil: 1.0.0}}`,
        ),
      ).kind,
    ).toBe('unreadable');
  });
});

describe('registry packages', () => {
  const v120 = recorded('rules-js-v120');

  test('a snapshot is a registry node with its name, version and sha512 integrity', () => {
    expect(byPath(v120, 'uvu@0.5.6')).toEqual({
      kind: 'package',
      path: 'uvu@0.5.6',
      name: 'uvu',
      version: '0.5.6',
      source: {
        kind: 'registry',
        integrity: Sha512Integrity.make(
          'sha512-+g8ENReyr8YsOc6fv/NVJs2vFdHBnBNdfE49rshrTzDWOlUx4Gq7KOS2GD8eqhy2j+Ejq29+SbKH8yjkAqXqoA==',
        ),
      },
      dev: false,
      optional: false,
      hasInstallScript: null,
    });
  });

  test('every peer variant of a package is its own node', () => {
    expect(
      v120
        .filter(
          (node) => node.kind === 'package' && node.name === '@aspect-test/d',
        )
        .map((node) => node.path),
    ).toEqual([
      '@aspect-test/d@2.0.0(@aspect-test/c@2.0.0)',
      '@aspect-test/d@2.0.0(@aspect-test/c@2.0.1)',
      '@aspect-test/d@2.0.0(@aspect-test/c@2.0.2)',
    ]);
  });

  test('npm: aliases resolve to the package they install', () => {
    expect(v120.filter((node) => node.kind === 'unreadable')).toEqual([]);
    expect(byPath(v120, 'is-odd@0.1.0')).toMatchObject({
      name: 'is-odd',
      version: '0.1.0',
      source: { kind: 'registry' },
    });
  });

  test('a missing or non-sha512 integrity is null, never a pass', () => {
    const read = (resolution: string) =>
      byPath(
        nodes(
          withLib().replace(
            `resolution: {integrity: ${sha512}}`,
            `resolution: ${resolution}`,
          ),
        ),
        'lib@1.0.0',
      );

    for (const resolution of [
      '{}',
      '{integrity: sha1-2jmj7l5rSw0yVb/vlWAYkK/YBwk=}',
      `{integrity: ${sha512} sha512-${'B'.repeat(86)}==}`,
      '{tarball: https://registry.npmjs.org/lib/-/lib-1.0.0.tgz}',
    ]) {
      expect(read(resolution)).toMatchObject({
        source: { kind: 'registry', integrity: null },
      });
    }
  });

  test('a tarball on registry.npmjs.org that is not the entry’s own is unreadable', () => {
    const read = (tarball: string) =>
      byPath(
        nodes(
          withLib().replace(
            `resolution: {integrity: ${sha512}}`,
            `resolution: {integrity: ${sha512}, tarball: ${tarball}}`,
          ),
        ),
        'lib@1.0.0',
      );

    expect(
      read('https://registry.npmjs.org/lib/-/lib-1.0.0.tgz'),
    ).toMatchObject({ source: { kind: 'registry', integrity: sha512 } });
    expect(read('https://registry.npmjs.org/evil/-/evil-1.0.0.tgz').kind).toBe(
      'unreadable',
    );
    expect(read('https://mirror.example/lib/-/lib-1.0.0.tgz')).toMatchObject({
      source: {
        kind: 'url',
        spec: 'https://mirror.example/lib/-/lib-1.0.0.tgz',
        integrity: sha512,
      },
    });
  });

  test('npmjs: keys are registry nodes and other named registries are unreadable', () => {
    const named = (registry: string) =>
      byPath(
        nodes(
          pnpmLock({
            importers: {
              '.': {
                dependencies: {
                  lib: {
                    specifier: `${registry}:^1.0.0`,
                    version: `lib@${registry}:1.0.0`,
                  },
                },
              },
            },
            packages: { [`lib@${registry}:1.0.0`]: registryPackage },
            snapshots: { [`lib@${registry}:1.0.0`]: '' },
          }),
        ),
        `lib@${registry}:1.0.0`,
      );

    expect(named('npmjs')).toMatchObject({
      name: 'lib',
      version: '1.0.0',
      source: { kind: 'registry', integrity: sha512 },
    });
    expect(named('work').kind).toBe('unreadable');
  });

  test('a registry entry whose version differs from its key is unreadable', () => {
    expect(
      byPath(
        nodes(
          withLib().replace(
            registryPackage,
            `${registryPackage}\n    version: 6.6.6`,
          ),
        ),
        'lib@1.0.0',
      ).kind,
    ).toBe('unreadable');
    expect(
      byPath(
        nodes(
          withLib().replace(
            registryPackage,
            `${registryPackage}\n    version: 1.0.0`,
          ),
        ),
        'lib@1.0.0',
      ).kind,
    ).toBe('package');
  });

  test('a tarball URL with credentials is unreadable and the error leaves them out', () => {
    const node = byPath(
      nodes(
        withLib().replace(
          `resolution: {integrity: ${sha512}}`,
          `resolution: {integrity: ${sha512}, tarball: 'https://user:s3cret@mirror.example/lib.tgz'}`,
        ),
      ),
      'lib@1.0.0',
    );

    expect(node.kind).toBe('unreadable');
    expect(JSON.stringify(node)).not.toContain('s3cret');
  });

  test('a registry revision is unreadable', () => {
    expect(
      byPath(
        nodes(
          withLib().replace(
            `resolution: {integrity: ${sha512}}`,
            `resolution: {integrity: ${sha512}, revision: 2}`,
          ),
        ),
        'lib@1.0.0',
      ).kind,
    ).toBe('unreadable');
  });
});

describe('patched packages', () => {
  test('a patched snapshot stays a registry node and its path carries the patch hash', () => {
    for (const name of [
      'rules-js-v90',
      'rules-js-v101',
      'rules-js-v110',
      'rules-js-v120',
    ] as const) {
      const patched = recorded(name).flatMap((node) =>
        node.kind === 'package' && node.name === 'meaning-of-life'
          ? [
              [
                /^meaning-of-life@1\.0\.0\(patch_hash=[0-9a-z]+\)$/.test(
                  node.path,
                ),
                node.version,
                node.source.kind,
                node.source.kind === 'registry' &&
                  node.source.integrity !== null,
              ],
            ]
          : [],
      );

      expect(patched).toEqual([[true, '1.0.0', 'registry', true]]);
    }
  });
});

describe('git and tarball sources', () => {
  const v120 = recorded('rules-js-v120');
  const sourceAt = (path: string) => {
    const node = byPath(v120, path);

    return node.kind === 'package'
      ? [node.name, node.version, node.source]
      : node;
  };

  test('codeload archives are git sources pinned to their commit', () => {
    expect(
      sourceAt(
        'debug@https://codeload.github.com/ngokevin/debug/tar.gz/9742c5f383a6f8046241920156236ade8ec30d53(supports-color@8.1.1)',
      ),
    ).toEqual([
      'debug',
      '2.6.3',
      {
        kind: 'git',
        spec: 'github:ngokevin/debug#9742c5f383a6f8046241920156236ade8ec30d53',
      },
    ]);
  });

  test('git resolutions are git sources pinned to their commit', () => {
    expect(
      sourceAt(
        'highlight.js@git+https://gitea.osmocom.org/vyanitskiy/highlight.js.git#58dc5961f6f2bb8bc8bb1e7ce39f268a2fdd874f',
      ),
    ).toEqual([
      'highlight.js',
      '11.8.0',
      {
        kind: 'git',
        spec: 'https://gitea.osmocom.org/vyanitskiy/highlight.js.git#58dc5961f6f2bb8bc8bb1e7ce39f268a2fdd874f',
      },
    ]);
  });

  test('other tarball URLs are url sources with their integrity', () => {
    expect(
      sourceAt(
        'diff@https://github.com/kpdecker/jsdiff/archive/refs/tags/v5.2.0.tar.gz',
      ),
    ).toEqual([
      'diff',
      '5.2.0',
      {
        kind: 'url',
        spec: 'https://github.com/kpdecker/jsdiff/archive/refs/tags/v5.2.0.tar.gz',
        integrity: Sha512Integrity.make(
          'sha512-bMABRl91MNWAvHGroSMPKpJTy442Y0sn4g2yCZgEHA+wxx3EgV9yHDThu33DqwiPat6pVjdTdijppN0yPLcOug==',
        ),
      },
    ]);
  });

  test('file: tarballs and directories are file sources', () => {
    expect(sourceAt('lodash@file:../vendored/lodash-4.17.21.tgz')).toEqual([
      'lodash',
      '4.17.21',
      { kind: 'file', spec: 'file:../vendored/lodash-4.17.21.tgz' },
    ]);
    expect(sourceAt('is-number@file:../vendored/is-number')).toEqual([
      'is-number',
      null,
      { kind: 'file', spec: '../vendored/is-number' },
    ]);
  });

  const exotic = (key: string, resolution: string) =>
    pnpmLock({
      importers: {
        '.': { dependencies: { g: { specifier: 'x', version: key.slice(2) } } },
      },
      packages: { [key]: `    resolution: ${resolution}\n    version: 1.0.0` },
      snapshots: { [key]: '' },
    });

  test('a git source without a full commit is unreadable', () => {
    for (const [key, resolution] of [
      [
        'g@git+https://example.com/o/r.git#79ac49e',
        '{commit: 79ac49e, repo: https://example.com/o/r.git, type: git}',
      ],
      [
        'g@git+https://example.com/o/r.git#main',
        '{commit: main, repo: https://example.com/o/r.git, type: git}',
      ],
      [
        'g@https://codeload.github.com/o/r/tar.gz/main',
        `{gitHosted: true, integrity: ${sha512}, tarball: https://codeload.github.com/o/r/tar.gz/main}`,
      ],
      [
        'g@https://codeload.github.com/o/r/tar.gz/79ac49e',
        `{integrity: ${sha512}, tarball: https://codeload.github.com/o/r/tar.gz/79ac49e}`,
      ],
      [
        'g@https://bitbucket.org/o/r/get/main.tar.gz',
        `{integrity: ${sha512}, tarball: https://bitbucket.org/o/r/get/main.tar.gz}`,
      ],
      [
        'g@https://gitlab.com/o/r/-/archive/main/r-main.tar.gz',
        `{integrity: ${sha512}, tarball: https://gitlab.com/o/r/-/archive/main/r-main.tar.gz}`,
      ],
      [
        'g@https://example.com/o/r.tgz',
        `{gitHosted: true, integrity: ${sha512}, tarball: https://example.com/o/r.tgz}`,
      ],
      [
        `g@git+https://example.com/o/r.git#${commit}&path:/sub`,
        `{commit: ${commit}, path: /sub, repo: https://example.com/o/r.git, type: git}`,
      ],
    ] as const) {
      const [node] = nodes(exotic(key, resolution));

      expect(node).toMatchObject({ kind: 'unreadable', path: key });
    }
  });

  test('bitbucket and gitlab archives are git sources pinned to their commit', () => {
    for (const [tarball, spec] of [
      [
        `https://bitbucket.org/o/r/get/${commit}.tar.gz`,
        `bitbucket:o/r#${commit}`,
      ],
      [
        `https://gitlab.com/o/r/-/archive/${commit}/r-${commit}.tar.gz`,
        `gitlab:o/r#${commit}`,
      ],
      [
        `https://gitlab.com/api/v4/projects/o%2Fr/repository/archive.tar.gz?ref=${commit}`,
        `gitlab:o/r#${commit}`,
      ],
    ] as const) {
      const key = `g@${tarball}`;

      expect(
        byPath(
          nodes(exotic(key, `{integrity: ${sha512}, tarball: '${tarball}'}`)),
          key,
        ),
      ).toMatchObject({ source: { kind: 'git', spec } });
    }
  });

  test('runtime, binary, variations and custom resolutions are unreadable', () => {
    for (const resolution of [
      `{type: binary, url: https://nodejs.org/n.tgz, integrity: ${sha512}, bin: node, archive: tarball}`,
      '{type: variations, variants: []}',
      '{type: custom:cdn, cdnUrl: https://cdn.example/g.tgz}',
      '{type: other}',
    ]) {
      expect(nodes(exotic('g@runtime:22.0.0', resolution))[0]).toMatchObject({
        kind: 'unreadable',
      });
    }
  });
});

describe('workspaces', () => {
  const vue = recordedPnpmLock('vuejs-core');

  test('links to the importers vuejs/core lists are not nodes', () => {
    const list = nodes(vue);

    expect(fileNodes(list)).toEqual([]);
    expect(list.filter((node) => !node.path.startsWith('env:'))).toEqual([
      {
        kind: 'package',
        path: 'vite@8.3.0(@types/node@24.13.5)(esbuild@0.28.2)(sass@1.104.1)(yaml@2.9.0)',
        name: 'vite',
        version: '8.3.0',
        source: {
          kind: 'registry',
          integrity: Sha512Integrity.make(
            'sha512-lhZBVvEHefgE+HQZC9O7EBJgCU/nVzFNl7vkS4RE0APtWLP02/8QVIkQtzBxPquh7lq5/78NHipTj7ODQ6XuyQ==',
          ),
        },
        dev: true,
        optional: false,
        hasInstallScript: null,
      },
    ]);
  });

  const addLink = (importer: string, alias: string, target: string) =>
    vue.replace(
      `  ${importer}:\n    dependencies:\n`,
      `  ${importer}:\n    dependencies:\n      ${alias}:\n        specifier: ${target}\n        version: ${target}\n`,
    );

  test('a link outside the lockfile directory stays a file source', () => {
    expect(
      fileNodes(
        nodes(addLink('packages/vue', 'outside', 'link:../../../outside')),
      ),
    ).toEqual([['packages/vue', 'outside', '../outside']]);
    expect(
      fileNodes(
        nodes(addLink('packages/vue', 'absolute', 'link:/tmp/outside')),
      ),
    ).toEqual([['packages/vue', 'absolute', '/tmp/outside']]);
  });

  test('a link to a folder no importer names stays a file source', () => {
    expect(
      fileNodes(
        nodes(addLink('packages/vue', 'vendored', 'link:../../vendor/lib')),
      ),
    ).toEqual([['packages/vue', 'vendored', 'vendor/lib']]);
  });

  test('links to importers outside the lockfile directory stay file sources', () => {
    expect(
      fileNodes(recorded('rules-js-v120')).filter(([path]) => path === '.'),
    ).toEqual([
      ['.', '@scoped/a', '../projects/a'],
      ['.', '@scoped/b', '../projects/b'],
      ['.', '@scoped/d', '../projects/d'],
      ['.', 'alias-project-a', '../projects/a'],
      ['.', 'alternate-versions', '../projects/alts'],
      ['.', 'test-c200-d200', '../projects/peers-combo-2'],
      ['.', 'test-c201-d200', '../projects/peers-combo-1'],
      ['.', 'test-peer-types', '../projects/peer-types'],
    ]);
  });

  const injected = (directory: string, importers: Record<string, Importer>) =>
    pnpmLock({
      importers,
      packages: {
        [`b@file:${directory}`]: `    resolution: {directory: ${directory}, type: directory}`,
      },
      snapshots: { [`b@file:${directory}`]: '' },
    });

  test('an injected workspace package is not a node, but a directory no importer names is', () => {
    const app = {
      dependencies: {
        b: { specifier: 'workspace:*', version: 'file:packages/b' },
      },
    };

    expect(
      nodes(injected('packages/b', { '.': app, 'packages/b': {} })),
    ).toEqual([]);
    expect(fileNodes(nodes(injected('packages/b', { '.': app })))).toEqual([
      ['b@file:packages/b', '', 'packages/b'],
    ]);
  });

  test('snapshot links resolve from the lockfile directory', () => {
    const lock = (target: string) =>
      pnpmLock({
        importers: {
          '.': {
            dependencies: { lib: { specifier: '1.0.0', version: '1.0.0' } },
          },
          'packages/c': {},
        },
        packages: { 'lib@1.0.0': registryPackage },
        snapshots: {
          'lib@1.0.0': `    dependencies:\n      c: ${target}`,
        },
      });

    expect(fileNodes(nodes(lock('link:packages/c')))).toEqual([]);
    expect(fileNodes(nodes(lock('link:../packages/c')))).toEqual([
      ['lib@1.0.0', 'c', '../packages/c'],
    ]);
  });

  test('importers with a backslash or a node_modules segment are not workspaces', () => {
    const app = (version: string) => ({
      dependencies: { evil: { specifier: version, version } },
    });

    for (const id of ['..\\evil', 'packages\\evil', 'node_modules/evil']) {
      expect(
        fileNodes(
          nodes(pnpmLock({ importers: { '.': app(`link:${id}`), [id]: {} } })),
        ),
      ).toEqual([['.', 'evil', id]]);
      expect(
        fileNodes(nodes(injected(id, { '.': app(`file:${id}`), [id]: {} }))),
      ).toEqual([[`b@file:${id}`, '', id]]);
    }
  });

  test('a lockfile that leaves links out is unreadable where they would be', () => {
    expect(
      nodes(
        withLib().replace(
          'importers:',
          'settings:\n  excludeLinksFromLockfile: true\nimporters:',
        ),
      ).map((node) => node.kind),
    ).toEqual(['unreadable', 'package']);
  });
});

describe('env document', () => {
  test('config and package-manager dependencies are nodes', () => {
    expect(
      recorded('rules-js-multi-document-v11').map((node) =>
        node.kind === 'package' ? [node.path, node.name, node.version] : node,
      ),
    ).toEqual([
      ['env:semver@7.7.4', 'semver', '7.7.4'],
      ['ms@2.1.3', 'ms', '2.1.3'],
    ]);
    expect(
      recorded('vuejs-core')
        .filter((node) => node.path.startsWith('env:'))
        .map((node) => node.kind === 'package' && [node.path, node.optional]),
    ).toContainEqual(['env:pnpm@12.4.2', false]);
  });
});

const decodeDocuments = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({
      snapshots: Schema.optionalKey(
        Schema.Record(
          Schema.String,
          Schema.Struct({ optional: Schema.optionalKey(Schema.Boolean) }),
        ),
      ),
    }),
  ),
);

describe('dev and optional', () => {
  const v120 = recorded('rules-js-v120');

  test('dev follows the importer groups', () => {
    expect(byPath(v120, '@types/archiver@5.3.1')).toMatchObject({ dev: true });
    expect(byPath(v120, '@aspect-test/b@5.0.2')).toMatchObject({ dev: false });
    expect(byPath(v120, 'uvu@0.5.6')).toMatchObject({ dev: false });
    expect(byPath(v120, '@aspect-test/h@1.0.0')).toMatchObject({
      dev: false,
      optional: true,
    });
  });

  test('optional agrees with the flag pnpm writes on every production snapshot', () => {
    for (const name of [
      'rules-js-v90',
      'rules-js-v101',
      'rules-js-v110',
      'rules-js-v120',
      'vuejs-core',
    ] as const) {
      const text = recordedPnpmLock(name);
      const parsed: unknown = Bun.YAML.parse(text);
      const docs = decodeDocuments(Array.isArray(parsed) ? parsed : [parsed]);
      const flagged = new Set(
        docs.flatMap((doc, index, all) =>
          Object.entries(doc.snapshots ?? {}).flatMap(([key, snapshot]) =>
            snapshot.optional === true
              ? [index < all.length - 1 ? `env:${key}` : key]
              : [],
          ),
        ),
      );
      for (const node of nodes(text)) {
        if (
          node.kind === 'package' &&
          !node.dev &&
          node.dependency === undefined
        ) {
          expect([node.path, node.optional]).toEqual([
            node.path,
            flagged.has(node.path),
          ]);
        }
      }
    }
  });
});

describe('unreadable entries', () => {
  test('a snapshot without a packages entry is unreadable', () => {
    expect(
      nodes(
        withLib().replace(
          `packages:\n  'lib@1.0.0':\n${registryPackage}\n`,
          '',
        ),
      ),
    ).toMatchObject([{ kind: 'unreadable', path: 'lib@1.0.0' }]);
  });

  test('a reference to a missing snapshot is unreadable', () => {
    expect(
      nodes(
        withLib({
          devDependencies: { ghost: { specifier: '1.0.0', version: '1.0.0' } },
        }),
      ).map((node) => [node.kind, node.path, node.dependency]),
    ).toEqual([
      ['unreadable', '.', 'ghost'],
      ['package', 'lib@1.0.0', undefined],
    ]);
  });

  test('snapshot fields under packages, and package fields under snapshots, are unreadable', () => {
    expect(
      nodes(
        withLib().replace(
          registryPackage,
          `${registryPackage}\n    dependencies:\n      evil: 1.0.0`,
        ),
      ).map((node) => node.kind),
    ).toEqual(['unreadable']);
    expect(
      nodes(
        withLib().replace(
          `snapshots:\n  'lib@1.0.0': {}`,
          `snapshots:\n  'lib@1.0.0':\n    resolution: {integrity: ${sha512}}`,
        ),
      ).map((node) => node.kind),
    ).toEqual(['unreadable']);
  });

  test('an unreadable entry does not hide the others', () => {
    expect(
      nodes(
        pnpmLock({
          packages: {
            'bad@1.0.0': '    resolution: {type: other}',
            'lib@1.0.0': registryPackage,
          },
          snapshots: { 'bad@1.0.0': '', 'lib@1.0.0': '' },
        }),
      ).map((node) => [node.kind, node.path]),
    ).toEqual([
      ['unreadable', 'bad@1.0.0'],
      ['package', 'lib@1.0.0'],
    ]);
  });
});
