import { Schema } from 'effect';
import { Sha512Integrity } from './evidence';
import { UtcTimestamp } from './time';

const Text = Schema.NonEmptyString;

export const AllowedSource = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('git'),
    name: Text,
    spec: Schema.String.check(Schema.isPattern(/#[0-9a-f]{40}$/)),
  }),
  Schema.Struct({
    kind: Schema.Literal('url'),
    name: Text,
    spec: Text,
    integrity: Sha512Integrity,
  }),
  Schema.Struct({
    kind: Schema.Literal('file'),
    name: Text,
    spec: Schema.String.check(
      Schema.isPattern(
        /^(file:)?(\.\/)?(?!.*(^|\/)\.\.?(\/|$))[A-Za-z0-9_@+-][A-Za-z0-9._@+/-]*$/,
      ),
    ),
  }),
]);
export type AllowedSource = typeof AllowedSource.Type;

export const Waiver = Schema.Struct({
  policy: Text,
  package: Text,
  version: Text,
  integrity: Sha512Integrity,
  rule: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_]*$/)),
  reason: Text,
  author: Text,
  expiresAt: UtcTimestamp,
});
export type Waiver = typeof Waiver.Type;

export type DecisionContext = {
  readonly allowedSources: readonly AllowedSource[];
  readonly waivers: readonly Waiver[];
};
