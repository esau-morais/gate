import { describe, test } from 'bun:test';
import assert from 'node:assert';
import { Environment } from '../src/evaluator';

describe('Environment inheritance', () => {
  test('environments inherit built-in functions from global registry', () => {
    const env1 = new Environment();
    const env2 = new Environment();
    const env3 = env1.clone();
    assert.strictEqual(env1.evaluate('size("test")'), 4n);
    assert.strictEqual(env2.evaluate('size("test")'), 4n);
    assert.strictEqual(env3.evaluate('size("test")'), 4n);
  });

  test('environments inherits unlistedVariablesAreDyn', () => {
    const env1 = new Environment({ unlistedVariablesAreDyn: true });
    const env2 = env1.clone();
    assert.equal(env1.check('foo + foo').type, 'dyn');
    assert.equal(env2.check('foo + foo').type, 'dyn');
    assert.equal(env1.check('"hello" + foo').type, 'string');
    assert.equal(env2.check('"hello" + foo').type, 'string');

    const env3 = new Environment({ unlistedVariablesAreDyn: false });
    const env4 = env3.clone();
    const error3 = env3.check('foo + foo').error;
    assert.ok(error3 instanceof Error);
    assert.match(error3.message, /Unknown variable: foo/);
    const error4 = env4.check('foo + foo').error;
    assert.ok(error4 instanceof Error);
    assert.match(error4.message, /Unknown variable: foo/);
  });

  test('evaluation against cloned environments is still possible', () => {
    const env1 = new Environment({ unlistedVariablesAreDyn: true });
    env1.clone();
    const ctx = { foo: 'hello' };
    assert.equal(env1.evaluate('foo + foo', ctx), 'hellohello');
  });

  test('environments do not support registration after cloning', () => {
    const env1 = new Environment();
    const env2 = env1.clone();

    const err = /Cannot modify frozen registry/;
    assert.throws(
      () =>
        env1.registerFunction(
          'triple(int): int',
          (value: bigint) => value * 3n,
        ),
      err,
    );
    assert.throws(() => env1.registerType('foo', class Foo {}), err);
    assert.throws(() => env1.registerOperator('int + type', () => {}), err);
    assert.throws(() => env1.registerVariable('foo', 'dyn'), err);

    env2.registerFunction('triple(int): int', (value: bigint) => value * 3n);
    env2.registerType('foo', class Foo {});
    env2.registerOperator('int + type', () => {});
    env2.registerVariable('foo', 'dyn');
  });

  test('functions are isolated between environments', () => {
    const env1 = new Environment()
      .registerFunction(
        'greet(string): string',
        (name: string) => `Hello ${name}`,
      )
      .registerVariable('name', 'string');

    const env2 = new Environment()
      .registerFunction('greet(string): string', (name: string) => `Hi ${name}`)
      .registerVariable('name', 'string');

    const env3 = env2.clone();
    assert.strictEqual(
      env1.evaluate('greet(name)', { name: 'Alice' }),
      'Hello Alice',
    );
    assert.strictEqual(env2.evaluate('greet(name)', { name: 'Bob' }), 'Hi Bob');
    assert.strictEqual(env3.evaluate('greet(name)', { name: 'Bob' }), 'Hi Bob');
  });

  test('operators are isolated between environments', () => {
    class Vec2 {
      x: number;
      y: number;

      constructor(x: number, y: number) {
        this.x = x;
        this.y = y;
      }
    }

    const env1 = new Environment()
      .registerType('Vec2', Vec2)
      .registerVariable('a', 'Vec2')
      .registerVariable('b', 'Vec2')
      .registerOperator(
        'Vec2 + Vec2',
        (a: Vec2, b: Vec2) => new Vec2(a.x + b.x, a.y + b.y),
      );

    const env2 = new Environment()
      .registerType('Vec2', Vec2)
      .registerVariable('a', 'Vec2')
      .registerVariable('b', 'Vec2')
      .registerOperator(
        'Vec2 + Vec2',
        (a: Vec2, b: Vec2) => new Vec2(a.x * b.x, a.y * b.y),
      ); // multiply instead

    const vec1 = new Vec2(1, 2);
    const vec2 = new Vec2(3, 4);

    const result1 = env1.evaluate('a + b', { a: vec1, b: vec2 });
    const result2 = env2.evaluate('a + b', { a: vec1, b: vec2 });

    assert.ok(result1 instanceof Vec2);
    assert.ok(result2 instanceof Vec2);
    assert.strictEqual(result1.x, 4);
    assert.strictEqual(result1.y, 6);
    assert.strictEqual(result2.x, 3);
    assert.strictEqual(result2.y, 8);
  });

  test('variables are isolated between environments', () => {
    const env1 = new Environment().registerVariable('x', 'int');
    const env2 = new Environment().registerVariable('y', 'string');

    assert.ok(env1.hasVariable('x'));
    assert.ok(!env1.hasVariable('y'));
    assert.ok(env2.hasVariable('y'));
    assert.ok(!env2.hasVariable('x'));

    assert.strictEqual(env1.evaluate('x + 1', { x: 5n }), 6n);
    assert.strictEqual(env2.evaluate('y + "!"', { y: 'test' }), 'test!');
  });

  test('custom types are isolated between environments', () => {
    class TypeA {
      value: number;

      constructor(value: number) {
        this.value = value;
      }
    }

    class TypeB {
      value: number;

      constructor(value: number) {
        this.value = value;
      }
    }

    const env1 = new Environment()
      .registerType('CustomType', TypeA)
      .registerVariable('obj', 'CustomType')
      .registerFunction(
        'CustomType.getValue(): int',
        function (receiver: TypeA) {
          return BigInt(receiver.value);
        },
      );

    const env2 = new Environment()
      .registerType('CustomType', TypeB)
      .registerVariable('obj', 'CustomType')
      .registerFunction(
        'CustomType.getValue(): string',
        function (receiver: TypeB) {
          return String(receiver.value);
        },
      );

    const objA = new TypeA(42);
    const objB = new TypeB(99);

    const result1 = env1.evaluate('obj.getValue()', { obj: objA });
    const result2 = env2.evaluate('obj.getValue()', { obj: objB });

    assert.strictEqual(result1, 42n);
    assert.strictEqual(result2, '99');
  });
});

describe('registrations stay in their environment', () => {
  test('a type registered on one environment is unknown to a new one', () => {
    new Environment().registerType('LeakedType', class LeakedType {});
    assert.throws(
      () => new Environment().registerVariable('x', 'LeakedType'),
      /Unknown type: LeakedType/,
    );
  });

  test('a type registered on a clone is unknown to its parent and siblings', () => {
    const parent = new Environment();
    const child = parent.clone();
    child.registerType('ChildType', class ChildType {});
    assert.throws(
      () => parent.clone().registerVariable('x', 'ChildType'),
      /Unknown type: ChildType/,
    );
  });

  test('a list type built in one environment is unknown to a new one', () => {
    new Environment()
      .registerType('ListedType', class ListedType {})
      .registerVariable('xs', 'list<ListedType>');
    assert.throws(
      () => new Environment().registerVariable('ys', 'list<ListedType>'),
      /Unknown type: ListedType/,
    );
  });
});
