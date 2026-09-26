import { Schema } from 'effect';

const Text = Schema.NonEmptyString;

export const Sha512Integrity = Schema.String.check(
  Schema.isPattern(/^sha512-[A-Za-z0-9+/]{86}==$/),
).pipe(Schema.brand('Sha512Integrity'));
export type Sha512Integrity = typeof Sha512Integrity.Type;

export const Identity = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('workflow'),
    repository: Text,
    workflow: Text,
  }),
  Schema.Struct({ kind: Schema.Literal('account'), name: Text }),
]);
export type Identity = typeof Identity.Type;

export const InstallScript = Schema.Struct({
  hook: Schema.Literals(['preinstall', 'install', 'postinstall']),
  command: Schema.String,
});
export type InstallScript = typeof InstallScript.Type;

export const FeedHit = Schema.Struct({ feed: Text, id: Text });
export type FeedHit = typeof FeedHit.Type;

export const Claim = Schema.Struct({
  kind: Text,
  source: Text,
  probability: Schema.Finite.check(
    Schema.isBetween({ minimum: 0, maximum: 1 }),
  ),
});
export type Claim = typeof Claim.Type;

const Unknown = Schema.Struct({
  kind: Schema.Literal('unknown'),
  reason: Text,
});

export const PackageVersionEvidence = Schema.Struct({
  subject: Schema.Struct({
    ecosystem: Schema.Literal('npm'),
    name: Text,
    version: Text,
  }),
  source: Schema.Union([
    Schema.Struct({
      kind: Schema.Literal('registry'),
      registry: Text,
      integrity: Schema.NullOr(Sha512Integrity),
    }),
    Schema.Struct({
      kind: Schema.Literals(['git', 'url', 'file']),
      spec: Text,
      integrity: Schema.NullOr(Sha512Integrity),
    }),
  ]),
  publishTime: Schema.Union([
    Schema.Struct({ kind: Schema.Literal('packument'), at: Schema.Date }),
    Unknown,
  ]),
  provenance: Schema.Union([
    Schema.Struct({
      kind: Schema.Literal('verified'),
      repository: Text,
      workflow: Text,
    }),
    Schema.Struct({ kind: Schema.Literal('absent') }),
    Schema.Struct({ kind: Schema.Literal('unavailable'), reason: Text }),
  ]),
  earlierProvenance: Schema.Literals(['some', 'none', 'unknown']),
  publisher: Schema.Union([
    Schema.Struct({
      kind: Schema.Literal('continuous'),
      identity: Identity,
      joinedAt: Schema.optionalKey(Schema.Date),
    }),
    Schema.Struct({ kind: Schema.Literal('first'), identity: Identity }),
    Schema.Struct({
      kind: Schema.Literal('changed'),
      identity: Identity,
      earlier: Schema.NonEmptyArray(Identity),
    }),
    Unknown,
  ]),
  installScripts: Schema.Union([
    Schema.Struct({ kind: Schema.Literal('none') }),
    Schema.Struct({
      kind: Schema.Literal('unchanged'),
      scripts: Schema.NonEmptyArray(InstallScript),
    }),
    Schema.Struct({
      kind: Schema.Literal('new'),
      added: Schema.NonEmptyArray(InstallScript),
    }),
    Unknown,
  ]),
  feeds: Schema.Union([
    Schema.Struct({
      kind: Schema.Literal('checked'),
      hits: Schema.Array(FeedHit),
    }),
    Schema.Struct({ kind: Schema.Literal('unavailable'), reason: Text }),
  ]),
  claims: Schema.Array(Claim),
});
export type PackageVersionEvidence = typeof PackageVersionEvidence.Type;
