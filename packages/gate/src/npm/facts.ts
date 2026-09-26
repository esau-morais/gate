import { Schema } from 'effect';
import { Sha512Integrity } from '../evidence';
import { UtcTimestamp } from '../time';

export const NpmVersionFacts = Schema.Struct({
  version: Schema.NonEmptyString,
  time: UtcTimestamp,
  integrity: Schema.NullOr(Sha512Integrity),
  provenance: Schema.Union([
    Schema.Literals(['absent', 'unknown']),
    Schema.Struct({
      repository: Schema.NonEmptyString,
      workflow: Schema.NonEmptyString,
    }),
    Schema.Struct({ unavailable: Schema.NonEmptyString }),
  ]),
  npmUser: Schema.NullOr(Schema.NonEmptyString),
  scripts: Schema.Union([
    Schema.Literal('unknown'),
    Schema.Record(Schema.String, Schema.String),
  ]),
});
export type NpmVersionFacts = typeof NpmVersionFacts.Type;
