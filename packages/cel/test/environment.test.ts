import { describe, test } from 'bun:test';
import assert from 'node:assert';
import { ParseError, EvaluationError } from '../src/errors';
import { Environment } from '../src/evaluator';
import { TestEnvironment } from './helpers';

describe('Environment', () => {
  test('basic usage', () => {
    const env = new TestEnvironment();
    env.expectEval('1 + 2', 3n);
  });

  test('variable registration and type checking', () => {
    const env = new TestEnvironment()
      .registerVariable('name', 'string')
      .registerVariable('age', 'int')
      .registerVariable('isActive', 'bool');

    env.expectEval('name + " is " + string(age)', 'John is 30', {
      name: 'John',
      age: 30n,
    });

    env.expectEvalThrows('name', EvaluationError, { name: 123 });
  });

  test('context variables without explicit type get dyn', () => {
    const env = new TestEnvironment({
      unlistedVariablesAreDyn: true,
    }).registerVariable('explicitVar', 'string');

    env.expectEval('explicitVar + string(implicitVar)', 'Hello 42', {
      explicitVar: 'Hello ',
      implicitVar: 42,
    });
  });

  test('custom function registration', () => {
    const env = new TestEnvironment()
      .registerFunction('multiplyBy2(int): int', (x: bigint) => x * 2n)
      .registerFunction(
        'greet(string): string',
        (name: string) => `Hello, ${name}!`,
      );

    env.expectEval('multiplyBy2(21)', 42n);
  });

  test('chaining methods', () => {
    const env = new TestEnvironment()
      .registerVariable('x', 'int')
      .registerVariable('y', 'int')
      .registerFunction(
        'add(double, double): double',
        (a: number, b: number) => a + b,
      );

    assert.ok(env instanceof Environment);
    assert.ok(env.hasVariable('x'));
    assert.ok(env.hasVariable('y'));
    env.expectEval('add(1.5, 2.5)', 4);
  });

  test('evaluate with string expression', () => {
    const env = new TestEnvironment().registerVariable('name', 'string');

    env.expectEval('name + " World"', 'Hello World', { name: 'Hello' });
  });

  test('complex expression with multiple features', () => {
    class User {
      name: string;
      #age: number;

      constructor({ name, age }: { name: string; age: number }) {
        this.name = name;
        this.#age = age;
      }

      get age() {
        return this.#age;
      }
    }

    const env = new TestEnvironment()
      .registerType('User', {
        ctor: User,
        fields: { name: 'string', age: 'double' },
      })
      .registerVariable('users', 'list<User>')
      .registerVariable('minAge', 'int')
      .registerFunction('isAdult(User): bool', (u: User) => u.age >= 18);

    const context = {
      users: [
        new User({ name: 'Alice', age: 25 }),
        new User({ name: 'Bob', age: 16 }),
        new User({ name: 'Charlie', age: 30 }),
      ],
      minAge: 18n,
    };

    env.expectEvalDeep(
      'users.filter(u, u.age >= minAge).map(u, u.name)',
      ['Alice', 'Charlie'],
      context,
    );

    env.expectEvalDeep(
      'users.filter(u, isAdult(u)).map(u, u.name)',
      ['Alice', 'Charlie'],
      context,
    );
  });

  test('error handling with context', () => {
    const env = new TestEnvironment().registerVariable('x', 'int');

    env.expectEvalThrows('y + 1', /Unknown variable: y/, { x: 5n });
    env.expectEvalThrows('x + 1', EvaluationError, { x: 'not a number' });
  });

  test('function overloads', () => {
    const env = new TestEnvironment()
      .registerFunction('convert(double): string', (v: number) => String(v))
      .registerFunction('convert(int): string', (v: bigint) => String(v))
      .registerFunction('int.convert(): string', (v: bigint) => v.toString())
      .registerFunction('double.convert(): string', (v: number) => v.toString())
      .registerFunction('convert(string): string', (v: string) => v)
      .registerFunction('string.convert(): string', (v: string) => v);

    env.expectEval('convert("foo")', 'foo');
    env.expectEval('convert(42)', '42');
    env.expectEval('convert(1.1)', '1.1');
    env.expectEval('convert(1)', '1');
    env.expectParseThrows('convert("foo", ")', ParseError);
    env.expectEvalThrows('convert("foo", "bar")', /found no matching overload/);
  });

  test('inheritance from global functions', () => {
    const env = new TestEnvironment();

    env.expectEval('size("hello")', 5n);
    env.expectEval('"world".size()', 5n);
    env.expectEval('string(42)', '42');
  });

  test('mixed built-in and custom functions', () => {
    const env = new TestEnvironment()
      .registerFunction('multiplyBy2(int): int', (x: bigint) => x * 2n)
      .registerVariable('text', 'string');

    env.expectEval('multiplyBy2(size(text))', 10n, { text: 'hello' });
  });

  test('variable type validation', () => {
    const env = new TestEnvironment()
      .registerVariable('count', 'int')
      .registerVariable('name', 'string');

    env.expectEval('count + 1', 43n, { count: 42n });
    env.expectEval('name + "!"', 'test!', { name: 'test' });

    env.expectEvalThrows('count + 1', EvaluationError, { count: 'not an int' });
    env.expectEvalThrows('name + "!"', EvaluationError, { name: 123 });
  });

  test('empty context', () => {
    const env = new TestEnvironment();
    env.expectEval('1 + 2 * 3', 7n);
  });

  test('no context parameter', () => {
    const env = new TestEnvironment();
    env.expectEval('true && false', false);
  });

  test('custom operator registration with Vector types', () => {
    class Vec2 {
      x: number;
      y: number;

      constructor(x: number, y: number) {
        this.x = x;
        this.y = y;
      }
    }

    const env = new TestEnvironment()
      .registerType('Vec2', Vec2)
      .registerVariable('a', 'Vec2')
      .registerVariable('b', 'Vec2')
      .registerOperator(
        'Vec2 * Vec2',
        (a: Vec2, b: Vec2) => a.x * b.x + a.y * b.y,
      ); // Dot product

    env.expectEval('a * b', 10, { a: new Vec2(3, 4), b: new Vec2(2, 1) });
  });

  test('parse() method for AST reuse', () => {
    const env = new TestEnvironment().registerVariable('x', 'int');

    const parsed = env.parse('x + 1');
    assert.strictEqual(typeof parsed, 'function');
    assert.ok(Boolean(parsed.ast));

    assert.strictEqual(parsed({ x: 5n }), 6n);
    assert.strictEqual(parsed({ x: 10n }), 11n);
  });

  test('parse() returns function with check method', () => {
    const env = new TestEnvironment()
      .registerVariable('x', 'int')
      .registerVariable('y', 'int');

    const parsed = env.parse('x + y');

    // Check method should be available
    assert.strictEqual(typeof parsed.check, 'function');

    // Check should return type information
    const checkResult = parsed.check();
    assert.strictEqual(checkResult.valid, true);
    assert.strictEqual(checkResult.type, 'int');

    // Should still be able to evaluate
    assert.strictEqual(parsed({ x: 5n, y: 3n }), 8n);
  });

  test('parse() check detects type errors', () => {
    const env = new TestEnvironment()
      .registerVariable('x', 'int')
      .registerVariable('y', 'string');

    const parsed = env.parse('x + y');

    // Type error should be caught by check
    const checkResult = parsed.check();
    assert.strictEqual(checkResult.valid, false);
    assert.ok(checkResult.error instanceof Error);
    assert.ok(checkResult.error.message.includes('no such overload'));
  });

  test('duplicate variable registration throws', () => {
    const env = new TestEnvironment().registerVariable('x', 'int');

    assert.throws(
      () => {
        env.registerVariable('x', 'string');
      },
      {
        message: /Invalid variable declaration: 'x' is already registered/,
      },
    );
  });

  test('unlistedVariablesAreDyn with missing variable', () => {
    const env = new TestEnvironment({ unlistedVariablesAreDyn: true });

    env.expectEval('unknownVar + 10', 15n, { unknownVar: 5n });
  });

  test('unlistedVariablesAreDyn with registered variable', () => {
    const env = new TestEnvironment({
      unlistedVariablesAreDyn: true,
    }).registerVariable('x', 'string');

    env.expectEvalThrows('x', EvaluationError, { x: 123 });
    env.expectEval('y + 10', 15n, { y: 5n });
  });

  test('operator overloading with mixed types', () => {
    const env = new TestEnvironment()
      .registerVariable('str', 'string')
      .registerVariable('num', 'int')
      .registerOperator('string * int', (str: string, num: bigint) =>
        str.repeat(Number(num)),
      );

    env.expectEval('str * num', 'ababab', { str: 'ab', num: 3n });
  });

  describe('schema-based variable registration', () => {
    test('basic object schema', () => {
      const env = new TestEnvironment().registerVariable('user', {
        schema: { name: 'string', age: 'int' },
      });

      env.expectType('user.name', 'string');
      env.expectType('user.age', 'int');
      env.expectCheckThrows('user.foo', /No such key/);

      const ctx = { user: { name: 'Alice', age: 30n } };
      env.expectEval('user.name', 'Alice', ctx);
      env.expectEval('user.age', 30n, ctx);
    });

    test('runtime field type validation', () => {
      const env = new TestEnvironment().registerVariable('user', {
        schema: { name: 'string', age: 'int' },
      });

      env.expectEvalThrows(
        'user.age',
        /Field 'age' is not of type 'int', got 'double'/,
        {
          user: { name: 'Alice', age: 30 },
        },
      );
    });

    test('undeclared field rejected at runtime', () => {
      const env = new TestEnvironment().registerVariable('user', {
        schema: { name: 'string' },
      });

      env.expectEvalThrows('user.password', /No such key: password/, {
        user: { name: 'Alice', password: 'secret' },
      });
    });

    test('nested object schema', () => {
      const env = new TestEnvironment().registerVariable('user', {
        schema: {
          profile: {
            name: 'string',
            age: 'int',
          },
          status: 'string',
        },
      });

      env.expectType('user.profile.name', 'string');
      env.expectType('user.status', 'string');
      env.expectCheckThrows('user.profile.foo', /No such key/);

      const ctx = {
        user: { profile: { name: 'Alice', age: 30n }, status: 'active' },
      };
      env.expectEval('user.profile.name', 'Alice', ctx);
      env.expectEval('user.status', 'active', ctx);
    });

    test('deeply nested schema', () => {
      const env = new TestEnvironment().registerVariable('data', {
        schema: {
          level1: {
            level2: {
              value: 'int',
              level3: {
                value: 'string',
              },
            },
          },
        },
      });

      env.expectType('data.level1.level2.value', 'int');
      env.expectType('data.level1.level2.level3.value', 'string');

      const ctx = {
        data: { level1: { level2: { value: 1n, level3: { value: 'deep' } } } },
      };
      env.expectEval('data.level1.level2.value', 1n, ctx);
      env.expectEval('data.level1.level2.level3.value', 'deep', ctx);
    });

    test('schema with list and map types', () => {
      const env = new TestEnvironment().registerVariable('data', {
        schema: {
          names: 'list<string>',
          scores: 'map<string, int>',
        },
      });

      env.expectType('data.names', 'list<string>');
      env.expectType('data.scores', 'map<string, int>');
    });

    test('multiple schema variables', () => {
      const env = new TestEnvironment()
        .registerVariable('user', { schema: { name: 'string' } })
        .registerVariable('order', { schema: { id: 'int', total: 'double' } });

      env.expectType('user.name', 'string');
      env.expectType('order.id', 'int');
      env.expectType('order.total', 'double');
    });

    test('schema in expressions', () => {
      const env = new TestEnvironment().registerVariable('user', {
        schema: {
          name: 'string',
          age: 'int',
        },
      });

      const ctx = { user: { name: 'Alice', age: 30n } };
      env.expectType('user.name + " is " + string(user.age)', 'string');
      env.expectEval(
        'user.name + " is " + string(user.age)',
        'Alice is 30',
        ctx,
      );
    });

    test('schema variable in list expression', () => {
      const env = new TestEnvironment().registerVariable('user', {
        schema: {
          name: 'string',
          age: 'int',
        },
      });

      // Tests specific return structure - keep raw evaluate
      const ctx = { user: { name: 'Alice', age: 30n } };
      const result = env.evaluate('[user]', ctx);
      assert.ok(Array.isArray(result));
      const list: unknown[] = result;
      assert.strictEqual(list.length, 1);
      const first = list[0];
      assert.ok(first instanceof Map);
      assert.deepStrictEqual(Object.fromEntries(first), {
        name: 'Alice',
        age: 30n,
      });
    });
  });
});
