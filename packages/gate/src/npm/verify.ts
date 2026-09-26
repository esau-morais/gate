import type { DecisionContext } from '../context';
import type { PackageVersionEvidence } from '../evidence';
import { decide, type Decision, type Policy } from '../policy';
import type { DecisionRecord, LockfileDigest } from '../record';
import { npmVersionEvidence } from './evidence';
import {
  npmRegistry,
  type LockfileNode,
  type LockfileSource,
  type Location,
} from './lockfile';
import { feedsFor, type OsvSnapshot } from './osv';
import { npmPackumentFacts } from './packument';
import type { TrustRoot } from './provenance';

export type EvidenceStore = {
  readonly packument: (name: string) => unknown;
  readonly attestations: (name: string) => ReadonlyMap<string, unknown>;
  readonly trust: TrustRoot;
  readonly osv: OsvSnapshot;
};

export type VerifyRecord =
  | (Location &
      Decision & {
        readonly kind: 'decision';
        readonly dev: boolean;
        readonly optional: boolean;
        readonly at: Date;
        readonly evidence: PackageVersionEvidence;
      })
  | (Location & { readonly kind: 'unreadable'; readonly error: string });

type PackageNode = Extract<LockfileNode, { kind: 'package' }>;

function unknownEvidence(
  node: PackageNode,
  source: PackageVersionEvidence['source'],
  feeds: PackageVersionEvidence['feeds'],
  reason: string,
): PackageVersionEvidence {
  return {
    subject: { ecosystem: 'npm', name: node.name, version: node.version },
    source,
    publishTime: { kind: 'unknown', reason },
    provenance: { kind: 'unavailable', reason },
    earlierProvenance: 'unknown',
    publisher: { kind: 'unknown', reason },
    installScripts: { kind: 'unknown', reason },
    integrityCheck: 'unchecked',
    feeds,
    claims: [],
  };
}

function registryEvidence(
  node: PackageNode,
  integrity: Extract<LockfileSource, { kind: 'registry' }>['integrity'],
  store: EvidenceStore,
  feeds: PackageVersionEvidence['feeds'],
): PackageVersionEvidence {
  const unknown = (reason: string) =>
    unknownEvidence(
      node,
      { kind: 'registry', registry: npmRegistry, integrity: null },
      feeds,
      reason,
    );
  if (node.version === null) {
    return unknown('registry entry without a version');
  }

  const packument = store.packument(node.name);
  if (packument === undefined) {
    return unknown('no packument recorded');
  }

  const facts = npmPackumentFacts({
    packument,
    name: node.name,
    version: node.version,
    attestations: store.attestations(node.name),
    trust: store.trust,
  });
  if (facts.kind === 'unreadable') {
    return unknown(facts.reason);
  }

  const evidence = npmVersionEvidence({
    name: node.name,
    registry: npmRegistry,
    target: facts.target,
    earlier: facts.earlier,
    lockfile: { integrity },
    feeds,
    claims: [],
  });

  return node.hasInstallScript === true &&
    evidence.installScripts.kind === 'none'
    ? {
        ...evidence,
        installScripts: {
          kind: 'unknown',
          reason:
            'lockfile records an install script the packument does not list',
        },
      }
    : evidence;
}

function exoticEvidence(
  node: PackageNode,
  source: Exclude<LockfileSource, { kind: 'registry' }>,
  feeds: PackageVersionEvidence['feeds'],
): PackageVersionEvidence {
  return unknownEvidence(
    node,
    {
      kind: source.kind,
      spec: source.spec,
      integrity: source.kind === 'url' ? source.integrity : null,
    },
    feeds,
    `a ${source.kind} source has no registry evidence`,
  );
}

function evidenceFor(
  node: PackageNode,
  store: EvidenceStore,
  at: Date,
): PackageVersionEvidence {
  const feeds = feedsFor(store.osv, {
    name: node.name,
    version: node.version,
    at,
  });
  const { source } = node;

  return source.kind === 'registry'
    ? registryEvidence(node, source.integrity, store, feeds)
    : exoticEvidence(node, source, feeds);
}

export function verifyNodes(input: {
  nodes: readonly LockfileNode[];
  store: EvidenceStore;
  at: Date;
  policy: Policy;
  context: DecisionContext;
}): VerifyRecord[] {
  return input.nodes.map((node): VerifyRecord => {
    if (node.kind === 'unreadable') {
      return node;
    }

    const location =
      node.dependency === undefined
        ? { path: node.path }
        : { path: node.path, dependency: node.dependency };
    const evidence = evidenceFor(node, input.store, input.at);
    const decision = decide({
      evidence,
      now: input.at,
      context: input.context,
      canonical: input.policy,
    });

    return {
      kind: 'decision',
      ...location,
      dev: node.dev,
      optional: node.optional,
      at: input.at,
      ...decision,
      evidence,
    };
  });
}

export function decisionRecords(input: {
  records: readonly VerifyRecord[];
  context: DecisionContext;
  lockfile: LockfileDigest;
}): DecisionRecord[] {
  return input.records.flatMap((record): DecisionRecord[] =>
    record.kind === 'decision'
      ? [
          {
            type: 'gate.decision/v1',
            path: record.path,
            ...(record.dependency === undefined
              ? {}
              : { dependency: record.dependency }),
            dev: record.dev,
            optional: record.optional,
            subject: record.evidence.subject,
            at: record.at,
            lockfile: input.lockfile,
            context: input.context,
            evidence: record.evidence,
            outcome: record.outcome,
            reasons: record.reasons,
            policies: record.policies,
          },
        ]
      : [],
  );
}

export function verifyExitCode(records: readonly VerifyRecord[]): 0 | 1 {
  return records.every(
    (record) => record.kind === 'decision' && record.outcome === 'ACCEPT',
  )
    ? 0
    : 1;
}
