import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Schema } from 'effect';
import { UtcTimestamp } from '../../src/time';

const Text = Schema.NonEmptyString;
const Outcome = Schema.Literals(['ACCEPT', 'QUARANTINE', 'REJECT']);

export const VerifyCase = Schema.Struct({
  incident: Text,
  capturedAt: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/)),
  sources: Schema.NonEmptyArray(Schema.Struct({ url: Text, facts: Text })),
  gaps: Schema.Array(Text),
  lockfile: Text,
  evaluations: Schema.NonEmptyArray(
    Schema.Struct({
      at: UtcTimestamp,
      moment: Text,
      exitCode: Schema.Literals([0, 1]),
      nodes: Schema.NonEmptyArray(
        Schema.Struct({
          path: Text,
          dependency: Schema.optionalKey(Text),
          outcome: Outcome,
          reasons: Schema.Array(Text),
        }),
      ),
    }),
  ),
});
export type VerifyCase = typeof VerifyCase.Type;

const decode = Schema.decodeUnknownSync(Schema.fromJsonString(VerifyCase));

export const evidenceDir = new URL('./evidence/', import.meta.url);

export function loadVerifyCases(root = new URL('./cases/', import.meta.url)): {
  name: string;
  dir: URL;
  fixture: VerifyCase;
}[] {
  return readdirSync(root)
    .toSorted()
    .map((name) => {
      const dir = new URL(`${name}/`, root);

      return {
        name,
        dir,
        fixture: decode(readFileSync(new URL('case.json', dir), 'utf8')),
      };
    });
}

const OutputLine = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({
      kind: Schema.Literal('decision'),
      path: Schema.String,
      dependency: Schema.optionalKey(Schema.String),
      outcome: Schema.String,
      reasons: Schema.Array(Schema.Struct({ code: Schema.String })),
      policies: Schema.NonEmptyArray(
        Schema.Struct({
          id: Schema.String,
          digest: Schema.String.check(
            Schema.isPattern(/^sha256:[0-9a-f]{64}$/),
          ),
        }),
      ),
    }),
    Schema.Struct({
      kind: Schema.Literal('unreadable'),
      path: Schema.String,
      dependency: Schema.optionalKey(Schema.String),
      error: Schema.String,
    }),
  ]),
);
const decodeLine = Schema.decodeUnknownSync(OutputLine);

export type NodeSummary =
  | {
      path: string;
      dependency?: string;
      outcome: string;
      reasons: readonly string[];
    }
  | { path: string; dependency?: string; unreadable: string };

export function summarizeOutput(stdout: string): NodeSummary[] {
  return stdout
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const record = decodeLine(line);
      const location =
        record.dependency === undefined
          ? { path: record.path }
          : { path: record.path, dependency: record.dependency };

      return record.kind === 'decision'
        ? {
            ...location,
            outcome: record.outcome,
            reasons: record.reasons.map((reason) => reason.code).toSorted(),
          }
        : { ...location, unreadable: record.error };
    });
}

const ReplayLine = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({
      index: Schema.Int,
      result: Schema.Literal('match'),
      path: Schema.String,
      dependency: Schema.optionalKey(Schema.String),
      outcome: Schema.String,
      reasons: Schema.Array(Schema.Struct({ code: Schema.String })),
    }),
    Schema.Struct({
      index: Schema.Int,
      result: Schema.Literals(['mismatch', 'failed']),
      error: Schema.String,
    }),
  ]),
);
const decodeReplayLine = Schema.decodeUnknownSync(ReplayLine);

export function replayLines(stdout: string) {
  return stdout
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => decodeReplayLine(line));
}

export function summarizeMatch(
  line: ReturnType<typeof replayLines>[number],
): NodeSummary {
  if (line.result !== 'match') {
    throw new Error(`entry ${line.index} did not match: ${line.error}`);
  }

  return {
    path: line.path,
    ...(line.dependency === undefined ? {} : { dependency: line.dependency }),
    outcome: line.outcome,
    reasons: line.reasons.map((reason) => reason.code).toSorted(),
  };
}

export function expectedNodes(
  evaluation: VerifyCase['evaluations'][number],
): NodeSummary[] {
  return evaluation.nodes.map((node) => ({
    ...node,
    reasons: node.reasons.toSorted(),
  }));
}

export function verifyArgs(
  dir: URL,
  fixture: VerifyCase,
  evaluation: VerifyCase['evaluations'][number],
): string[] {
  return [
    'verify',
    '--lockfile',
    fileURLToPath(new URL(fixture.lockfile, dir)),
    '--evidence',
    fileURLToPath(evidenceDir),
    '--at',
    evaluation.at.toISOString(),
  ];
}

export function recordedEvidence(path: string, dir = evidenceDir): unknown {
  return JSON.parse(readFileSync(new URL(path, dir), 'utf8'));
}

export const viteVersions = [
  '8.1.2',
  '8.1.3',
  '8.1.4',
  '8.1.5',
  '8.2.0-beta.0',
  '8.2.0',
  '8.2.1',
  '8.2.2',
  '8.3.0-beta.0',
  '8.3.0-beta.1',
  '8.3.0',
];

export function recordedViteAttestations(): ReadonlyMap<string, unknown> {
  return new Map(
    viteVersions.map((version) => [
      version,
      recordedEvidence(`attestations/vite@${version}.json`),
    ]),
  );
}
