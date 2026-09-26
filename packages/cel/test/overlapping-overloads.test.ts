import { describe, test } from 'bun:test';
import assert from 'node:assert';
import { Environment } from '../src/index';
import type { Evaluator } from '../src/evaluator';
import type { AnyNode, MacroInput } from '../src/parser';
import type { EvalContext, TypeDeclaration } from '../src/registry';
import type { TypeChecker } from '../src/type-checker';

interface FirstArgumentMacro {
  firstArgument: AnyNode;
  typeCheck(
    checker: TypeChecker,
    macro: FirstArgumentMacro,
    ctx: EvalContext,
  ): TypeDeclaration;
  evaluate(
    evaluator: Evaluator,
    macro: FirstArgumentMacro,
    ctx: EvalContext,
  ): unknown;
}

describe('Overlapping function overloads', () => {
  describe('single argument overlaps', () => {
    test('rejects identical signatures', () => {
      const env = new Environment();
      env.registerFunction('foo(int): int', (x: bigint) => x);

      assert.throws(
        () => env.registerFunction('foo(int): int', (x: bigint) => x * 2n),
        /Function signature 'foo\(int\): int' overlaps with existing overload 'foo\(int\): int'/,
      );
    });

    test('rejects dyn after specific type', () => {
      const env = new Environment();
      env.registerFunction('process(string): string', (x: string) => x);

      assert.throws(
        () =>
          env.registerFunction('process(dyn): string', (x: unknown) =>
            String(x),
          ),
        /overlaps with existing overload/,
      );
    });

    test('rejects specific type after dyn', () => {
      const env = new Environment();
      env.registerFunction('process(dyn): string', (x: unknown) => String(x));

      assert.throws(
        () => env.registerFunction('process(string): string', (x: string) => x),
        /overlaps with existing overload/,
      );
    });

    test('rejects dyn after int', () => {
      const env = new Environment();
      env.registerFunction('process(int): string', (x: bigint) => String(x));

      assert.throws(
        () =>
          env.registerFunction('process(dyn): string', (x: unknown) =>
            String(x),
          ),
        /overlaps with existing overload/,
      );
    });

    test('allows different concrete types', () => {
      const env = new Environment();
      env.registerFunction('process(string): int', (x: string) => x.length);
      env.registerFunction('process(int): int', (x: bigint) => x);
      env.registerFunction('process(bool): int', (x: boolean) => (x ? 1 : 0));
    });
  });

  describe('multi-argument overlaps', () => {
    test('rejects (dyn, dyn) after (string, int)', () => {
      const env = new Environment();
      env.registerFunction(
        'pair(string, int): string',
        (a: string, b: bigint) => `${a}:${b}`,
      );

      assert.throws(
        () =>
          env.registerFunction(
            'pair(dyn, dyn): string',
            (a: unknown, b: unknown) => `${String(a)}-${String(b)}`,
          ),
        /overlaps with existing overload/,
      );
    });

    test('rejects (string, dyn) after (string, int)', () => {
      const env = new Environment();
      env.registerFunction(
        'pair(string, int): string',
        (a: string, b: bigint) => `${a}:${b}`,
      );

      assert.throws(
        () =>
          env.registerFunction(
            'pair(string, dyn): string',
            (a: string, b: unknown) => `${a}-${String(b)}`,
          ),
        /overlaps with existing overload/,
      );
    });

    test('rejects (dyn, int) after (string, int)', () => {
      const env = new Environment();
      env.registerFunction(
        'pair(string, int): string',
        (a: string, b: bigint) => `${a}:${b}`,
      );

      assert.throws(
        () =>
          env.registerFunction(
            'pair(dyn, int): string',
            (a: unknown, b: bigint) => `${String(a)}-${b}`,
          ),
        /overlaps with existing overload/,
      );
    });

    test('allows non-overlapping: (string, int) vs (int, string)', () => {
      const env = new Environment();
      env.registerFunction(
        'pair(string, int): string',
        (a: string, b: bigint) => `${a}:${b}`,
      );
      env.registerFunction(
        'pair(int, string): string',
        (a: bigint, b: string) => `${a}:${b}`,
      );
    });

    test('rejects three-arg: (dyn, dyn, dyn) after (string, int, bool)', () => {
      const env = new Environment();
      env.registerFunction(
        'triple(string, int, bool): string',
        (a: string, b: bigint, c: boolean) => `${a}-${b}-${c}`,
      );

      assert.throws(
        () =>
          env.registerFunction(
            'triple(dyn, dyn, dyn): string',
            (a: unknown, b: unknown, c: unknown) =>
              `${String(a)},${String(b)},${String(c)}`,
          ),
        /overlaps with existing overload/,
      );
    });
  });

  describe('different arities', () => {
    test('allows same name with different arg counts', () => {
      const env = new Environment();
      env.registerFunction('process(dyn): string', (x: unknown) => String(x));
      env.registerFunction(
        'process(dyn, dyn): string',
        (x: unknown, y: unknown) => `${String(x)},${String(y)}`,
      );
      env.registerFunction(
        'process(dyn, dyn, dyn): string',
        (x: unknown, y: unknown, z: unknown) =>
          `${String(x)},${String(y)},${String(z)}`,
      );
    });
  });

  describe('ast type (macros)', () => {
    test('ast overlaps with any specific type', () => {
      const env = new Environment();
      env.registerFunction(
        'macro(ast): dyn',
        ({ args: [firstArgument] }: MacroInput): FirstArgumentMacro => {
          assert(firstArgument);

          // This whole object that's returned will be available as
          // macro object in the typeCheck/evaluate functions
          return {
            firstArgument,
            // typeCheck and evaluate are required
            typeCheck(checker, macro, ctx) {
              return checker.check(macro.firstArgument, ctx);
            },
            evaluate(evaluator, macro, ctx) {
              return evaluator.run(macro.firstArgument, ctx);
            },
          };
        },
      );

      assert.throws(
        () => env.registerFunction('macro(dyn): dyn', (x: unknown) => x),
        /overlaps with existing overload/,
      );
      assert.throws(
        () => env.registerFunction('macro(int): int', (x: bigint) => x),
        /overlaps with existing overload/,
      );
      assert.throws(
        () => env.registerFunction('macro(string): string', (x: string) => x),
        /overlaps with existing overload/,
      );
    });

    test('ast overlaps in multi-arg positions', () => {
      const env = new Environment();
      env.registerFunction('macro(ast, int): int', () => ({
        evaluate() {
          return 1;
        },
        typeCheck(checker: TypeChecker) {
          return checker.getType('int');
        },
      }));

      assert.throws(
        () => env.registerFunction('macro(int, string): int', (x: bigint) => x),
        /overlaps with existing overload/,
      );
      assert.throws(
        () => env.registerFunction('macro(string, int): int', (x: string) => x),
        /overlaps with existing overload/,
      );
    });

    test('multiple ast arguments allowed', () => {
      const env = new Environment();
      env.registerFunction('macro(ast): dyn', ({ args }: MacroInput) => args);
      env.registerFunction(
        'macro(ast, ast): dyn',
        ({ args }: MacroInput) => args,
      );
    });
  });

  describe('receiver methods', () => {
    test('rejects dyn overlap on receiver methods', () => {
      const env = new Environment();
      env.registerFunction(
        'string.process(int): string',
        (receiver: string, n: bigint) => receiver + String(n),
      );

      assert.throws(
        () =>
          env.registerFunction(
            'string.process(dyn): string',
            (receiver: string, x: unknown) => receiver + String(x),
          ),
        /overlaps with existing overload/,
      );
    });

    test('allows different receivers with same method name', () => {
      const env = new Environment();
      env.registerFunction('string.len(): int', (receiver: string) =>
        BigInt(receiver.length),
      );
      env.registerFunction('list.len(): int', (receiver: unknown[]) =>
        BigInt(receiver.length),
      );
    });
  });

  describe('generic types (list, map)', () => {
    test('list<dyn> normalizes to list (no overlap with list<string>)', () => {
      const env = new Environment();
      env.registerFunction(
        'process(list<string>): int',
        (x: string[]) => x.length,
      );
      env.registerFunction(
        'process(list<dyn>): int',
        (x: unknown[]) => x.length,
      );
    });

    test('allows different list element types', () => {
      const env = new Environment();
      env.registerFunction('stringify(list<string>): string', (lst: string[]) =>
        lst.join(','),
      );
      env.registerFunction('stringify(list<int>): string', (lst: bigint[]) =>
        lst.map(String).join(','),
      );
    });

    test('map<dyn, V> normalizes to map', () => {
      const env = new Environment();
      env.registerFunction(
        'count(map<string, int>): int',
        (m: object) => Object.keys(m).length,
      );
      env.registerFunction(
        'count(map<dyn, int>): int',
        (m: object) => Object.keys(m).length,
      );
    });

    test('map<K, dyn> normalizes to map', () => {
      const env = new Environment();
      env.registerFunction(
        'count(map<string, string>): int',
        (m: object) => Object.keys(m).length,
      );
      env.registerFunction(
        'count(map<string, dyn>): int',
        (m: object) => Object.keys(m).length,
      );
    });

    test('complex nested generics allowed', () => {
      const env = new Environment();
      env.registerFunction(
        'count(map<string, list<int>>): int',
        (m: Record<string, bigint[]>) => {
          return Object.values(m).reduce((sum, lst) => sum + lst.length, 0);
        },
      );

      env.registerFunction(
        'count(map<string, list<dyn>>): int',
        (m: Record<string, unknown[]>) => {
          return Object.values(m).reduce((sum, lst) => sum + lst.length, 0);
        },
      );
    });
  });

  describe('error messages', () => {
    test('error includes both signatures', () => {
      const env = new Environment();
      env.registerFunction('test(string): int', (x: string) => x.length);

      assert.throws(
        () =>
          env.registerFunction(
            'test(dyn): int',
            (x: unknown) => String(x).length,
          ),
        /Function signature 'test\(dyn\): int' overlaps with existing overload 'test\(string\): int'/,
      );
    });

    test('error shows receiver in signature', () => {
      const env = new Environment();
      env.registerFunction(
        'string.test(int): int',
        (_receiver: string, x: bigint) => x,
      );

      assert.throws(
        () =>
          env.registerFunction(
            'string.test(dyn): int',
            (_receiver: string, x: unknown) => x,
          ),
        /string\.test\(dyn\): int/,
      );
    });
  });
});
