import type {
  Claim,
  FirstPublish,
  Identity,
  InstallScript,
  PackageVersionEvidence,
  RepositoryCheck,
  Sha512Integrity,
} from '../evidence';
import type { NpmVersionFacts } from './facts';
import { repositoryName } from './repository';

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

function repositoryCheck(
  identity: Identity,
  earlier: readonly NpmVersionFacts[],
): RepositoryCheck {
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

    if (repository === 'unknown') {
      unreadable = true;
    } else if (repository !== source) {
      return 'mismatched';
    } else {
      declared += 1;
    }
  }

  return declared > 0 && !unreadable ? 'matched' : 'unchecked';
}

function listedHistory(
  earlier: readonly NpmVersionFacts[],
): readonly NpmVersionFacts[] | undefined {
  const listed = earlier.filter((facts) => facts.removed !== true);

  return listed.length === 0 && earlier.length > 0 ? undefined : listed;
}

function publisherExcludingRemoved(
  target: NpmVersionFacts,
  earlier: readonly NpmVersionFacts[],
): NonNullable<PackageVersionEvidence['publisherExcludingRemoved']> {
  const kept = listedHistory(earlier);
  if (kept === undefined) {
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
  const kept = listedHistory(earlier);

  return kept === undefined ? 'unknown' : earlierProvenance(kept);
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

const exoticSpec = /^[a-z][a-z0-9+.-]*:|[/\\]|^\.\.?$/i;

type DependencyTarget =
  | { readonly kind: 'registry'; readonly name: string }
  | { readonly kind: 'exotic'; readonly spec: string };

function dependencyTarget(name: string, spec: string): DependencyTarget {
  if (spec.startsWith('npm:')) {
    const aliased = spec.slice('npm:'.length);
    const at = aliased.indexOf('@', 1);

    return {
      kind: 'registry',
      name: at === -1 ? aliased : aliased.slice(0, at),
    };
  }

  return exoticSpec.test(spec)
    ? { kind: 'exotic', spec }
    : { kind: 'registry', name };
}

function targetKey(target: DependencyTarget): string {
  return target.kind === 'registry'
    ? `registry:${target.name}`
    : `exotic:${target.spec}`;
}

type AddedDependencies =
  | { readonly kind: 'unknown'; readonly reason: string }
  | {
      readonly kind: 'known';
      readonly added: readonly {
        readonly name: string;
        readonly spec: string;
        readonly target: DependencyTarget;
      }[];
    };

function addedDependencies(
  target: NpmVersionFacts,
  earlier: readonly NpmVersionFacts[],
): AddedDependencies {
  const current = target.dependencies;
  if (current === 'unknown') {
    return {
      kind: 'unknown',
      reason: 'dependencies of this version unreadable',
    };
  }

  const kept = listedHistory(earlier);
  if (kept === undefined) {
    return { kind: 'unknown', reason: 'every earlier version was removed' };
  }

  const before = kept.at(-1)?.dependencies ?? {};
  if (before === 'unknown') {
    return {
      kind: 'unknown',
      reason: 'dependencies of the previous version unreadable',
    };
  }

  const known = new Set(
    Object.entries(before).map(([name, spec]) =>
      targetKey(dependencyTarget(name, spec)),
    ),
  );

  return {
    kind: 'known',
    added: Object.entries(current).flatMap(([name, spec]) => {
      const resolved = dependencyTarget(name, spec);

      return known.has(targetKey(resolved))
        ? []
        : [{ name, spec, target: resolved }];
    }),
  };
}

function newDependencies(
  target: NpmVersionFacts,
  earlier: readonly NpmVersionFacts[],
  firstPublish: (name: string) => FirstPublish,
): NonNullable<PackageVersionEvidence['newDependencies']> {
  const found = addedDependencies(target, earlier);
  if (found.kind === 'unknown') {
    return found;
  }

  const [first, ...rest] = found.added.map(({ name, spec, target: to }) => ({
    name,
    spec,
    firstPublish:
      to.kind === 'registry'
        ? firstPublish(to.name)
        : { kind: 'exotic' as const },
  }));

  return first === undefined
    ? { kind: 'none' }
    : { kind: 'added', added: [first, ...rest] };
}

function settledHistory(
  target: NpmVersionFacts,
  earlier: readonly NpmVersionFacts[],
): NpmVersionFacts[] {
  return earlier
    .filter(
      (facts) => target.time.getTime() - facts.time.getTime() >= settledAfterMs,
    )
    .toSorted((a, b) => a.time.getTime() - b.time.getTime());
}

export function addedDependencyPackages(
  target: NpmVersionFacts,
  earlier: readonly NpmVersionFacts[],
): string[] {
  const found = addedDependencies(target, settledHistory(target, earlier));

  return found.kind === 'unknown'
    ? []
    : found.added.flatMap(({ target: to }) =>
        to.kind === 'registry' ? [to.name] : [],
      );
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
  firstPublish: (name: string) => FirstPublish;
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

  const earlier = settledHistory(target, input.earlier);

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
    newDependencies: newDependencies(target, earlier, input.firstPublish),
    integrityCheck,
    feeds: input.feeds,
    claims: input.claims,
  };
}
