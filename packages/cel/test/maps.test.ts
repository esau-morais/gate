import { test, describe } from 'bun:test';
import assert from 'node:assert/strict';
import {
  expectEval,
  expectEvalDeep,
  expectEvalThrows,
  TestEnvironment,
} from './helpers';

describe('maps/objects expressions', () => {
  describe('literals', () => {
    test('should create an empty map', () => {
      expectEvalDeep('{}', {});
    });

    test('should create a simple map', () => {
      expectEvalDeep('{"key": "value"}', { key: 'value' });
    });

    test('should create a map with multiple properties', () => {
      expectEvalDeep('{"first": "John", "last": "Doe", "city": "Berlin"}', {
        first: 'John',
        last: 'Doe',
        city: 'Berlin',
      });
    });

    test('should handle numeric keys', () => {
      expectEvalDeep('{1: "one", 2: "two"}', {
        1: 'one',
        2: 'two',
      });
    });

    test('should handle computed keys', () => {
      expectEvalDeep('{("key" + "1"): "value1"}', {
        key1: 'value1',
      });
    });

    test('supports equality checks', () => {
      expectEval('{"foo": "bar"} == {"foo": "bar"}', true);
      expectEval('{dyn("foo"): "bar"} == {dyn("foo"): "bar"}', true);
      expectEval('{"foo": "bar"} == dyn({"foo": "bar"})', true);
      expectEval('{dyn("foo"): "bar"} == dyn({"foo": "bar"})', true);

      expectEval('{"foo": "bar"} == {"foo": "hello"}', false);

      expectEval('{"foo": "bar"} != {"foo": "bar"}', false);
      expectEval('{"foo": "bar"} != {"foo": "hello"}', true);
      expectEval('{"foo": dyn(1)} != {"foo": "hello"}', true);
      expectEval(
        '{"foo": dyn(1), "hello": dyn("bar")} != {"foo": "hello", "hello": "bar"}',
        true,
      );
    });

    test('does not support equality checks with mixed types', () => {
      expectEvalThrows(
        '{"foo": "bar"} == ["foo", "bar"]',
        /no such overload: map<string, string> == list<string>/,
      );
      expectEvalThrows(
        '{"foo": "bar"} != ["foo", "bar"]',
        /no such overload: map<string, string> != list<string>/,
      );
      expectEvalThrows(
        '{1: "foo"} == {"foo": "bar"}',
        /no such overload: map<int, string> == map<string, string>/,
      );
    });
  });

  describe('nested maps', () => {
    test('should create nested maps', () => {
      expectEvalDeep('{"user": {"first": "John", "last": "Doe"}}', {
        user: { first: 'John', last: 'Doe' },
      });
    });

    test('should create deeply nested maps', () => {
      expectEvalDeep('{"a": {"b": {"c": "deep"}}}', {
        a: { b: { c: 'deep' } },
      });
    });
  });

  describe('maps with arrays', () => {
    test('should create map with array values', () => {
      expectEvalDeep('{"items": [1, 2, 3], "more": [4, 5]}', {
        items: [1n, 2n, 3n],
        more: [4n, 5n],
      });
    });

    test('rejects mixed value types by default', () => {
      expectEvalThrows(
        '{"name": "John", "age": 30, "active": true}',
        /Map value uses wrong type/,
      );
    });

    test('allows mixed value types when explicitly disabled', () => {
      const env = new TestEnvironment({ homogeneousAggregateLiterals: false });
      env.expectEvalDeep('{"name": "John", "age": 30, "active": true}', {
        name: 'John',
        age: 30n,
        active: true,
      });
    });

    test('allows mixed value types when wrapped with dyn', () => {
      expectEvalDeep(
        '{"name": dyn("John"), "age": dyn(30), "active": dyn(true)}',
        {
          name: 'John',
          age: 30n,
          active: true,
        },
      );
    });

    test('still enforces map values when explicitly enabled', () => {
      const env = new TestEnvironment({ homogeneousAggregateLiterals: true });
      env.expectEvalThrows(
        '{"name": "John", "age": 30}',
        /Map value uses wrong type/,
      );
    });

    test('rejects mixed key types by default', () => {
      expectEvalThrows(
        '{"name": "John", 1: "duplicate"}',
        /Map key uses wrong type/,
      );
    });

    test('allows mixed key types when explicitly disabled', () => {
      const env = new TestEnvironment({ homogeneousAggregateLiterals: false });
      env.expectEvalDeep('{"name": "John", 1: "duplicate"}', {
        name: 'John',
        1: 'duplicate',
      });
    });

    test('allows mixed key types when wrapped with dyn', () => {
      expectEvalDeep('{dyn("name"): "John", dyn(1): "one"}', {
        name: 'John',
        1: 'one',
      });
    });

    test('still enforces map keys when explicitly enabled', () => {
      const env = new TestEnvironment({ homogeneousAggregateLiterals: true });
      env.expectEvalThrows(
        '{"name": "John", 1: "duplicate"}',
        /Map key uses wrong type/,
      );
    });

    test('should create array of maps', () => {
      expectEvalDeep('[{"name": "John"}, {"name": "Jane"}]', [
        { name: 'John' },
        { name: 'Jane' },
      ]);
    });
  });

  describe('with variables', () => {
    test('should use variables as values', () => {
      expectEvalDeep(
        '{"name": userName, "age": userAge}',
        { name: 'Alice', age: 25 },
        { userName: 'Alice', userAge: 25 },
      );
    });

    test('should use variables as keys', () => {
      expectEvalDeep(
        '{keyName: "value"}',
        { dynamicKey: 'value' },
        { keyName: 'dynamicKey' },
      );
    });
  });

  describe('property access', () => {
    test('should access map property with dot notation', () => {
      expectEval('obj.name', 'John', { obj: { name: 'John' } });
    });

    test('should access map property with bracket notation', () => {
      expectEval('obj["name"]', 'John', { obj: { name: 'John' } });
      expectEval('obj["$"]', 'John', { obj: { $: 'John' } });
      expectEval('obj["0"]', 'John', { obj: { 0: 'John' } });
    });

    test('should access nested properties', () => {
      expectEval('user.profile.name', 'Alice', {
        user: { profile: { name: 'Alice' } },
      });
      expectEval(
        'user.profile.name',
        'Alice',
        new Map([['user', { profile: { name: 'Alice' } }]]),
      );
      expectEval(
        'user.profile.name',
        'Alice',
        new Map([['user', new Map([['profile', { name: 'Alice' }]])]]),
      );
    });

    test('allows property access on maps in list', () => {
      expectEval('[{"name": "John"}, {"name": "Jane"}][0].name', 'John');
    });

    test('throws on invalid property access (no_such_field)', () => {
      expectEvalThrows('{"foo": "bar"}.hello', /No such key: hello/);
      expectEvalThrows('foo.hello', /No such key: hello/, { foo: {} });
    });

    test('throws on invalid identifier access', () => {
      expectEvalThrows('{"0": "bar"}.0', /Expected IDENTIFIER, got NUMBER/);
    });
  });

  describe('mixed access patterns', () => {
    test('should handle mixed dot and bracket notation', () => {
      const context = {
        data: {
          users: [{ profile: { 'full-name': 'John Doe' } }],
        },
      };
      expectEval('data.users[0].profile["full-name"]', 'John Doe', context);
    });
  });

  describe('prototype pollution hardening', () => {
    test('should ignore __proto__ assignments during map creation', () => {
      const env = new TestEnvironment({ homogeneousAggregateLiterals: false });
      env.expectEvalDeep('{"safe": true, "__proto__": {"polluted": true}}', {
        safe: true,
      });
      assert.strictEqual(Reflect.get(Object.prototype, 'polluted'), undefined);
      assert.strictEqual('polluted' in {}, false);
    });

    test('should drop constructor/prototype keys to keep objects safe', () => {
      const env = new TestEnvironment({ homogeneousAggregateLiterals: false });
      env.expectEvalDeep(
        '{"safe": true, "constructor": {"prototype": {"polluted": true}}, "prototype": {"polluted": true}}',
        { safe: true },
      );
      assert.strictEqual(Reflect.get(Object.prototype, 'polluted'), undefined);
      assert.strictEqual('polluted' in {}, false);
    });

    test('should prevent access to __proto__ and other non-enumerable properties', () => {
      expectEvalThrows('data.__proto__', /No such key: __proto__/, {
        data: {},
      });
      expectEvalThrows('data["__proto__"]', /No such key: __proto__/, {
        data: {},
      });
      expectEvalThrows('data.constructor', /No such key: constructor/, {
        data: {},
      });
      expectEvalThrows('data.toString', /No such key: toString/, { data: {} });
    });

    test('also does not allow root context access to __proto__ and other non-enumerable properties', () => {
      expectEvalThrows('__proto__', /Reserved identifier: __proto__/, {});
      expectEvalThrows('prototype', /Reserved identifier: prototype/, {});
      expectEvalThrows('constructor', /Unsupported type: function/, {});
      expectEvalThrows('toString', /Unsupported type: function/, {});
    });
  });
});

describe('map literal keys', () => {
  const { expectEvalThrows } = new TestEnvironment({
    unlistedVariablesAreDyn: true,
    homogeneousAggregateLiterals: false,
  });

  test('reject repeated keys', () => {
    expectEvalThrows('{true:1,false:2,true:3}[true]', /repeated map key/i);
    expectEvalThrows('{0: 1, 0u: 2}[0.0]', /repeated map key/i);
  });

  test('reject double and null keys', () => {
    expectEvalThrows('{3.3:15.15, 1.0: 5}[1.0]', /unsupported map key type/i);
    expectEvalThrows('{null:false}[null]', /unsupported map key type/i);
    expectEvalThrows('{x: 1}', /unsupported map key type/i, { x: 1.5 });
  });
});

describe('input maps with a constructor key', () => {
  const deps: unknown = JSON.parse(
    '{"constructor":"1.0.0","left-pad":"1.3.0"}',
  );

  test('read the key like any other', () => {
    expectEval("'constructor' in deps", true, { deps });
    expectEval('size(deps)', 2n, { deps });
    expectEval("deps['constructor']", '1.0.0', { deps });
  });

  test('stay maps when nested', () => {
    const pkg: unknown = JSON.parse(
      '{"dependencies":{"constructor":{"name":"Map"}}}',
    );
    expectEval("'constructor' in pkg.dependencies", true, { pkg });
  });
});
