import { Result, Schema, SchemaTransformation } from 'effect';
import type { FeedHit, PackageVersionEvidence } from '../evidence';

const feed = 'osv';

const OsvTimestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/),
).pipe(Schema.decodeTo(Schema.Date, SchemaTransformation.dateFromString));

const OsvRecord = Schema.Struct({
  id: Schema.NonEmptyString,
  published: OsvTimestamp,
  withdrawn: Schema.optionalKey(OsvTimestamp),
  affected: Schema.Array(
    Schema.Struct({
      package: Schema.Struct({
        ecosystem: Schema.String,
        name: Schema.NonEmptyString,
      }),
      versions: Schema.optionalKey(Schema.Array(Schema.String)),
      ranges: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            type: Schema.String,
            events: Schema.Array(Schema.Record(Schema.String, Schema.String)),
          }),
        ),
      ),
    }),
  ),
  database_specific: Schema.optionalKey(
    Schema.Struct({
      'malicious-packages-origins': Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            import_time: Schema.optionalKey(OsvTimestamp),
            versions: Schema.optionalKey(Schema.Array(Schema.String)),
          }),
        ),
      ),
    }),
  ),
});
type OsvRecord = typeof OsvRecord.Type;

const decodeRecord = Schema.decodeUnknownResult(OsvRecord);

type Affected =
  | {
      readonly kind: 'versions';
      readonly id: string;
      readonly all: boolean;
      readonly versions: ReadonlySet<string>;
      readonly availableAt: (version: string | null) => Date;
      readonly withdrawnAt: Date | undefined;
    }
  | { readonly kind: 'unreadable'; readonly id: string };

export type OsvSnapshot =
  | {
      readonly kind: 'loaded';
      readonly byName: ReadonlyMap<string, readonly Affected[]>;
    }
  | { readonly kind: 'unavailable'; readonly reason: string };

function coversEveryVersion(
  ranges: NonNullable<OsvRecord['affected'][number]['ranges']>,
): boolean | undefined {
  if (ranges.length === 0) {
    return false;
  }

  const open = ranges.every(
    (range) =>
      (range.type === 'SEMVER' || range.type === 'ECOSYSTEM') &&
      range.events.length === 1 &&
      range.events[0]?.introduced === '0' &&
      Object.keys(range.events[0]).length === 1,
  );

  return open ? true : undefined;
}

function availability(record: OsvRecord): (version: string | null) => Date {
  const origins =
    record.database_specific?.['malicious-packages-origins'] ?? [];
  const earliest = (times: readonly (Date | undefined)[]) =>
    times
      .filter((time) => time !== undefined)
      .reduce<Date | undefined>(
        (min, time) => (min === undefined || time < min ? time : min),
        undefined,
      );

  return (version) =>
    earliest(
      origins
        .filter(
          (origin) =>
            version !== null && origin.versions?.includes(version) === true,
        )
        .map((origin) => origin.import_time),
    ) ??
    earliest(origins.map((origin) => origin.import_time)) ??
    record.published;
}

export function readOsvSnapshot(records: readonly unknown[]): OsvSnapshot {
  const byName = new Map<string, Affected[]>();
  for (const raw of records) {
    const decoded = decodeRecord(raw);
    if (Result.isFailure(decoded)) {
      return { kind: 'unavailable', reason: 'an OSV record is unreadable' };
    }

    const record = decoded.success;
    const availableAt = availability(record);
    for (const affected of record.affected) {
      if (affected.package.ecosystem !== 'npm') {
        continue;
      }

      const all =
        affected.ranges === undefined
          ? false
          : coversEveryVersion(affected.ranges);
      const entry: Affected =
        all === undefined
          ? { kind: 'unreadable', id: record.id }
          : {
              kind: 'versions',
              id: record.id,
              all,
              versions: new Set(affected.versions ?? []),
              availableAt,
              withdrawnAt: record.withdrawn,
            };
      byName.set(affected.package.name, [
        ...(byName.get(affected.package.name) ?? []),
        entry,
      ]);
    }
  }

  return { kind: 'loaded', byName };
}

export function feedsFor(
  snapshot: OsvSnapshot,
  query: { name: string; version: string | null; at: Date },
): PackageVersionEvidence['feeds'] {
  if (snapshot.kind === 'unavailable') {
    return snapshot;
  }

  const hits: FeedHit[] = [];
  for (const affected of snapshot.byName.get(query.name) ?? []) {
    if (affected.kind === 'unreadable') {
      return {
        kind: 'unavailable',
        reason: `${affected.id} has a version range gate does not evaluate`,
      };
    }

    const listed =
      query.version === null ||
      affected.all ||
      affected.versions.has(query.version);
    const withdrawn =
      affected.withdrawnAt !== undefined && affected.withdrawnAt <= query.at;
    if (
      listed &&
      !withdrawn &&
      affected.availableAt(query.version) <= query.at &&
      !hits.some((hit) => hit.id === affected.id)
    ) {
      hits.push({ feed, id: affected.id });
    }
  }

  return { kind: 'checked', hits };
}
