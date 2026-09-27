import type {
  Claim,
  Identity,
  InstallScript,
  PackageVersionEvidence,
  Sha512Integrity,
} from '../evidence';
import type { NpmVersionFacts } from './facts';

const installHooks = ['preinstall', 'install', 'postinstall'] as const;
const settledAfterMs = 72 * 3_600_000;

type Unknowable<T> = { kind: 'known'; value: T } | { kind: 'unknown' };

function identityOf(facts: NpmVersionFacts): Unknowable<Identity> {
  const { provenance } = facts;
  if (provenance.kind === 'unavailable') {
    return { kind: 'unknown' };
  }

  if (provenance.kind === 'verified') {
    return {
      kind: 'known',
      value: {
        kind: 'workflow',
        repository: provenance.repository,
        workflow: provenance.workflow,
      },
    };
  }

  return facts.npmUser === null
    ? { kind: 'unknown' }
    : { kind: 'known', value: { kind: 'account', name: facts.npmUser } };
}

function sameIdentity(a: Identity, b: Identity): boolean {
  if (a.kind === 'workflow' && b.kind === 'workflow') {
    return a.repository === b.repository && a.workflow === b.workflow;
  }

  if (a.kind === 'account' && b.kind === 'account') {
    return a.name === b.name;
  }

  return false;
}

function publisherContinuity(
  target: NpmVersionFacts,
  earlier: readonly NpmVersionFacts[],
): PackageVersionEvidence['publisher'] {
  const current = identityOf(target);
  if (current.kind === 'unknown') {
    return { kind: 'unknown', reason: 'publisher of this version unreadable' };
  }

  const identity = current.value;
  const seen = earlier.map(identityOf);
  const baseline: Identity[] = [];
  for (const [index, entry] of seen.entries()) {
    if (entry.kind === 'known' && entry.value.kind === identity.kind) {
      if (sameIdentity(entry.value, identity)) {
        const joinedAt = earlier[index]?.time;

        return baseline.length === 0 || joinedAt === undefined
          ? { kind: 'continuous', identity }
          : { kind: 'continuous', identity, joinedAt };
      }

      if (!baseline.some((known) => sameIdentity(known, entry.value))) {
        baseline.push(entry.value);
      }
    }
  }

  if (seen.some((entry) => entry.kind === 'unknown')) {
    return { kind: 'unknown', reason: 'an earlier publisher is unreadable' };
  }

  if (baseline.length === 0) {
    for (const entry of seen) {
      if (
        entry.kind === 'known' &&
        !baseline.some((known) => sameIdentity(known, entry.value))
      ) {
        baseline.push(entry.value);
      }
    }
  }

  const [first, ...rest] = baseline;

  return first === undefined
    ? { kind: 'first', identity }
    : { kind: 'changed', identity, earlier: [first, ...rest] };
}

function repositoryName(url: string): string | undefined {
  const bare = url.trim().replace(/#.*$/, '');
  const shorthand =
    /^(?:(github|gitlab|bitbucket):)?([\w.-]+)\/([\w.-]+)$/.exec(bare);
  const hosts: Record<string, string> = {
    github: 'github.com',
    gitlab: 'gitlab.com',
    bitbucket: 'bitbucket.org',
  };
  const scp = /^[\w.-]+@([\w.-]+):(?!\/)(.+)$/.exec(bare);
  let host: string;
  let path: string;
  if (shorthand !== null) {
    host = hosts[shorthand[1] ?? 'github'] ?? '';
    path = `${shorthand[2]}/${shorthand[3]}`;
  } else if (scp?.[1] !== undefined && scp[2] !== undefined) {
    host = scp[1];
    path = scp[2];
  } else {
    let parsed: URL;
    try {
      parsed = new URL(bare.replace(/^git\+/, ''));
    } catch {
      return undefined;
    }

    if (!['https:', 'http:', 'git:', 'ssh:'].includes(parsed.protocol)) {
      return undefined;
    }

    host = parsed.hostname.replace(/^www\./, '');
    path = parsed.pathname;
  }

  const segments = path
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.git$/, '')
    .split('/');
  const [owner, repo, view] = segments;
  if (
    owner === undefined ||
    owner === '' ||
    repo === undefined ||
    repo === ''
  ) {
    return undefined;
  }

  if (host === 'github.com') {
    return segments.length === 2 || view === 'tree' || view === 'blob'
      ? `${host}/${owner}/${repo}`.toLowerCase()
      : undefined;
  }

  return `${host}/${segments.join('/')}`.toLowerCase();
}

function repositoryCheck(
  identity: Identity,
  earlier: readonly NpmVersionFacts[],
): 'matched' | 'mismatched' | 'unchecked' {
  const source =
    identity.kind === 'workflow'
      ? repositoryName(identity.repository)
      : undefined;
  if (source === undefined) {
    return 'unchecked';
  }

  let declared = 0;
  let unreadable = false;
  for (const { repository } of earlier) {
    if (repository === undefined) {
      continue;
    }

    const named =
      repository === 'unknown' ? undefined : repositoryName(repository);
    if (named === undefined) {
      unreadable = true;
    } else if (named !== source) {
      return 'mismatched';
    } else {
      declared += 1;
    }
  }

  return declared > 0 && !unreadable ? 'matched' : 'unchecked';
}

function publisherExcludingRemoved(
  target: NpmVersionFacts,
  earlier: readonly NpmVersionFacts[],
): NonNullable<PackageVersionEvidence['publisherExcludingRemoved']> {
  const kept = earlier.filter((facts) => facts.removed !== true);
  if (kept.length === 0 && earlier.length > 0) {
    return { kind: 'unknown', reason: 'every earlier version was removed' };
  }

  const publisher = publisherContinuity(target, kept);

  return publisher.kind === 'changed'
    ? {
        ...publisher,
        repositoryCheck: repositoryCheck(publisher.identity, kept),
      }
    : publisher;
}

function earlierProvenance(
  earlier: readonly NpmVersionFacts[],
): PackageVersionEvidence['earlierProvenance'] {
  const kinds = earlier.map((facts) => facts.provenance.kind);
  if (kinds.includes('verified')) {
    return 'some';
  }

  return kinds.includes('unavailable') ? 'unknown' : 'none';
}

function earlierProvenanceExcludingRemoved(
  earlier: readonly NpmVersionFacts[],
): PackageVersionEvidence['earlierProvenance'] {
  const kept = earlier.filter((facts) => facts.removed !== true);

  return kept.length === 0 && earlier.length > 0
    ? 'unknown'
    : earlierProvenance(kept);
}

function installScriptsOf(facts: NpmVersionFacts): Unknowable<InstallScript[]> {
  const { scripts } = facts;
  if (scripts === 'unknown') {
    return { kind: 'unknown' };
  }

  return {
    kind: 'known',
    value: installHooks.flatMap((hook) => {
      const command = scripts[hook];

      return command === undefined ? [] : [{ hook, command }];
    }),
  };
}

function installScriptChange(
  target: NpmVersionFacts,
  previous: NpmVersionFacts | undefined,
): PackageVersionEvidence['installScripts'] {
  const current = installScriptsOf(target);
  if (current.kind === 'unknown') {
    return { kind: 'unknown', reason: 'scripts of this version unreadable' };
  }

  const [first, ...rest] = current.value;
  if (first === undefined) {
    return { kind: 'none' };
  }

  const before =
    previous === undefined
      ? { kind: 'known' as const, value: [] }
      : installScriptsOf(previous);
  if (before.kind === 'unknown') {
    return {
      kind: 'unknown',
      reason: 'scripts of the previous version unreadable',
    };
  }

  const added = current.value.filter(
    (script) =>
      !before.value.some(
        (old) => old.hook === script.hook && old.command === script.command,
      ),
  );
  const [firstAdded, ...restAdded] = added;

  return firstAdded === undefined
    ? { kind: 'unchanged', scripts: [first, ...rest] }
    : { kind: 'new', added: [firstAdded, ...restAdded] };
}

function lockfileIntegrityCheck(
  published: Sha512Integrity | null,
  lockfile: { integrity: Sha512Integrity | null } | undefined,
): Pick<PackageVersionEvidence, 'integrityCheck'> & {
  integrity: Sha512Integrity | null;
} {
  if (lockfile === undefined) {
    return { integrity: published, integrityCheck: 'unchecked' };
  }

  if (published === null || lockfile.integrity === null) {
    return { integrity: null, integrityCheck: 'unchecked' };
  }

  return {
    integrity: lockfile.integrity,
    integrityCheck: published === lockfile.integrity ? 'matched' : 'mismatched',
  };
}

export function npmVersionEvidence(input: {
  name: string;
  registry: string;
  target: NpmVersionFacts;
  earlier: readonly NpmVersionFacts[];
  lockfile?: { integrity: Sha512Integrity | null };
  feeds: PackageVersionEvidence['feeds'];
  claims: readonly Claim[];
}): PackageVersionEvidence {
  const { target } = input;
  const late = input.earlier.find((facts) => facts.time >= target.time);
  if (late !== undefined) {
    throw new RangeError(
      `${input.name}@${late.version} was not published before ${target.version}`,
    );
  }

  const earlier = input.earlier
    .filter(
      (facts) => target.time.getTime() - facts.time.getTime() >= settledAfterMs,
    )
    .toSorted((a, b) => a.time.getTime() - b.time.getTime());

  const { integrity, integrityCheck } = lockfileIntegrityCheck(
    target.integrity,
    input.lockfile,
  );

  return {
    subject: { ecosystem: 'npm', name: input.name, version: target.version },
    source: { kind: 'registry', registry: input.registry, integrity },
    publishTime: { kind: 'packument', at: target.time },
    provenance: target.provenance,
    earlierProvenance: earlierProvenance(earlier),
    earlierProvenanceExcludingRemoved:
      earlierProvenanceExcludingRemoved(earlier),
    publisher: publisherContinuity(target, earlier),
    publisherExcludingRemoved: publisherExcludingRemoved(target, earlier),
    installScripts: installScriptChange(target, earlier.at(-1)),
    integrityCheck,
    feeds: input.feeds,
    claims: input.claims,
  };
}
