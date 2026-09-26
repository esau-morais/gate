import { readdirSync, readFileSync } from 'node:fs';
import { Schema } from 'effect';
import { NpmVersionFacts } from '../../src/npm/facts';
import { UtcTimestamp } from '../../src/time';

const Text = Schema.NonEmptyString;

export const ReplayFixture = Schema.Struct({
  incident: Text,
  capturedAt: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/)),
  sources: Schema.NonEmptyArray(Schema.Struct({ url: Text, facts: Text })),
  gaps: Schema.Array(Text),
  package: Text,
  target: NpmVersionFacts,
  earlier: Schema.Array(NpmVersionFacts),
  feedHits: Schema.Array(
    Schema.Struct({ feed: Text, id: Text, availableAt: UtcTimestamp }),
  ),
  takedownAt: Schema.NullOr(UtcTimestamp),
  miss: Schema.optionalKey(Text),
  evaluations: Schema.NonEmptyArray(
    Schema.Struct({
      at: UtcTimestamp,
      moment: Text,
      expected: Schema.Struct({
        outcome: Schema.Literals(['ACCEPT', 'QUARANTINE', 'REJECT']),
        reasons: Schema.Array(Text),
      }),
    }),
  ),
});
export type ReplayFixture = typeof ReplayFixture.Type;

const decode = Schema.decodeUnknownSync(Schema.fromJsonString(ReplayFixture));

export function loadReplayFixtures(): {
  name: string;
  fixture: ReplayFixture;
}[] {
  const dir = new URL('./fixtures/', import.meta.url);

  return readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .toSorted()
    .map((file) => ({
      name: file.replace(/\.json$/, ''),
      fixture: decode(readFileSync(new URL(file, dir), 'utf8')),
    }));
}
