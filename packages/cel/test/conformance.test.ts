import { test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { toJson } from '@bufbuild/protobuf';
import {
  anyUnpack,
  BoolValueSchema,
  BytesValueSchema,
  DoubleValueSchema,
  DurationSchema,
  FloatValueSchema,
  Int32ValueSchema,
  Int64ValueSchema,
  ListValueSchema,
  StringValueSchema,
  StructSchema,
  TimestampSchema,
  UInt32ValueSchema,
  UInt64ValueSchema,
  ValueSchema as ProtoValueSchema,
} from '@bufbuild/protobuf/wkt';
import type { Any } from '@bufbuild/protobuf/wkt';
import { getConformanceSuite } from '@bufbuild/cel-spec/testdata/tests.js';
import type {
  IncrementalTest,
  IncrementalTestSuite,
} from '@bufbuild/cel-spec/testdata/tests.js';
import type { Value } from '@bufbuild/cel-spec/cel/expr/value_pb.js';
import type { Type, Decl } from '@bufbuild/cel-spec/cel/expr/checked_pb.js';
import {
  Type_PrimitiveType,
  Type_WellKnownType,
} from '@bufbuild/cel-spec/cel/expr/checked_pb.js';
import { Environment } from '../src/index';
import { UnsignedInt, Duration } from '../src/functions';

type Outcome =
  | { kind: 'pass' }
  | { kind: 'fail'; reason: string }
  | { kind: 'unsupported'; reason: string };

class Unsupported extends Error {}

function unpackAny(any: Any): unknown {
  const duration = anyUnpack(any, DurationSchema);
  if (duration !== undefined) {
    return new Duration(Number(duration.seconds), duration.nanos);
  }

  const timestamp = anyUnpack(any, TimestampSchema);
  if (timestamp !== undefined) {
    return new Date(
      Number(timestamp.seconds) * 1000 + Math.floor(timestamp.nanos / 1e6),
    );
  }

  for (const schema of [Int64ValueSchema, Int32ValueSchema]) {
    const wrapped = anyUnpack(any, schema);
    if (wrapped !== undefined) {
      return BigInt(wrapped.value);
    }
  }

  for (const schema of [UInt64ValueSchema, UInt32ValueSchema]) {
    const wrapped = anyUnpack(any, schema);
    if (wrapped !== undefined) {
      return new UnsignedInt(BigInt(wrapped.value));
    }
  }

  for (const schema of [
    DoubleValueSchema,
    FloatValueSchema,
    StringValueSchema,
    BoolValueSchema,
    BytesValueSchema,
  ]) {
    const wrapped = anyUnpack(any, schema);
    if (wrapped !== undefined) {
      return wrapped.value;
    }
  }

  const struct = anyUnpack(any, StructSchema);
  if (struct !== undefined) {
    return jsonToCel(toJson(StructSchema, struct));
  }

  const list = anyUnpack(any, ListValueSchema);
  if (list !== undefined) {
    return jsonToCel(toJson(ListValueSchema, list));
  }

  const value = anyUnpack(any, ProtoValueSchema);
  if (value !== undefined) {
    return jsonToCel(toJson(ProtoValueSchema, value));
  }

  throw new Unsupported(`protobuf message ${any.typeUrl}`);
}

function jsonToCel(json: unknown): unknown {
  if (typeof json === 'number') {
    return json;
  }

  if (Array.isArray(json)) {
    return json.map(jsonToCel);
  }

  if (json !== null && typeof json === 'object') {
    return Object.fromEntries(
      Object.entries(json).map(([k, v]) => [k, jsonToCel(v)]),
    );
  }

  return json;
}

function toCel(value: Value): unknown {
  const kind = value.kind;
  switch (kind.case) {
    case 'nullValue':
      return null;
    case 'boolValue':
    case 'stringValue':
    case 'doubleValue':
    case 'bytesValue':
      return kind.value;
    case 'int64Value':
      return kind.value;
    case 'uint64Value':
      return new UnsignedInt(kind.value);
    case 'listValue':
      return kind.value.values.map(toCel);
    case 'mapValue': {
      const entries = kind.value.entries.map((e) => {
        if (e.key === undefined || e.value === undefined) {
          throw new Unsupported('map entry without key or value');
        }

        return [toCel(e.key), toCel(e.value)] as const;
      });

      return entries.every(([k]) => typeof k === 'string')
        ? Object.fromEntries(entries)
        : new Map(entries);
    }
    case 'objectValue':
      return unpackAny(kind.value);
    case 'typeValue':
      return { celType: kind.value };
    case 'enumValue':
      throw new Unsupported('enum value');
    case undefined:
      throw new Unsupported('empty value');
  }
}

function primitiveName(primitive: Type_PrimitiveType): string {
  switch (primitive) {
    case Type_PrimitiveType.BOOL:
      return 'bool';
    case Type_PrimitiveType.INT64:
      return 'int';
    case Type_PrimitiveType.UINT64:
      return 'uint';
    case Type_PrimitiveType.DOUBLE:
      return 'double';
    case Type_PrimitiveType.STRING:
      return 'string';
    case Type_PrimitiveType.BYTES:
      return 'bytes';
    case Type_PrimitiveType.PRIMITIVE_TYPE_UNSPECIFIED:
      throw new Unsupported('unspecified primitive');
  }
}

function wellKnownName(wellKnown: Type_WellKnownType): string {
  switch (wellKnown) {
    case Type_WellKnownType.TIMESTAMP:
      return 'timestamp';
    case Type_WellKnownType.DURATION:
      return 'duration';
    case Type_WellKnownType.ANY:
      return 'dyn';
    case Type_WellKnownType.WELL_KNOWN_TYPE_UNSPECIFIED:
      throw new Unsupported('unspecified well-known type');
  }
}

function typeName(type: Type): string {
  const kind = type.typeKind;
  switch (kind.case) {
    case 'dyn':
      return 'dyn';
    case 'null':
      return 'null_type';
    case 'primitive':
      return primitiveName(kind.value);
    case 'wellKnown':
      return wellKnownName(kind.value);
    case 'listType':
      return kind.value.elemType === undefined
        ? 'list'
        : `list<${typeName(kind.value.elemType)}>`;
    case 'mapType':
      return kind.value.keyType === undefined ||
        kind.value.valueType === undefined
        ? 'map'
        : `map<${typeName(kind.value.keyType)}, ${typeName(kind.value.valueType)}>`;
    case 'abstractType': {
      if (kind.value.name !== 'optional_type') {
        throw new Unsupported(`abstract type ${kind.value.name}`);
      }

      const [inner] = kind.value.parameterTypes;

      return inner === undefined ? 'optional' : `optional<${typeName(inner)}>`;
    }
    case 'function':
    case 'wrapper':
    case 'messageType':
    case 'typeParam':
    case 'type':
    case 'error':
    case undefined:
      throw new Unsupported(`type ${kind.case ?? 'unset'}`);
  }
}

function register(env: Environment, decls: readonly Decl[]): Environment {
  for (const decl of decls) {
    if (decl.declKind.case !== 'ident') {
      throw new Unsupported('function declaration in type env');
    }

    const type = decl.declKind.value.type;
    env.registerVariable(
      decl.name,
      type === undefined ? 'dyn' : typeName(type),
    );
  }

  return env;
}

function entriesOf(value: unknown): [unknown, unknown][] | undefined {
  if (value instanceof Map) {
    return [...value];
  }

  if (value !== null && typeof value === 'object') {
    return Object.entries(value);
  }

  return undefined;
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message.split('\n')[0] ?? '';
  }

  return typeof err === 'string' ? err : 'non-Error value';
}

function celEquals(actual: unknown, expected: unknown): boolean {
  if (typeof expected === 'number' && typeof actual === 'number') {
    return Number.isNaN(expected)
      ? Number.isNaN(actual)
      : Object.is(actual + 0, expected + 0);
  }

  if (expected instanceof UnsignedInt) {
    return actual instanceof UnsignedInt && String(actual) === String(expected);
  }

  if (expected instanceof Duration) {
    return actual instanceof Duration && String(actual) === String(expected);
  }

  if (expected instanceof Date) {
    return actual instanceof Date && actual.getTime() === expected.getTime();
  }

  if (expected instanceof Uint8Array) {
    return (
      actual instanceof Uint8Array &&
      actual.length === expected.length &&
      actual.every((b, i) => b === expected[i])
    );
  }

  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((e, i) => celEquals(actual[i], e))
    );
  }

  if (
    expected !== null &&
    typeof expected === 'object' &&
    'celType' in expected
  ) {
    return String(actual) === `Type<${String(expected.celType)}>`;
  }

  if (
    expected instanceof Map ||
    (expected !== null && typeof expected === 'object')
  ) {
    const exp =
      expected instanceof Map ? [...expected] : Object.entries(expected);
    const act = entriesOf(actual);

    return (
      act !== undefined &&
      act.length === exp.length &&
      exp.every(([k, v]) =>
        act.some(([ak, av]) => celEquals(ak, k) && celEquals(av, v)),
      )
    );
  }

  return actual === expected;
}

function run(t: IncrementalTest): Outcome {
  const original = t.original;
  try {
    if (original.disableMacros) {
      throw new Unsupported('disableMacros');
    }

    const env = register(
      new Environment({
        unlistedVariablesAreDyn: true,
        homogeneousAggregateLiterals: false,
        enableOptionalTypes: true,
      }),
      original.typeEnv,
    );
    const bindings: Record<string, unknown> = {};
    for (const [name, exprValue] of Object.entries(original.bindings)) {
      if (exprValue.kind.case !== 'value') {
        throw new Unsupported(`binding kind ${exprValue.kind.case ?? 'unset'}`);
      }

      bindings[name] = toCel(exprValue.kind.value);
    }

    const matcher = original.resultMatcher;
    if (original.checkOnly) {
      const checked = env.check(original.expr);
      const expectsError =
        matcher.case === 'evalError' || matcher.case === 'anyEvalErrors';
      if (checked.valid === expectsError) {
        return {
          kind: 'fail',
          reason: checked.valid
            ? `expected a check error, got ${checked.type}`
            : `check failed: ${describeError(checked.error)}`,
        };
      }

      if (matcher.case === 'typedResult' && matcher.value.deducedType) {
        throw new Unsupported('comparing deduced types');
      }

      return { kind: 'pass' };
    }

    let actual: unknown;
    let thrown: unknown;
    try {
      actual = env.evaluate(original.expr, bindings);
    } catch (err) {
      thrown = err;
    }

    switch (matcher.case) {
      case 'evalError':
      case 'anyEvalErrors':
        return thrown === undefined
          ? { kind: 'fail', reason: `expected error, got ${String(actual)}` }
          : { kind: 'pass' };
      case 'unknown':
      case 'anyUnknowns':
        throw new Unsupported('unknown values');
      case 'typedResult':
      case 'value':
      case undefined: {
        if (thrown !== undefined) {
          return {
            kind: 'fail',
            reason: `threw ${describeError(thrown)}`,
          };
        }

        const expectedValue =
          matcher.case === 'typedResult' ? matcher.value.result : matcher.value;
        const expected =
          expectedValue === undefined ? true : toCel(expectedValue);

        return celEquals(actual, expected)
          ? { kind: 'pass' }
          : { kind: 'fail', reason: `got ${String(actual)}` };
      }
    }
  } catch (err) {
    if (err instanceof Unsupported) {
      return { kind: 'unsupported', reason: err.message };
    }

    return {
      kind: 'fail',
      reason: `harness: ${describeError(err)}`,
    };
  }
}

type Row = { path: string; outcome: Outcome };

function walk(
  suite: IncrementalTestSuite,
  prefix: string[],
  rows: Row[],
): void {
  const path = [...prefix, suite.name];
  const seen = new Map<string, number>();
  for (const t of suite.tests) {
    const count = (seen.get(t.name) ?? 0) + 1;
    seen.set(t.name, count);
    const name = count === 1 ? t.name : `${t.name}#${count}`;
    rows.push({ path: [...path, name].join('/'), outcome: run(t) });
  }

  for (const s of suite.suites) {
    walk(s, path, rows);
  }
}

const knownFailuresUrl = new URL(
  './conformance-known-failures.json',
  import.meta.url,
);

type FailureKind = Exclude<Outcome['kind'], 'pass'>;

function readKnownFailures(): Record<string, FailureKind> {
  const parsed: unknown = JSON.parse(readFileSync(knownFailuresUrl, 'utf8'));
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error('known conformance failures must be an object');
  }

  const known: Record<string, FailureKind> = {};
  const entries: [string, unknown][] = Object.entries(parsed);
  for (const [path, kind] of entries) {
    if (kind !== 'fail' && kind !== 'unsupported') {
      throw new Error(`invalid known failure kind for ${path}`);
    }

    known[path] = kind;
  }

  return known;
}

test('cel-spec conformance fails only on known cases', () => {
  const rows: Row[] = [];
  for (const file of getConformanceSuite().suites) {
    walk(file, [], rows);
  }

  const recorded = readKnownFailures();
  const outcomes = new Map(rows.map((r) => [r.path, r.outcome]));
  const failing = (path: string) => {
    const outcome = outcomes.get(path);

    return outcome !== undefined && outcome.kind !== 'pass';
  };

  const update = process.env['CEL_CONFORMANCE_UPDATE'] === '1';
  const known = update
    ? Object.fromEntries(
        Object.entries(recorded).flatMap(([path]) => {
          const outcome = outcomes.get(path);

          return outcome === undefined || outcome.kind === 'pass'
            ? []
            : [[path, outcome.kind]];
        }),
      )
    : recorded;
  if (update) {
    writeFileSync(knownFailuresUrl, `${JSON.stringify(known, null, 2)}\n`);
  }

  const report = process.env['CEL_CONFORMANCE_REPORT'];
  if (report !== undefined) {
    writeFileSync(report, JSON.stringify(rows, null, 2));
  }

  const stale = Object.keys(known).filter((path) => !outcomes.has(path));
  const regressions = rows.flatMap((r) =>
    r.outcome.kind === 'pass' || r.path in known
      ? []
      : [`${r.path}: ${r.outcome.reason}`],
  );
  const improvements = Object.keys(known).filter(
    (path) => outcomes.has(path) && !failing(path),
  );
  const changedKind = Object.entries(known).flatMap(([path, kind]) => {
    const outcome = outcomes.get(path);

    return outcome !== undefined &&
      outcome.kind !== 'pass' &&
      outcome.kind !== kind
      ? [`${path}: recorded ${kind}, now ${outcome.kind}`]
      : [];
  });

  assert.deepEqual(stale, [], 'known failures name cases that no longer exist');
  assert.deepEqual(
    regressions,
    [],
    'conformance cases fail outside the known list',
  );
  assert.deepEqual(changedKind, [], 'known failures changed kind');
  if (improvements.length > 0) {
    assert.fail(
      `${improvements.length} known failures now pass. Rerun with CEL_CONFORMANCE_UPDATE=1 to remove them:\n${improvements.join('\n')}`,
    );
  }
});
