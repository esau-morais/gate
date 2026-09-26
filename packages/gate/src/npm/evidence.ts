import type {
  Claim,
  Identity,
  InstallScript,
  PackageVersionEvidence,
} from '../evidence';
import type { NpmVersionFacts } from './facts';

const installHooks = ['preinstall', 'install', 'postinstall'] as const;
const settledAfterMs = 72 * 3_600_000;

type Unknowable<T> = { kind: 'known'; value: T } | { kind: 'unknown' };

function identityOf(facts: NpmVersionFacts): Unknowable<Identity> {
  if (facts.provenance === 'unknown') {
    return { kind: 'unknown' };
  }

  if (facts.provenance !== 'absent') {
    return {
      kind: 'known',
      value: { kind: 'workflow', ...facts.provenance },
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

function provenanceOf(
  facts: NpmVersionFacts,
): PackageVersionEvidence['provenance'] {
  switch (facts.provenance) {
    case 'absent':
      return { kind: 'absent' };
    case 'unknown':
      return { kind: 'unavailable', reason: 'provenance unreadable' };
    default:
      return { kind: 'verified', ...facts.provenance };
  }
}

function earlierProvenance(
  earlier: readonly NpmVersionFacts[],
): PackageVersionEvidence['earlierProvenance'] {
  if (earlier.some((facts) => typeof facts.provenance === 'object')) {
    return 'some';
  }

  return earlier.some((facts) => facts.provenance === 'unknown')
    ? 'unknown'
    : 'none';
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

export function npmVersionEvidence(input: {
  name: string;
  registry: string;
  target: NpmVersionFacts;
  earlier: readonly NpmVersionFacts[];
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

  return {
    subject: { ecosystem: 'npm', name: input.name, version: target.version },
    source: {
      kind: 'registry',
      registry: input.registry,
      integrity: target.integrity,
    },
    publishTime: { kind: 'packument', at: target.time },
    provenance: provenanceOf(target),
    earlierProvenance: earlierProvenance(earlier),
    publisher: publisherContinuity(target, earlier),
    installScripts: installScriptChange(target, earlier.at(-1)),
    feeds: input.feeds,
    claims: input.claims,
  };
}
