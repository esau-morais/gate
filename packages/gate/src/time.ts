import { Schema, SchemaTransformation } from 'effect';

export const UtcTimestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/),
  Schema.makeFilter(
    (text: string) =>
      new Date(text).toISOString().slice(0, 19) === text.slice(0, 19) ||
      'not a real UTC instant',
  ),
).pipe(Schema.decodeTo(Schema.Date, SchemaTransformation.dateFromString));
