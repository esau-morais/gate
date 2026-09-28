import { Schema } from 'effect';
import { Provenance, Sha512Integrity } from '../evidence';
import { UtcTimestamp } from '../time';
import { RepositoryName } from './repository';

export const NpmVersionFacts = Schema.Struct({
  version: Schema.NonEmptyString,
  time: UtcTimestamp,
  integrity: Schema.NullOr(Sha512Integrity),
  provenance: Provenance,
  npmUser: Schema.NullOr(Schema.NonEmptyString),
  scripts: Schema.Union([
    Schema.Literal('unknown'),
    Schema.Record(Schema.String, Schema.String),
  ]),
  dependencies: Schema.Union([
    Schema.Literal('unknown'),
    Schema.Record(Schema.String, Schema.String),
  ]),
  repository: Schema.optionalKey(
    Schema.Union([Schema.Literal('unknown'), RepositoryName]),
  ),
  removed: Schema.optionalKey(Schema.Literal(true)),
});
export type NpmVersionFacts = typeof NpmVersionFacts.Type;
