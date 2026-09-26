import { Option, Result, Schema } from 'effect';
import { Sha512Integrity } from '../evidence';
import { UtcTimestamp } from '../time';
import type { NpmVersionFacts } from './facts';
import { verifyNpmProvenance, type TrustMaterial } from './provenance';

export type PackumentFacts =
  | {
      readonly kind: 'read';
      readonly target: NpmVersionFacts;
      readonly earlier: readonly NpmVersionFacts[];
    }
  | { readonly kind: 'unreadable'; readonly reason: string };

const historySize = 10;
const nonVersionTimeKeys = new Set(['created', 'modified', 'unpublished']);

const Packument = Schema.Struct({
  name: Schema.NonEmptyString,
  time: Schema.Record(Schema.String, Schema.Unknown),
  versions: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});

const VersionDocument = Schema.Struct({
  name: Schema.NonEmptyString,
  version: Schema.NonEmptyString,
  dist: Schema.Struct({
    integrity: Schema.optionalKey(Schema.String),
    attestations: Schema.optionalKey(
      Schema.Struct({ provenance: Schema.optionalKey(Schema.Unknown) }),
    ),
  }),
  _npmUser: Schema.optionalKey(Schema.Struct({ name: Schema.NonEmptyString })),
  scripts: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  gypfile: Schema.optionalKey(Schema.Boolean),
});
type VersionDocument = typeof VersionDocument.Type;

const decodePackument = Schema.decodeUnknownResult(Packument);
const decodeVersion = Schema.decodeUnknownOption(VersionDocument);
const decodeTime = Schema.decodeUnknownOption(UtcTimestamp);
const decodeSha512 = Schema.decodeUnknownOption(Sha512Integrity);

type Published = { readonly version: string; readonly time: Date };

function installScripts(doc: VersionDocument): Record<string, string> {
  const scripts = doc.scripts ?? {};
  const runsGyp =
    doc.gypfile === true &&
    scripts.install === undefined &&
    scripts.preinstall === undefined;

  return runsGyp ? { ...scripts, install: 'node-gyp rebuild' } : scripts;
}

function provenanceOf(
  doc: VersionDocument,
  integrity: Sha512Integrity | null,
  input: {
    name: string;
    attestations: ReadonlyMap<string, unknown>;
    trust: TrustMaterial | null;
  },
): NpmVersionFacts['provenance'] {
  if (doc.dist.attestations?.provenance === undefined) {
    return 'absent';
  }

  if (integrity === null) {
    return { unavailable: 'no sha512 integrity to match' };
  }

  if (input.trust === null) {
    return { unavailable: 'no trusted root' };
  }

  const attestations = input.attestations.get(doc.version);
  if (attestations === undefined) {
    return { unavailable: 'attestation bundle not recorded' };
  }

  const verified = verifyNpmProvenance({
    trust: input.trust,
    attestations,
    name: input.name,
    version: doc.version,
    integrity,
  });

  return verified.kind === 'verified'
    ? { repository: verified.repository, workflow: verified.workflow }
    : { unavailable: verified.reason };
}

function versionFacts(
  published: Published,
  raw: unknown,
  input: {
    name: string;
    attestations: ReadonlyMap<string, unknown>;
    trust: TrustMaterial | null;
  },
): NpmVersionFacts {
  const doc = Option.getOrUndefined(decodeVersion(raw));
  if (
    doc === undefined ||
    doc.name !== input.name ||
    doc.version !== published.version
  ) {
    return {
      ...published,
      integrity: null,
      provenance: {
        unavailable:
          raw === undefined
            ? 'version document missing'
            : 'version document unreadable',
      },
      npmUser: null,
      scripts: 'unknown',
    };
  }

  const integrity = Option.getOrNull(decodeSha512(doc.dist.integrity));

  return {
    ...published,
    integrity,
    provenance: provenanceOf(doc, integrity, input),
    npmUser: doc._npmUser?.name ?? null,
    scripts: installScripts(doc),
  };
}

export function npmPackumentFacts(input: {
  packument: unknown;
  name: string;
  version: string;
  attestations: ReadonlyMap<string, unknown>;
  trust: TrustMaterial | null;
}): PackumentFacts {
  const decoded = decodePackument(input.packument);
  if (Result.isFailure(decoded)) {
    return { kind: 'unreadable', reason: 'packument is unreadable' };
  }

  const packument = decoded.success;
  if (packument.name !== input.name) {
    return {
      kind: 'unreadable',
      reason: `packument is for ${packument.name}, not ${input.name}`,
    };
  }

  const published: Published[] = [];
  for (const [version, value] of Object.entries(packument.time)) {
    if (nonVersionTimeKeys.has(version)) {
      continue;
    }

    const time = decodeTime(value);
    if (Option.isNone(time)) {
      return {
        kind: 'unreadable',
        reason: `publish time of ${version} is unreadable`,
      };
    }

    published.push({ version, time: time.value });
  }

  const target = published.find(({ version }) => version === input.version);
  if (target === undefined) {
    return {
      kind: 'unreadable',
      reason: `packument has no publish time for ${input.version}`,
    };
  }

  const versions = packument.versions ?? {};
  const facts = (entry: Published) =>
    versionFacts(
      entry,
      Object.hasOwn(versions, entry.version)
        ? versions[entry.version]
        : undefined,
      input,
    );

  return {
    kind: 'read',
    target: facts(target),
    earlier: published
      .filter(({ time }) => time < target.time)
      .toSorted((a, b) => a.time.getTime() - b.time.getTime())
      .slice(-historySize)
      .map(facts),
  };
}
