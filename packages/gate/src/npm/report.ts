import { Option, Schema } from 'effect';
import { AllowedSource, Waiver, type DecisionContext } from '../context';
import type { Identity, PackageVersionEvidence } from '../evidence';
import { decide, type Outcome, type Policy, type Reason } from '../policy';
import { inert, inertJson, type Style } from '../terminal';
import { isEvidenceName, type FetchGaps } from './evidence-directory';
import type { LockfileNode, LockfileSource } from './lockfile';
import type { VerifyRecord } from './verify';

type Decided = Extract<VerifyRecord, { kind: 'decision' }>;
type Unreadable = Extract<VerifyRecord, { kind: 'unreadable' }>;
type Shown = Exclude<Outcome, 'ACCEPT'>;

export const ruleMeanings: Readonly<Record<string, string>> = {
  feed_match: 'A malware feed lists this version.',
  exotic_source:
    'This node comes from a git, URL or file source that no allowedSources entry in --context covers.',
  feeds_unavailable:
    "gate couldn't check this version against the malware feed.",
  integrity_unknown:
    "gate knows no sha512 integrity for this version, so the decision isn't tied to the tarball's bytes.",
  publish_time_unknown: "gate doesn't know when this version was published.",
  release_age:
    "This version was published too recently for the policy's release_age window.",
  provenance_unavailable:
    "gate couldn't establish whether this version has verified provenance.",
  trust_downgrade:
    'This version has no provenance, but an earlier version had verified provenance.',
  provenance_history_unknown:
    "This version has no provenance, and gate couldn't verify whether earlier versions had it.",
  publisher_changed:
    'A different identity published this version than the earlier versions.',
  publisher_recent:
    'The account that published this version first published this package shortly before it.',
  publisher_unknown: "gate couldn't tell who published this version.",
  new_install_script:
    "This version adds an install script the previous version didn't have.",
  install_scripts_unknown:
    "gate couldn't read the install scripts of this version or the previous one.",
  integrity_mismatch:
    "The lockfile's sha512 differs from the one npm lists for this version.",
};

const rejectSteps: Readonly<Record<string, string>> = {
  feed_match:
    'Remove this version from the lockfile. No waiver or rerun clears a feed match.',
  exotic_source:
    'Remove the dependency, or, if you trust the source, add its allowedSources entry to a --context file.',
  integrity_mismatch:
    "Don't install it. Find out why the bytes differ before you regenerate the entry.",
};

const waiverDays = 30;
const horizonMs = 3650 * 86_400_000;
const missingFromDirectory = [
  /^no packument recorded$/,
  /^attestation bundle not recorded$/,
  /^no trusted root recorded$/,
  /^no OSV snapshot recorded$/,
  /^OSV snapshot does not cover /,
  /^OSV snapshot from .* is more than a day old$/,
];
const removedDocument = 'version document missing';
const provenanceFiles = ['trusted_root.json'];
const severity: Record<Shown, number> = { REJECT: 0, QUARANTINE: 1 };

type Input = {
  readonly records: readonly VerifyRecord[];
  readonly nodes: readonly LockfileNode[];
  readonly policy: Policy;
  readonly context: DecisionContext;
  readonly gaps: FetchGaps;
  readonly style: Style;
};

type Line =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'json'; readonly label: string; readonly value: unknown };

type Detail = {
  readonly evidence: string;
  readonly rerun?: string;
  readonly step?: string;
  readonly own: readonly Line[];
};

type Item = Detail & { readonly record: Decided };

const text = (value: string): Line => ({ kind: 'text', text: value });

function renderLine(line: Line): string {
  return line.kind === 'text'
    ? inert(line.text)
    : `${line.label}: ${inertJson(line.value)}`;
}

function describeIdentity(identity: Identity): string {
  return identity.kind === 'account'
    ? `account ${identity.name}`
    : `workflow ${identity.repository} ${identity.workflow}`;
}

function nodeLabel(record: Decided): string {
  const { subject, source } = record.evidence;
  const version =
    subject.version ?? (source.kind === 'registry' ? '?' : source.spec);

  return `${subject.name}@${version}`;
}

function location(record: VerifyRecord): string {
  return record.dependency === undefined
    ? record.path
    : `${record.path} -> ${record.dependency}`;
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function relativeTime(from: Date, to: Date): string {
  const minutes = Math.ceil((to.getTime() - from.getTime()) / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const parts = [
    days > 0 ? `${days}d` : '',
    hours > 0 ? `${hours}h` : '',
    days === 0 && hours === 0 ? `${minutes % 60}m` : '',
  ].filter((part) => part !== '');

  return `in ${parts.join(' ')}`;
}

function outcomeAfter(decision: {
  outcome: Outcome;
  reasons: readonly Reason[];
}): string {
  const remaining = decision.reasons
    .filter((reason) => reason.kind !== 'waived')
    .map((reason) => reason.code);

  return remaining.length === 0
    ? decision.outcome
    : `${decision.outcome} by ${remaining.join(', ')}`;
}

function decideAt(
  input: Input,
  record: Decided,
  change: { now?: Date; context?: DecisionContext },
) {
  return decide({
    evidence: record.evidence,
    now: change.now ?? record.at,
    context: change.context ?? input.context,
    canonical: input.policy,
  });
}

function stopsFiring(
  input: Input,
  record: Decided,
  code: string,
): Date | undefined {
  const fires = (ms: number) =>
    decideAt(input, record, { now: new Date(ms) }).reasons.some(
      (reason) => reason.code === code && reason.kind !== 'waived',
    );
  let low = record.at.getTime();
  let high = low + horizonMs;
  if (fires(high)) {
    return undefined;
  }

  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (fires(middle)) {
      low = middle;
    } else {
      high = middle;
    }
  }

  return new Date(high);
}

type Gap = { readonly path: string; readonly reason: string };

function parseGap(gap: string): Gap {
  const cut = gap.indexOf(': ');

  return cut === -1
    ? { path: gap, reason: '' }
    : {
        path: gap.slice(0, cut),
        reason: gap.slice(cut + 2).replace(/^https?:\/\/\S+: /, ''),
      };
}

function gapsFor(
  gaps: FetchGaps,
  name: string,
  shared: readonly string[],
): readonly Gap[] {
  if (gaps.kind === 'unlisted') {
    return [];
  }

  return gaps.gaps
    .map(parseGap)
    .filter(
      ({ path }) =>
        path === `packuments/${name}.json` ||
        path === `attestations/${name}` ||
        path.startsWith(`attestations/${name}@`) ||
        shared.includes(path),
    );
}

function rerun(
  input: Input,
  evidence: PackageVersionEvidence,
  reason: string | undefined,
  shared: readonly string[],
): string {
  const { name } = evidence.subject;
  const gaps = gapsFor(input.gaps, name, shared);
  const failed = gaps.find((gap) => !/\bHTTP 404$/.test(gap.reason));
  if (failed !== undefined) {
    const more = gaps.length > 1 ? ` and ${gaps.length - 1} more` : '';

    return `rerun: can fix this, fetching ${failed.path} failed (${failed.reason})${more}`;
  }

  const [notFound] = gaps;
  if (notFound !== undefined) {
    return `rerun: won't help, npm returned HTTP 404 for ${notFound.path}`;
  }

  const { provenance, source } = evidence;
  if (source.kind !== 'registry') {
    return `rerun: won't help, gate reads no registry evidence for a ${source.kind} source`;
  }

  if (
    reason === removedDocument ||
    (provenance.kind === 'unavailable' && provenance.reason === removedDocument)
  ) {
    return "rerun: won't help, npm removed this version's document";
  }

  if (
    reason !== undefined &&
    missingFromDirectory.some((pattern) => pattern.test(reason))
  ) {
    return isEvidenceName(name)
      ? 'rerun: can fix this, gate verify without --evidence fetches it'
      : `rerun: won't help, ${name} is not a valid npm package name`;
  }

  return input.gaps.kind === 'listed'
    ? "rerun: won't help, SOURCES.json lists no failed fetch for this package"
    : "rerun: can't tell, this evidence directory has no SOURCES.json from a gate fetch";
}

const decodeWaiver = Schema.decodeUnknownOption(Waiver);
const decodeAllowedSource = Schema.decodeUnknownOption(AllowedSource);

function waiverLines(input: Input, record: Decided, code: string): Line[] {
  const { subject, source } = record.evidence;
  if (source.integrity === null) {
    return [
      text(
        'no waiver can be written: gate knows no sha512 for this version, and a waiver pins one',
      ),
    ];
  }

  if (subject.version === null) {
    return [text('no waiver can be written: the node has no version')];
  }

  const near = input.context.waivers.flatMap((waiver): Line[] => {
    if (
      waiver.policy !== input.policy.ref.id ||
      waiver.rule !== code ||
      waiver.package !== subject.name ||
      waiver.version !== subject.version
    ) {
      return [];
    }

    return [
      text(
        waiver.integrity === source.integrity
          ? `the waiver in --context expired at ${waiver.expiresAt.toISOString()}`
          : `the waiver in --context pins other bytes (${waiver.integrity})`,
      ),
    ];
  });
  const raw = {
    policy: input.policy.ref.id,
    package: subject.name,
    version: subject.version,
    integrity: source.integrity,
    rule: code,
    reason: 'TODO: why this version is safe',
    author: 'TODO: who reviewed it',
    expiresAt: new Date(
      record.at.getTime() + waiverDays * 86_400_000,
    ).toISOString(),
  };
  const waiver = Option.getOrUndefined(decodeWaiver(raw));
  if (waiver === undefined) {
    return [
      ...near,
      text('no waiver can be written: the node does not fit the waiver schema'),
    ];
  }

  const after = decideAt(input, record, {
    context: {
      ...input.context,
      waivers: [...input.context.waivers, waiver],
    },
  });

  return [
    ...near,
    { kind: 'json', label: `waiver (then ${outcomeAfter(after)})`, value: raw },
  ];
}

function allowLines(input: Input, record: Decided): Line[] {
  const { subject, source } = record.evidence;
  if (source.kind === 'registry') {
    return [];
  }

  const raw =
    source.kind === 'url'
      ? {
          kind: source.kind,
          name: subject.name,
          spec: source.spec,
          integrity: source.integrity,
        }
      : { kind: source.kind, name: subject.name, spec: source.spec };
  const entry = Option.getOrUndefined(decodeAllowedSource(raw));
  if (entry === undefined) {
    return [
      text(
        source.kind === 'url' && source.integrity === null
          ? 'no allowedSources entry can be written: a URL source needs a sha512 integrity'
          : 'no allowedSources entry can be written: the spec does not fit the allowedSources schema',
      ),
    ];
  }

  const after = decideAt(input, record, {
    context: {
      ...input.context,
      allowedSources: [...input.context.allowedSources, entry],
    },
  });

  return [
    { kind: 'json', label: `allow (then ${outcomeAfter(after)})`, value: raw },
  ];
}

function integrityDetail(
  input: Input,
  record: Decided,
  lockSource: LockfileSource | undefined,
): Detail {
  if (lockSource?.kind === 'registry' && lockSource.integrity === null) {
    return {
      evidence: 'the lockfile entry has no sha512 integrity',
      step: 'npm keeps a missing integrity when it rewrites the lockfile. Remove these entries from package-lock.json and run npm install --package-lock-only to record it.',
      own: [],
    };
  }

  const { evidence } = record;
  const { publishTime, provenance } = evidence;
  let reason: string | undefined;
  if (publishTime.kind === 'unknown') {
    reason = publishTime.reason;
  } else if (provenance.kind === 'unavailable') {
    reason = provenance.reason;
  }

  return {
    evidence:
      reason === undefined
        ? "npm's document for this version has no sha512 integrity"
        : `npm's sha512 for this version is unknown: ${reason}`,
    rerun: rerun(input, evidence, reason, []),
    own: [],
  };
}

function unknownDetail(
  input: Input,
  record: Decided,
  what: string,
  reason: string | undefined,
  shared: readonly string[],
): Detail {
  return {
    evidence: reason === undefined ? what : `${what}: ${reason}`,
    rerun: rerun(input, record.evidence, reason, shared),
    own: [],
  };
}

function releaseAgeDetail(input: Input, record: Decided, code: string): Detail {
  const { publishTime } = record.evidence;
  const published =
    publishTime.kind === 'packument'
      ? `published ${publishTime.at.toISOString()}`
      : 'publish time unknown';
  const clears = stopsFiring(input, record, code);
  if (clears === undefined) {
    return {
      evidence: published,
      own: [text(`${code} does not clear on this evidence`)],
    };
  }

  const after = decideAt(input, record, { now: clears });

  return {
    evidence: published,
    own: [
      text(
        `clears ${code} at ${clears.toISOString()} (${relativeTime(record.at, clears)}), then ${outcomeAfter(after)}`,
      ),
    ],
  };
}

function detailFor(
  input: Input,
  record: Decided,
  reason: Reason,
  lockSources: ReadonlyMap<string, LockfileSource>,
): Detail {
  const { evidence } = record;
  if (reason.kind === 'failed') {
    return {
      evidence: `the rule failed to evaluate: ${reason.error}`,
      own: [],
    };
  }

  const { feeds, source, publisher, installScripts } = evidence;
  switch (reason.code) {
    case 'feed_match':
      return {
        evidence:
          feeds.kind === 'checked'
            ? `listed as ${feeds.hits.map((hit) => `${hit.id} (${hit.feed})`).join(', ')}`
            : 'listed by a feed',
        own: [],
      };
    case 'exotic_source':
      return {
        evidence:
          source.kind === 'registry'
            ? 'registry source'
            : `${source.kind} source ${source.spec}`,
        own: allowLines(input, record),
      };
    case 'feeds_unavailable':
      return unknownDetail(
        input,
        record,
        'feed check unavailable',
        feeds.kind === 'unavailable' ? feeds.reason : undefined,
        ['osv/'],
      );
    case 'integrity_unknown':
      return integrityDetail(input, record, lockSources.get(record.path));
    case 'publish_time_unknown':
      return unknownDetail(
        input,
        record,
        'publish time unknown',
        evidence.publishTime.kind === 'unknown'
          ? evidence.publishTime.reason
          : undefined,
        [],
      );
    case 'release_age':
      return releaseAgeDetail(input, record, reason.code);
    case 'provenance_unavailable':
      return unknownDetail(
        input,
        record,
        'provenance unavailable',
        evidence.provenance.kind === 'unavailable'
          ? evidence.provenance.reason
          : undefined,
        provenanceFiles,
      );
    case 'trust_downgrade':
      return {
        evidence: 'no provenance; an earlier version has verified provenance',
        own: waiverLines(input, record, reason.code),
      };
    case 'provenance_history_unknown':
      return unknownDetail(
        input,
        record,
        "no provenance; an earlier version's provenance couldn't be verified",
        undefined,
        provenanceFiles,
      );
    case 'publisher_changed':
      return {
        evidence:
          publisher.kind === 'changed'
            ? `published by ${describeIdentity(publisher.identity)}; earlier versions by ${publisher.earlier.map(describeIdentity).join(', ')}`
            : 'publisher changed',
        own: waiverLines(input, record, reason.code),
      };
    case 'publisher_recent': {
      const joined =
        publisher.kind === 'continuous' && publisher.joinedAt !== undefined
          ? `${describeIdentity(publisher.identity)} first published this package ${publisher.joinedAt.toISOString()}`
          : 'the publisher is new to this package';
      const released =
        evidence.publishTime.kind === 'packument'
          ? `, this version ${evidence.publishTime.at.toISOString()}`
          : '';

      return {
        evidence: `${joined}${released}`,
        own: waiverLines(input, record, reason.code),
      };
    }
    case 'publisher_unknown':
      return unknownDetail(
        input,
        record,
        'publisher unknown',
        publisher.kind === 'unknown' ? publisher.reason : undefined,
        provenanceFiles,
      );
    case 'new_install_script':
      return {
        evidence:
          installScripts.kind === 'new'
            ? `adds ${installScripts.added.map((script) => `${script.hook}: ${script.command}`).join('; ')}`
            : 'adds an install script',
        own: waiverLines(input, record, reason.code),
      };
    case 'install_scripts_unknown':
      return unknownDetail(
        input,
        record,
        'install scripts unknown',
        installScripts.kind === 'unknown' ? installScripts.reason : undefined,
        [],
      );
    case 'integrity_mismatch':
      return {
        evidence: `the lockfile pins ${source.integrity ?? 'no sha512'}, which npm doesn't list for this version`,
        own: [],
      };
    default:
      return { evidence: '', own: [] };
  }
}

function waivable(policy: Policy, code: string): boolean {
  return policy.rules.some((rule) => rule.code === code && rule.waivable);
}

function ruleStep(input: Input, code: string, outcome: Shown): string {
  if (outcome === 'REJECT') {
    return rejectSteps[code] ?? 'No waiver exists for a REJECT rule.';
  }

  if (waivable(input.policy, code)) {
    return 'Review each change. To accept one, add its waiver to the "waivers" array of a --context file and replace reason and author.';
  }

  const wait =
    code === 'release_age'
      ? ' Wait until it clears, or pin an older version.'
      : '';

  return `${input.policy.ref.id} has no waiver for this rule.${wait}`;
}

function nodeLines(style: Style, members: readonly Item[]): string[] {
  const nodes = new Map<string, { item: Item; paths: string[] }>();
  for (const item of members) {
    const key = JSON.stringify([nodeLabel(item.record), item.own]);
    const seen = nodes.get(key);
    if (seen === undefined) {
      nodes.set(key, { item, paths: [location(item.record)] });
    } else {
      seen.paths.push(location(item.record));
    }
  }

  return [...nodes.values()].flatMap(({ item, paths }) => {
    const [path = ''] = paths;
    const more = paths.length > 1 ? ` (+${paths.length - 1} more)` : '';

    return [
      `      ${inert(nodeLabel(item.record))}  ${style.dim(`${inert(path)}${more}`)}`,
      ...item.own.map((line) => `        ${renderLine(line)}`),
    ];
  });
}

function renderGroup(
  input: Input,
  group: { code: string; outcome: Shown; items: readonly Item[] },
): string[] {
  const { style } = input;
  const { code, outcome, items } = group;
  const meaning = Object.hasOwn(ruleMeanings, code)
    ? ruleMeanings[code]
    : undefined;
  const lines = [
    `${style.outcome(outcome, outcome)} ${style.strong(inert(code))}  ${plural(items.length, 'node')}`,
    ...(meaning === undefined ? [] : [`  ${meaning}`]),
    `  ${ruleStep(input, code, outcome)}`,
  ];

  const subgroups = new Map<string, Item[]>();
  for (const item of items) {
    const key = JSON.stringify([item.evidence, item.rerun, item.step]);
    subgroups.set(key, [...(subgroups.get(key) ?? []), item]);
  }

  for (const members of subgroups.values()) {
    const [first] = members;
    if (first === undefined) {
      continue;
    }

    lines.push('');
    if (first.evidence !== '') {
      lines.push(`  - ${inert(first.evidence)}`);
    }

    for (const extra of [first.rerun, first.step]) {
      if (extra !== undefined) {
        lines.push(`    ${inert(extra)}`);
      }
    }

    lines.push(...nodeLines(style, members));
  }

  return lines;
}

function renderUnreadable(
  style: Style,
  records: readonly Unreadable[],
): string[] {
  if (records.length === 0) {
    return [];
  }

  return [
    `${style.outcome('UNREADABLE', 'UNREADABLE')}  ${plural(records.length, 'lockfile entry', 'lockfile entries')}`,
    "  gate can't decide these entries, so the run fails. Fix or regenerate them with npm.",
    '',
    ...records.map(
      (record) =>
        `      ${style.dim(inert(record.path === '' ? '(lockfile)' : location(record)))}  ${inert(record.error)}`,
    ),
    '',
  ];
}

function groupReasons(
  input: Input,
  decided: readonly Decided[],
): { code: string; outcome: Shown; items: Item[] }[] {
  const lockSources = new Map(
    input.nodes.flatMap((node) =>
      node.kind === 'package' && node.dependency === undefined
        ? [[node.path, node.source] as const]
        : [],
    ),
  );
  const groups = new Map<
    string,
    { code: string; outcome: Shown; items: Item[] }
  >();
  for (const record of decided) {
    if (record.outcome === 'ACCEPT') {
      continue;
    }

    for (const reason of record.reasons) {
      if (reason.kind === 'waived') {
        continue;
      }

      const key = `${reason.outcome} ${reason.code}`;
      const group = groups.get(key) ?? {
        code: reason.code,
        outcome: reason.outcome,
        items: [],
      };
      group.items.push({
        record,
        ...detailFor(input, record, reason, lockSources),
      });
      groups.set(key, group);
    }
  }

  const { rules } = input.policy;
  const order = (code: string) => {
    const index = rules.findIndex((rule) => rule.code === code);

    return index === -1 ? rules.length : index;
  };

  return [...groups.values()].toSorted((a, b) => {
    const bySeverity = severity[a.outcome] - severity[b.outcome];

    return bySeverity === 0 ? order(a.code) - order(b.code) : bySeverity;
  });
}

function header(input: Input, decided: readonly Decided[]): string[] {
  const { records, style, policy } = input;
  const unreadable = records.length - decided.length;
  const counts = (['ACCEPT', 'QUARANTINE', 'REJECT'] as const).flatMap(
    (outcome) => {
      const count = decided.filter(
        (record) => record.outcome === outcome,
      ).length;

      return count === 0 ? [] : [style.outcome(outcome, `${count} ${outcome}`)];
    },
  );
  if (unreadable > 0) {
    counts.push(style.outcome('UNREADABLE', `${unreadable} UNREADABLE`));
  }

  const [first] = decided;
  const waived = decided.flatMap((record) =>
    record.reasons.filter((reason) => reason.kind === 'waived'),
  ).length;
  const details = [
    `${policy.ref.id} ${policy.ref.digest}`,
    ...(first === undefined ? [] : [`evaluated at ${first.at.toISOString()}`]),
    ...(waived === 0 ? [] : [`${plural(waived, 'waiver')} applied`]),
  ];

  return [
    `gate verify: ${[plural(records.length, 'node'), ...counts].join(', ')}`,
    style.dim(details.join(', ')),
    '',
  ];
}

export function humanReport(input: Input): string {
  const { records, style } = input;
  const decided = records.filter((record) => record.kind === 'decision');
  const groups = groupReasons(input, decided);
  const lines = [
    ...header(input, decided),
    ...renderUnreadable(
      style,
      records.filter((record) => record.kind === 'unreadable'),
    ),
    ...groups.flatMap((group) => [...renderGroup(input, group), '']),
  ];

  if (groups.length > 0) {
    lines.push(
      'Summary',
      ...groups.map(
        ({ code, outcome, items }) =>
          `  ${style.outcome(outcome, outcome.padEnd(10))}  ${inert(code).padEnd(26)}  ${String(items.length).padStart(5)}${waivable(input.policy, code) ? '  waivable' : ''}`,
      ),
      '',
    );
  }

  const failing =
    records.length -
    decided.filter((record) => record.outcome === 'ACCEPT').length;
  lines.push(
    failing === 0
      ? 'Every node is ACCEPT.'
      : `${plural(failing, 'node is', 'nodes are')} not ACCEPT, so gate verify exits 1. gate verify --json prints the full decision records.`,
  );

  return `${lines.join('\n')}\n`;
}
