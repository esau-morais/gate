import { UnsignedInt, Duration } from './functions';
import { evaluationError } from './errors';
import type { ErrorNode } from './errors';
import {
  expectDefined,
  getProp,
  hasOwn,
  hasProp,
  isArray,
  objKeys,
  truthy,
  MIN_UINT,
  MIN_INT,
  MAX_INT,
} from './globals';
import type { OperatorHandler, Registry } from './registry';
import type { Evaluator } from './evaluator';

type ListValue = unknown[] | Set<unknown>;
type MapValue = Map<unknown, unknown> | Record<string, unknown>;
type Ordered =
  boolean | bigint | number | string | Date | Duration | UnsignedInt;
type Numeric = bigint | number | UnsignedInt;

/**
 * CEL compares an int or uint with a double after converting the integer to
 * double, as cel-go does. The conformance suite expects this lossy behavior,
 * for example `dyn(9223372036854775807) >= 9223372036854775808.0`.
 */
function toDouble(v: bigint | number | UnsignedInt): number {
  return Number(v);
}

export function registerOverloads(registry: Registry): void {
  const unaryOverload = (
    op: string,
    t: string,
    h: OperatorHandler,
    ret?: string,
  ): void => registry.unaryOverload(op, t, h, ret, false);
  const binaryOverload = (
    l: string,
    op: string,
    r: string,
    h: OperatorHandler,
    ret?: string,
  ): void => registry.binaryOverload(l, op, r, h, ret, false);

  function verifyInteger(v: bigint, ast: ErrorNode): bigint {
    if (v <= MAX_INT && v >= MIN_INT) {
      return v;
    }

    throw evaluationError('numeric_overflow', `integer overflow: ${v}`, ast);
  }

  function throwDivisionByZero(ast: ErrorNode): never {
    throw evaluationError('division_by_zero', 'division by zero', ast);
  }

  function throwModuloByZero(ast: ErrorNode): never {
    throw evaluationError('modulo_by_zero', 'modulo by zero', ast);
  }

  unaryOverload('!', 'bool', (a: boolean) => !a);
  unaryOverload('-', 'int', (a: bigint, ast: ErrorNode) =>
    verifyInteger(-a, ast),
  );
  binaryOverload(
    'dyn<int>',
    `==`,
    `double`,
    (a: bigint, b: number) => toDouble(a) === b,
  );
  binaryOverload(
    'dyn<int>',
    `==`,
    `uint`,
    (a: bigint, b: UnsignedInt) => a === b.valueOf(),
  );
  binaryOverload('int', '*', 'int', (a: bigint, b: bigint, ast: ErrorNode) =>
    verifyInteger(a * b, ast),
  );
  binaryOverload('int', '+', 'int', (a: bigint, b: bigint, ast: ErrorNode) =>
    verifyInteger(a + b, ast),
  );
  binaryOverload('int', '-', 'int', (a: bigint, b: bigint, ast: ErrorNode) =>
    verifyInteger(a - b, ast),
  );
  binaryOverload('int', '/', 'int', (a: bigint, b: bigint, ast: ErrorNode) => {
    if (b === MIN_UINT) {
      return throwDivisionByZero(ast);
    }

    return verifyInteger(a / b, ast);
  });
  binaryOverload('int', '%', 'int', (a: bigint, b: bigint, ast: ErrorNode) => {
    if (b === MIN_UINT) {
      return throwModuloByZero(ast);
    }

    return a % b;
  });

  unaryOverload('-', 'double', (a: number) => -a);
  binaryOverload('double', '*', 'double', (a: number, b: number) => a * b);
  binaryOverload('double', '+', 'double', (a: number, b: number) => a + b);
  binaryOverload('double', '-', 'double', (a: number, b: number) => a - b);
  binaryOverload('double', '/', 'double', (a: number, b: number) => a / b);

  binaryOverload('string', '+', 'string', (a: string, b: string) => a + b);
  binaryOverload('list<V>', '+', 'list<V>', (a: ListValue, b: ListValue) => [
    ...a,
    ...b,
  ]);
  binaryOverload('bytes', '+', 'bytes', (a: Uint8Array, b: Uint8Array) => {
    if (a.length === 0) {
      return b;
    }

    if (b.length === 0) {
      return a;
    }

    const result = new Uint8Array(a.length + b.length);
    result.set(a, 0);
    result.set(b, a.length);

    return result;
  });

  const GPD = 'google.protobuf.Duration';
  binaryOverload(GPD, '+', GPD, (a: Duration, b: Duration) => a.addDuration(b));
  binaryOverload(GPD, '-', GPD, (a: Duration, b: Duration) =>
    a.subtractDuration(b),
  );
  binaryOverload(
    GPD,
    '==',
    GPD,
    (a: Duration, b: Duration) =>
      a.seconds === b.seconds && a.nanos === b.nanos,
  );

  const GPT = 'google.protobuf.Timestamp';
  binaryOverload(
    GPT,
    '==',
    GPT,
    (a: Date, b: Date) => a.getTime() === b.getTime(),
  );
  binaryOverload(
    GPT,
    '-',
    GPT,
    (a: Date, b: Date) => Duration.fromMilliseconds(a.getTime() - b.getTime()),
    GPD,
  );
  binaryOverload(GPT, '-', GPD, (a: Date, b: Duration) =>
    b.subtractTimestamp(a),
  );
  binaryOverload(GPT, '+', GPD, (a: Date, b: Duration) => b.extendTimestamp(a));
  binaryOverload(GPD, '+', GPT, (a: Duration, b: Date) => a.extendTimestamp(b));

  function listIncludes(
    value: unknown,
    list: ListValue,
    ast: ErrorNode,
    ev: Evaluator,
  ): boolean {
    if (list instanceof Set && list.has(value)) {
      return true;
    }

    for (const v of list) {
      if (truthy(isEqual(value, v, ast, ev))) {
        return true;
      }
    }

    return false;
  }

  function mapIncludes(a: unknown, b: MapValue): boolean {
    if (b instanceof Map) {
      return b.get(a) !== undefined;
    }

    return hasOwn(b, a) ? getProp(b, a) !== undefined : false;
  }

  function listMembership(
    value: unknown,
    list: ListValue,
    ast: ErrorNode,
    ev: Evaluator,
  ): boolean {
    return listIncludes(value, list, ast, ev);
  }

  binaryOverload('V', 'in', 'list<V>', listMembership);
  binaryOverload('K', 'in', 'map<K, V>', mapIncludes);

  for (const t of ['type', 'null', 'bool', 'string', 'int', 'double']) {
    binaryOverload(t, '==', t, (a: unknown, b: unknown) => a === b);
  }

  binaryOverload('bytes', `==`, 'bytes', (a: Uint8Array, b: Uint8Array) => {
    if (a === b) {
      return true;
    }

    let i = a.length;
    if (i !== b.length) {
      return false;
    }

    while (i-- !== 0) {
      if (a[i] !== b[i]) {
        return false;
      }
    }

    return true;
  });

  binaryOverload(
    'list<V>',
    `==`,
    'list<V>',
    (a: ListValue, b: ListValue, ast: ErrorNode, ev: Evaluator) => {
      if (a === b) {
        return true;
      }

      if (isArray(a) && isArray(b)) {
        const length = a.length;
        if (length !== b.length) {
          return false;
        }

        for (let i = 0; i < length; i++) {
          if (!truthy(isEqual(a[i], b[i], ast, ev))) {
            return false;
          }
        }

        return true;
      }

      if (a instanceof Set && b instanceof Set) {
        if (a.size !== b.size) {
          return false;
        }

        for (const value of a) {
          if (!b.has(value)) {
            return false;
          }
        }

        return true;
      }

      const arr = a instanceof Set ? b : a;
      const set = a instanceof Set ? a : b;
      if (!isArray(arr)) {
        return false;
      }

      if (!(set instanceof Set) || arr.length !== set.size) {
        return false;
      }

      for (let i = 0; i < arr.length; i++) {
        if (!set.has(arr[i])) {
          return false;
        }
      }

      return true;
    },
  );

  function mixedMapEquals(
    map: Map<unknown, unknown>,
    obj: MapValue,
    ast: ErrorNode,
    ev: Evaluator,
  ): boolean {
    const keysObj = objKeys(obj);
    if (map.size !== keysObj.length) {
      return false;
    }

    for (const [key, value] of map) {
      if (!(
        hasProp(obj, key) && truthy(isEqual(value, getProp(obj, key), ast, ev))
      )) {
        return false;
      }
    }

    return true;
  }

  binaryOverload(
    'map<K, V>',
    `==`,
    'map<K, V>',
    (a: MapValue, b: MapValue, ast: ErrorNode, ev: Evaluator) => {
      if (a === b) {
        return true;
      }

      if (a instanceof Map && b instanceof Map) {
        if (a.size !== b.size) {
          return false;
        }

        for (const [key, value] of a) {
          if (!(b.has(key) && truthy(isEqual(value, b.get(key), ast, ev)))) {
            return false;
          }
        }

        return true;
      }

      if (a instanceof Map) {
        return mixedMapEquals(a, b, ast, ev);
      }

      if (b instanceof Map) {
        return mixedMapEquals(b, a, ast, ev);
      }

      const keysA = objKeys(a);
      const keysB = objKeys(b);
      if (keysA.length !== keysB.length) {
        return false;
      }

      for (let i = 0; i < keysA.length; i++) {
        const key = expectDefined(keysA[i], 'map key');
        if (!(key in b && truthy(isEqual(a[key], b[key], ast, ev)))) {
          return false;
        }
      }

      return true;
    },
  );

  binaryOverload(
    'uint',
    '==',
    'uint',
    (a: UnsignedInt, b: UnsignedInt) => a.valueOf() === b.valueOf(),
  );
  binaryOverload(
    'dyn<uint>',
    `==`,
    `double`,
    (a: UnsignedInt, b: number) => toDouble(a) === b,
  );

  binaryOverload(
    'uint',
    '+',
    'uint',
    (a: UnsignedInt, b: UnsignedInt) =>
      new UnsignedInt(a.valueOf() + b.valueOf()),
  );
  binaryOverload(
    'uint',
    '-',
    'uint',
    (a: UnsignedInt, b: UnsignedInt) =>
      new UnsignedInt(a.valueOf() - b.valueOf()),
  );
  binaryOverload(
    'uint',
    '*',
    'uint',
    (a: UnsignedInt, b: UnsignedInt) =>
      new UnsignedInt(a.valueOf() * b.valueOf()),
  );
  binaryOverload(
    'uint',
    '/',
    'uint',
    (a: UnsignedInt, b: UnsignedInt, ast: ErrorNode) => {
      if (b.valueOf() === MIN_UINT) {
        return throwDivisionByZero(ast);
      }

      return new UnsignedInt(a.valueOf() / b.valueOf());
    },
  );
  binaryOverload(
    'uint',
    '%',
    'uint',
    (a: UnsignedInt, b: UnsignedInt, ast: ErrorNode) => {
      if (b.valueOf() === MIN_UINT) {
        return throwModuloByZero(ast);
      }

      return new UnsignedInt(a.valueOf() % b.valueOf());
    },
  );

  for (const [left, right] of [
    ['bool', 'bool'],
    ['int', 'int'],
    ['uint', 'uint'],
    ['double', 'double'],
    ['string', 'string'],
    ['google.protobuf.Timestamp', 'google.protobuf.Timestamp'],
    ['google.protobuf.Duration', 'google.protobuf.Duration'],
    ['int', 'uint'],
    ['uint', 'int'],
  ] as const) {
    binaryOverload(left, '<', right, (a: Ordered, b: Ordered) => a < b);
    binaryOverload(left, '<=', right, (a: Ordered, b: Ordered) => a <= b);
    binaryOverload(left, '>', right, (a: Ordered, b: Ordered) => a > b);
    binaryOverload(left, '>=', right, (a: Ordered, b: Ordered) => a >= b);
  }

  for (const [left, right] of [
    ['int', 'double'],
    ['double', 'int'],
    ['double', 'uint'],
    ['uint', 'double'],
  ] as const) {
    binaryOverload(
      left,
      '<',
      right,
      (a: Numeric, b: Numeric) => toDouble(a) < toDouble(b),
    );
    binaryOverload(
      left,
      '<=',
      right,
      (a: Numeric, b: Numeric) => toDouble(a) <= toDouble(b),
    );
    binaryOverload(
      left,
      '>',
      right,
      (a: Numeric, b: Numeric) => toDouble(a) > toDouble(b),
    );
    binaryOverload(
      left,
      '>=',
      right,
      (a: Numeric, b: Numeric) => toDouble(a) >= toDouble(b),
    );
  }
}

function isEqual(
  a: unknown,
  b: unknown,
  ast: ErrorNode,
  ev: Evaluator,
): unknown {
  if (a === b) {
    return true;
  }

  switch (typeof a) {
    case 'undefined':
    case 'string':
    case 'boolean':
      return false;
    case 'bigint':
      if (typeof b === 'number') {
        return toDouble(a) === b;
      }

      return b instanceof UnsignedInt && a === b.valueOf();
    case 'number':
      if (typeof b === 'bigint' || b instanceof UnsignedInt) {
        return a === toDouble(b);
      }

      return false;
    case 'object': {
      if (typeof b !== 'object') {
        if (!(a instanceof UnsignedInt)) {
          return false;
        }

        if (typeof b === 'number') {
          return toDouble(a) === b;
        }

        return a.valueOf() === b;
      }

      const leftType = ev.debugType(a);
      const rightType = ev.debugType(b);
      if (leftType !== rightType) {
        return false;
      }

      const overload = ev.registry.findBinaryOverload(
        '==',
        leftType,
        rightType,
      );
      if (overload === false) {
        return false;
      }

      return overload.handler(a, b, ast, ev);
    }
    case 'symbol':
    case 'function':
      break;
  }

  throw evaluationError(
    'invalid_comparison_type',
    `Cannot compare values of type ${typeof a}`,
    ast,
  );
}
