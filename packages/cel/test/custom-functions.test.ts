import { describe, test } from 'bun:test';
import { TestEnvironment } from './helpers';

const globalEnv = new TestEnvironment()
  .registerVariable('dynamic', 'dyn')
  .registerVariable('dynamicList', 'list<dyn>')
  .registerVariable('integer', 'int')
  .registerVariable('integerList', 'list<int>')
  .registerVariable('boolean', 'bool')
  .registerVariable('booleanList', 'list<bool>')
  .registerFunction('max(bool): string', () => 'bool')
  .registerFunction('max(int): string', () => 'int')
  .registerFunction('max(list<bool>): string', () => 'list-bool')
  .registerFunction('max(list<int>): string', () => 'list-int')
  .registerFunction('max(map<int,int>): string', () => 'map-int-int')
  .registerFunction('max(map<int,bool>): string', () => 'map-int-bool')
  .registerFunction('max(map<string,int>): string', () => 'map-string-int')
  .registerFunction('max(map<string,bool>): string', () => 'map-string-bool');

const { expectEval, expectEvalThrows } = globalEnv;

describe('Custom functions', () => {
  test('resolves overloads correctly according to the type check', () => {
    expectEval('max([1])', 'list-int');
    expectEval('max([integer])', 'list-int', { integer: 1n });
    expectEval('max(integerList)', 'list-int', { integerList: [1n] });
    expectEval('max([false])', 'list-bool');
    expectEval('max([boolean])', 'list-bool', { boolean: false });
    expectEval('max(booleanList)', 'list-bool', { booleanList: [false] });
  });

  test('resolves overloads correctly according to the type check with dyn', () => {
    expectEval('max([dynamic])', 'list-int', { dynamic: 1n });
    expectEval('max(dynamic)', 'list-int', { dynamic: [1n] });
    expectEval('max([dyn(1)])', 'list-int');
  });

  test('prefers concrete overloads when dyn collections carry specific types', () => {
    expectEval('max([dyn(1), dyn(1.0)])', 'list-int');
    expectEvalThrows('max([dyn(1.1), dyn(1)])', /no matching overload/i);

    expectEval('max(dynamic)', 'map-string-int', { dynamic: { value: 1n } });
    expectEval('max(dynamic)', 'map-string-bool', {
      dynamic: { value: false },
    });
    expectEval('max(dynamic)', 'map-int-int', { dynamic: new Map([[1n, 2n]]) });
    expectEval('max(dynamic)', 'map-int-bool', {
      dynamic: new Map([[1n, true]]),
    });
  });

  test('refines partially dynamic collection declarations', () => {
    expectEval('max(dynamicList)', 'list-int', { dynamicList: [1n] });
    expectEval('max(dynamicList)', 'list-bool', { dynamicList: [false] });
    expectEvalThrows('max(dynamicList)', /no matching overload/i, {
      dynamicList: ['a'],
    });
  });

  test('falls back to the first overload when runtime values lack samples', () => {
    expectEval('max([])', 'list-bool');
    expectEval('max(dynamicList)', 'list-bool', { dynamicList: [] });
    expectEval('max({})', 'map-int-int');
    expectEval('max(dynamic)', 'map-int-int', { dynamic: {} });
    expectEval('max(dynamic)', 'map-int-int', { dynamic: new Map() });
  });
});

describe('one handler registered as a function and a method', () => {
  test('runs with the evaluator as this in both forms', () => {
    function receiver(this: unknown): string {
      return this === null || typeof this !== 'object'
        ? typeof this
        : this.constructor.name;
    }

    const env = new TestEnvironment()
      .registerFunction('receiver(string): string', receiver)
      .registerFunction('string.receiver(): string', receiver);
    env.expectEval("receiver('a')", 'Evaluator');
    env.expectEval("'a'.receiver()", 'Evaluator');
  });
});
