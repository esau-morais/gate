import { describe, expect, test } from 'bun:test';
import { Sha512Integrity } from '../src/evidence';
import type { LockfileNode } from '../src/npm/lockfile';
import { readPnpmConfigDependencies } from '../src/npm/pnpm-config';
import { readPnpmLockfile } from '../src/npm/pnpm-lock';
import { recordedPnpmLock, recordedPnpmWorkspace } from './pnpm/locks';

const semverIntegrity = Sha512Integrity.make(
  'sha512-vFKC2IEtQnVhpT78h1Yp8wzwrf8CM+MzKMHGJZfBtzhZNycRFnXsHk6E5TxIkkMsgNS7mdX3AGB7x2QM2di4lA==',
);
const sha512 = Sha512Integrity.make(`sha512-${'A'.repeat(86)}==`);
const sha1 = 'sha1-2jmk2uB6XNwfJ9xCwhuS9fAjq1E=';
const emptyLock = "lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n";

function config(
  workspace: string | undefined,
  options: { lock?: string; manifest?: string } = {},
): readonly LockfileNode[] {
  const { env } = readPnpmLockfile(options.lock ?? emptyLock);

  return (
    readPnpmConfigDependencies({
      env,
      ...(workspace === undefined
        ? {}
        : { workspace: { path: 'pnpm-workspace.yaml', text: workspace } }),
      ...(options.manifest === undefined
        ? {}
        : { manifest: { path: 'package.json', text: options.manifest } }),
    })?.nodes ?? []
  );
}

const withConfig = (entries: string) => `configDependencies:\n${entries}\n`;

function registryNode(
  name: string,
  version: string,
  integrity: Sha512Integrity | null,
): LockfileNode {
  return {
    kind: 'package',
    path: 'pnpm-workspace.yaml',
    dependency: name,
    name,
    version,
    source: { kind: 'registry', integrity },
    dev: false,
    optional: false,
    hasInstallScript: null,
  };
}

const locations = (list: readonly LockfileNode[]) =>
  list.map((node) => [node.kind, node.path, node.dependency]);

describe('recorded pnpm 10 workspaces', () => {
  test('a version+integrity pin is a registry node with its sha512', () => {
    expect(
      config(recordedPnpmWorkspace('rules-js'), {
        lock: recordedPnpmLock('rules-js-v101'),
      }),
    ).toEqual([registryNode('semver', '7.7.4', semverIntegrity)]);
    expect(
      config(recordedPnpmWorkspace('seek-oss-wingman')).map(
        (node) => node.kind === 'package' && [node.name, node.version],
      ),
    ).toEqual([['pnpm-plugin-sku', '0.1.0']]);
    expect(
      config(recordedPnpmWorkspace('quests-org-quests')).map(
        (node) =>
          node.kind === 'package' && [node.name, node.version, node.source],
      ),
    ).toEqual([
      [
        '@pnpm/plugin-trusted-deps',
        '0.2.0',
        {
          kind: 'registry',
          integrity: Sha512Integrity.make(
            'sha512-jqiCC8kyrwOERwMWPo2RB1YlDMMS5WsPSA8Uwi3EXAYwyOSNtqKhrB9bs543JGUiz4yaA9h6nE3q98fG14AEyQ==',
          ),
        },
      ],
    ]);
  });

  test('a pin the env document holds too is left to the env node', () => {
    for (const lock of [
      'rules-js-v110',
      'rules-js-v120',
      'rules-js-multi-document-v11',
    ] as const) {
      expect(
        config(recordedPnpmWorkspace('rules-js'), {
          lock: recordedPnpmLock(lock),
        }),
      ).toEqual([]);
    }
  });
});

describe('pins', () => {
  test('a sha1 pin has no integrity, and a sha512 beside a sha1 is kept', () => {
    expect(config(withConfig(`  lib: 1.0.0+${sha1}`))).toEqual([
      registryNode('lib', '1.0.0', null),
    ]);
    expect(config(withConfig(`  lib: 1.0.0+${sha512} ${sha1}`))).toEqual([
      registryNode('lib', '1.0.0', sha512),
    ]);
  });

  test('a bare exact version is a registry node without integrity', () => {
    expect(config(withConfig('  lib: 1.0.0'))).toEqual([
      registryNode('lib', '1.0.0', null),
    ]);
  });

  test('a range pnpm resolves at install is unreadable', () => {
    expect(locations(config(withConfig("  lib: '^1.0.0'")))).toEqual([
      ['unreadable', 'pnpm-workspace.yaml', 'lib'],
    ]);
  });

  test('a specifier the env document resolved is left to the env node', () => {
    expect(
      config(withConfig('  semver: 7.7.4'), {
        lock: recordedPnpmLock('rules-js-v110'),
      }),
    ).toEqual([]);
    expect(
      locations(
        config(withConfig("  semver: '^7.0.0'"), {
          lock: recordedPnpmLock('rules-js-v110'),
        }),
      ),
    ).toEqual([['unreadable', 'pnpm-workspace.yaml', 'semver']]);
  });

  test('malformed pins are unreadable', () => {
    for (const value of [
      '1.0.0+',
      `v1.0.0+${sha512}`,
      '1.0.0+build+sha512-AAAA',
      '1.0.0+sha512',
      "''",
      '1',
      '[1.0.0]',
      '{integrity: 1.0.0}',
      `{integrity: '1.0.0+${sha512}', extra: x}`,
    ]) {
      expect([value, locations(config(withConfig(`  lib: ${value}`)))]).toEqual(
        [value, [['unreadable', 'pnpm-workspace.yaml', 'lib']]],
      );
    }
  });

  test('a name that is not an npm package name is unreadable', () => {
    expect(
      locations(config(withConfig(`  '../lib': '1.0.0+${sha512}'`))),
    ).toEqual([['unreadable', 'pnpm-workspace.yaml', '../lib']]);
  });
});

describe('tarball pins', () => {
  const pin = (tarball: string) =>
    config(
      withConfig(
        `  lib:\n    tarball: ${tarball}\n    integrity: '1.0.0+${sha512}'`,
      ),
    );

  test('the default tarball is a registry node', () => {
    expect(pin('https://registry.npmjs.org/lib/-/lib-1.0.0.tgz')).toEqual([
      registryNode('lib', '1.0.0', sha512),
    ]);
    expect(
      config(withConfig(`  lib: {tarball: '', integrity: '1.0.0+${sha512}'}`)),
    ).toEqual([registryNode('lib', '1.0.0', sha512)]);
    expect(config(withConfig(`  lib: {integrity: '1.0.0+${sha512}'}`))).toEqual(
      [registryNode('lib', '1.0.0', sha512)],
    );
  });

  test('a tarball on another host is a url node', () => {
    expect(pin('https://npm.example.com/lib/-/lib-1.0.0.tgz')).toEqual([
      {
        kind: 'package',
        path: 'pnpm-workspace.yaml',
        dependency: 'lib',
        name: 'lib',
        version: '1.0.0',
        dev: false,
        optional: false,
        hasInstallScript: null,
        source: {
          kind: 'url',
          spec: 'https://npm.example.com/lib/-/lib-1.0.0.tgz',
          integrity: sha512,
        },
      },
    ]);
  });

  test('a registry tarball of another version, a URL with credentials, or a file tarball is unreadable', () => {
    for (const tarball of [
      'https://registry.npmjs.org/lib/-/lib-2.0.0.tgz',
      'https://user:token@npm.example.com/lib-1.0.0.tgz',
      'file:lib-1.0.0.tgz',
    ]) {
      expect(locations(pin(tarball))).toEqual([
        ['unreadable', 'pnpm-workspace.yaml', 'lib'],
      ]);
    }
  });
});

describe('pnpm-workspace.yaml and the env document', () => {
  const v110 = { lock: recordedPnpmLock('rules-js-v110') };

  test('a pin that disagrees with the env document is unreadable', () => {
    for (const value of [
      `7.7.3+${semverIntegrity}`,
      `7.7.4+${sha512}`,
      `{tarball: 'https://npm.example.com/semver-7.7.4.tgz', integrity: '7.7.4+${semverIntegrity}'}`,
    ]) {
      expect([
        value,
        locations(config(withConfig(`  semver: ${value}`), v110)),
      ]).toEqual([value, [['unreadable', 'pnpm-workspace.yaml', 'semver']]]);
    }
  });

  test('a dependency only the workspace file pins is decided from it', () => {
    expect(config(withConfig(`  lib: '1.0.0+${sha512}'`), v110)).toEqual([
      registryNode('lib', '1.0.0', sha512),
    ]);
  });
});

describe('the workspace file itself', () => {
  test('a file gate cannot read is unreadable, never empty', () => {
    for (const text of [
      'configDependencies: &pins\n  lib: 1.0.0\n',
      'configDependencies:\n  lib: 1.0.0\n  lib: 2.0.0\n',
      'configDependencies: [lib]\n',
      '- a\n',
    ]) {
      expect([text, locations(config(text))]).toEqual([
        text,
        [['unreadable', 'pnpm-workspace.yaml', undefined]],
      ]);
    }
  });

  test('without configDependencies there is nothing to decide', () => {
    expect(
      config("packages:\n  - 'packages/*'\nminimumReleaseAge: 1440\n"),
    ).toEqual([]);
    expect(config(undefined)).toEqual([]);
    expect(config('')).toEqual([]);
    expect(config('~\n')).toEqual([]);
  });
});

describe('package.json', () => {
  const manifest = JSON.stringify({
    name: 'app',
    pnpm: { configDependencies: { lib: `1.0.0+${sha512}` } },
  });

  test('pnpm 10 config dependencies in package.json are unreadable', () => {
    expect(locations(config(undefined, { manifest }))).toEqual([
      ['unreadable', 'package.json', 'lib'],
    ]);
    expect(locations(config('packages: []\n', { manifest }))).toEqual([
      ['unreadable', 'package.json', 'lib'],
    ]);
  });

  test('pnpm-workspace.yaml configDependencies replace the package.json ones', () => {
    expect(
      config(withConfig(`  other: '1.0.0+${sha512}'`), { manifest }),
    ).toEqual([registryNode('other', '1.0.0', sha512)]);
  });

  test('a package.json gate cannot read is unreadable', () => {
    expect(locations(config(undefined, { manifest: '{' }))).toEqual([
      ['unreadable', 'package.json', undefined],
    ]);
    expect(
      locations(config(undefined, { manifest: '{"name":"app"}' })),
    ).toEqual([]);
  });
});

test('the nodes come with the file they were read from', () => {
  const env = new Map();
  const workspace = {
    path: 'pnpm-workspace.yaml',
    text: withConfig('  lib: 1.0.0'),
  };
  const manifest = {
    path: 'package.json',
    text: JSON.stringify({ pnpm: { configDependencies: { lib: '1.0.0' } } }),
  };

  expect(readPnpmConfigDependencies({ env, workspace, manifest })?.file).toBe(
    workspace,
  );
  expect(
    readPnpmConfigDependencies({
      env,
      workspace: { path: 'pnpm-workspace.yaml', text: 'packages: []\n' },
      manifest,
    })?.file,
  ).toBe(manifest);
  expect(readPnpmConfigDependencies({ env })).toBeUndefined();
});
