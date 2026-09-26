import { describe, test } from 'bun:test';
import { TestEnvironment } from './helpers';

describe('Dynamic Function Resolution', () => {
  describe('single argument dyn', () => {
    test('dyn accepts all types', () => {
      const { expectEval } = new TestEnvironment().registerFunction(
        'process(dyn): string',
        (x: unknown) => `dyn: ${String(x)}`,
      );

      expectEval('process(42)', 'dyn: 42');
      expectEval('process("hello")', 'dyn: hello');
      expectEval('process(true)', 'dyn: true');
      expectEval('process([1, 2])', 'dyn: 1,2');
      expectEval('process({"x": 1})', 'dyn: [object Object]');
    });

    test('specific type only matches exact type', () => {
      const { expectEval, expectEvalThrows } =
        new TestEnvironment().registerFunction(
          'process(string): string',
          (x: string) => `string: ${x}`,
        );

      expectEval('process("hello")', 'string: hello');
      expectEvalThrows(
        'process(42)',
        /no matching overload for 'process\(int\)/,
      );
      expectEvalThrows(
        'process(true)',
        /no matching overload for 'process\(bool\)/,
      );
    });
  });

  describe('two argument dyn', () => {
    test('dyn,dyn accepts all type combinations', () => {
      const { expectEval } = new TestEnvironment().registerFunction(
        'pair(dyn, dyn): string',
        (a: unknown, b: unknown) => `${String(a)},${String(b)}`,
      );

      expectEval('pair(1, 2)', '1,2');
      expectEval('pair("a", "b")', 'a,b');
      expectEval('pair(1, "x")', '1,x');
      expectEval('pair("x", 1)', 'x,1');
      expectEval('pair(true, false)', 'true,false');
    });

    test('specific,dyn constrains first argument', () => {
      const { expectEval, expectEvalThrows } =
        new TestEnvironment().registerFunction(
          'pair(string, dyn): string',
          (a: string, b: unknown) => `string-dyn: ${a},${String(b)}`,
        );

      expectEval('pair("hello", 42)', 'string-dyn: hello,42');
      expectEval('pair("hello", "world")', 'string-dyn: hello,world');
      expectEval('pair("hello", true)', 'string-dyn: hello,true');

      expectEvalThrows('pair(42, "hello")', /no matching overload/);
      expectEvalThrows('pair(true, "hello")', /no matching overload/);
    });

    test('dyn,specific constrains second argument', () => {
      const { expectEval, expectEvalThrows } =
        new TestEnvironment().registerFunction(
          'pair(dyn, string): string',
          (a: unknown, b: string) => `dyn-string: ${String(a)},${b}`,
        );

      expectEval('pair(42, "hello")', 'dyn-string: 42,hello');
      expectEval('pair("world", "hello")', 'dyn-string: world,hello');
      expectEval('pair(true, "hello")', 'dyn-string: true,hello');

      expectEvalThrows('pair("hello", 42)', /no matching overload/);
      expectEvalThrows('pair("hello", true)', /no matching overload/);
    });

    test('specific,specific constrains both arguments', () => {
      const { expectEval, expectEvalThrows } =
        new TestEnvironment().registerFunction(
          'pair(string, int): string',
          (a: string, b: bigint) => `string-int: ${a},${b}`,
        );

      expectEval('pair("hello", 42)', 'string-int: hello,42');

      expectEvalThrows('pair("hello", "world")', /no matching overload/);
      expectEvalThrows('pair(42, 42)', /no matching overload/);
      expectEvalThrows('pair(42, "hello")', /no matching overload/);
    });
  });

  describe('three+ argument dyn', () => {
    test('dyn,dyn,dyn accepts all type combinations', () => {
      const { expectEval } = new TestEnvironment().registerFunction(
        'triple(dyn, dyn, dyn): string',
        (a: unknown, b: unknown, c: unknown) =>
          `${String(a)},${String(b)},${String(c)}`,
      );

      expectEval('triple(1, 2, 3)', '1,2,3');
      expectEval('triple("a", "b", "c")', 'a,b,c');
      expectEval('triple(1, "x", true)', '1,x,true');
      expectEval('triple("x", 1, "y")', 'x,1,y');
    });

    test('mixed specific and dyn types', () => {
      const { expectEval, expectEvalThrows } =
        new TestEnvironment().registerFunction(
          'triple(string, dyn, int): string',
          (a: string, b: unknown, c: bigint) => `${a},${String(b)},${c}`,
        );

      expectEval('triple("hello", "world", 42)', 'hello,world,42');
      expectEval('triple("hello", 42, 10)', 'hello,42,10');
      expectEval('triple("hello", true, 10)', 'hello,true,10');

      expectEvalThrows('triple(42, "world", 10)', /no matching overload/);
      expectEvalThrows(
        'triple("hello", "world", "bad")',
        /no matching overload/,
      );
    });

    test('four arguments (stress test)', () => {
      const { expectEval } = new TestEnvironment().registerFunction(
        'quad(dyn, dyn, dyn, dyn): string',
        (a: unknown, b: unknown, c: unknown, d: unknown) =>
          `${String(a)},${String(b)},${String(c)},${String(d)}`,
      );

      expectEval('quad(1, 2, 3, 4)', '1,2,3,4');
      expectEval('quad("a", 1, true, "b")', 'a,1,true,b');
    });
  });

  describe('receiver methods', () => {
    test('receiver.method(dyn) works', () => {
      const { expectEval } = new TestEnvironment().registerFunction(
        'string.process(dyn): string',
        (receiver: string, arg: unknown) => `${receiver}:${String(arg)}`,
      );

      expectEval('"hello".process(42)', 'hello:42');
      expectEval('"hello".process("world")', 'hello:world');
      expectEval('"hello".process(true)', 'hello:true');
    });

    test('receiver.method(specific) constrains argument', () => {
      const { expectEval, expectEvalThrows } =
        new TestEnvironment().registerFunction(
          'string.append(string): string',
          (receiver: string, arg: string) => `${receiver}${arg}`,
        );

      expectEval('"hello".append("world")', 'helloworld');
      expectEvalThrows('"hello".append(42)', /no matching overload/);
    });

    test('receiver.method(dyn, dyn) accepts multiple args', () => {
      const { expectEval } = new TestEnvironment().registerFunction(
        'string.join(dyn, dyn): string',
        (receiver: string, a: unknown, b: unknown) => {
          return `${String(a)}${receiver}${String(b)}`;
        },
      );

      expectEval('"--".join("a", "b")', 'a--b');
      expectEval('"--".join(1, 2)', '1--2');
    });
  });

  describe('zero arguments', () => {
    test('zero argument functions work', () => {
      const { expectEval } = new TestEnvironment().registerFunction(
        'getValue(): int',
        () => 42n,
      );
      expectEval('getValue()', 42n);
    });

    test('zero argument receiver methods work', () => {
      const { expectEval } = new TestEnvironment().registerFunction(
        'string.length(): int',
        (receiver: string) => BigInt(receiver.length),
      );

      expectEval('"hello".length()', 5n);
    });
  });

  describe('error handling', () => {
    test('no matching overload for specific type', () => {
      const { expectEvalThrows } = new TestEnvironment().registerFunction(
        'process(string): string',
        (x: string) => x,
      );

      expectEvalThrows(
        'process(42)',
        /found no matching overload for 'process\(int\)'/,
      );
    });

    test('no matching overload for wrong arg count', () => {
      const { expectEvalThrows } = new TestEnvironment().registerFunction(
        'pair(dyn, dyn): string',
        (a: unknown, b: unknown) => `${String(a)},${String(b)}`,
      );

      expectEvalThrows('pair(1)', /no matching overload/);
      expectEvalThrows('pair(1, 2, 3)', /no matching overload/);
    });

    test('no matching overload for receiver type', () => {
      const { expectEvalThrows } = new TestEnvironment().registerFunction(
        'string.process(dyn): string',
        (receiver: string, arg: unknown) => `${receiver}:${String(arg)}`,
      );

      expectEvalThrows(
        '42.process("hello")',
        /no matching overload for 'int.process/,
      );
    });
  });

  describe('with variables', () => {
    test('dyn works with typed variables', () => {
      const { expectEval } = new TestEnvironment()
        .registerVariable('x', 'int')
        .registerVariable('y', 'string')
        .registerFunction(
          'pair(dyn, dyn): string',
          (a: unknown, b: unknown) => `${String(a)},${String(b)}`,
        );

      expectEval('pair(x, y)', '42,hello', { x: 42n, y: 'hello' });
    });

    test('specific type matches variable type', () => {
      const { expectEval } = new TestEnvironment()
        .registerVariable('x', 'string')
        .registerFunction(
          'process(string): string',
          (x: string) => `processed: ${x}`,
        );

      expectEval('process(x)', 'processed: hello', { x: 'hello' });
    });
  });

  describe('complex types', () => {
    test('list and map types with dyn', () => {
      const { expectEval } = new TestEnvironment().registerFunction(
        'process(dyn): string',
        (x: unknown) => {
          if (Array.isArray(x)) {
            return 'got-list';
          }

          if (typeof x === 'object') {
            return 'got-map';
          }

          return 'got-other';
        },
      );

      expectEval('process([1, 2, 3])', 'got-list');
      expectEval('process({"key": "value"})', 'got-map');
      expectEval('process(42)', 'got-other');
    });

    test('specific list type', () => {
      const { expectEval, expectEvalThrows } =
        new TestEnvironment().registerFunction(
          'processList(list): int',
          (x: unknown[]) => BigInt(x.length),
        );

      expectEval('processList([1, 2, 3])', 3n);
      expectEvalThrows('processList(42)', /no matching overload/);
    });

    test('specific map type', () => {
      const { expectEval, expectEvalThrows } =
        new TestEnvironment().registerFunction(
          'processMap(map): int',
          (x: object) => BigInt(Object.keys(x).length),
        );

      expectEval('processMap({"a": 1, "b": 2})', 2n);
      expectEvalThrows('processMap(42)', /no matching overload/);
    });
  });
});
