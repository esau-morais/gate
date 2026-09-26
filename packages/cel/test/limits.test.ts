import { describe, test } from 'bun:test';
import { parse, expectParseThrows, assert, TestEnvironment } from './helpers';

function populate(
  count: number,
  fn: (i: number) => string | number = (i) => i,
): (string | number)[] {
  return reduce<(string | number)[]>(
    count,
    (a, i) => {
      a.push(fn(i));

      return a;
    },
    [],
  );
}

function reduce<S>(count: number, fn: (state: S, i: number) => S, state: S): S {
  for (let i = 0; i < count; i++) {
    state = fn(state, i);
  }

  return state;
}

function buildMap(count: number): string {
  return `{${populate(count, (i) => `'k${i}': ${i}`).join(', ')}}`;
}

function buildNestedList(count: number, varName = ''): string {
  return reduce(count, (s) => `[${s}]`, varName);
}

function buildNestedMap(count: number): string {
  return reduce(count, (s, i) => `{ 'k${i}': ${s} }`, '0');
}

function buildSelectChain(count: number): string {
  return reduce(count, (s, i) => `${s}.a${i}`, 'a0');
}

function buildIndexChain(count: number): string {
  return reduce(count, (s, i) => `${s}[${i}]`, 'a');
}

function buildNestedCalls(count: number, varName = ''): string {
  return reduce(count, (s) => `type(${s})`, varName);
}

describe('parser limits', () => {
  test('allows call arguments up to default maxCallArguments', () => {
    parse(`foo(${populate(32).join(',')})`);
  });

  test('throws when call arguments exceed maxCallArguments', () => {
    expectParseThrows(`foo(${populate(33).join(',')})`, /maxCallArguments/);
  });

  test('allows up to default maxListElements', () => {
    parse(`[${populate(1000).join(',')}]`);
  });

  test('throws when list elements exceed maxListElements', () => {
    expectParseThrows(`[${populate(1001).join(',')}]`, /maxListElements/);
  });

  test('allows up to default maxMapEntries', () => {
    parse(buildMap(1000));
  });

  test('throws when map entries exceed maxMapEntries', () => {
    expectParseThrows(buildMap(1001), /maxMapEntries/);
  });

  test('allows aggregate nesting up to default maxDepth', () => {
    parse(buildNestedList(249));
    parse(buildNestedMap(249));
  });

  test('throws when aggregate nesting exceeds maxDepth', () => {
    expectParseThrows(buildNestedList(251), /maxDepth/);
    expectParseThrows(buildNestedMap(250), /maxDepth/);
  });

  test('allows select chains up to default maxDepth', () => {
    // initial var and 11 .prop calls
    parse(buildSelectChain(249));
  });

  test('throws when select depth exceeds maxDepth', () => {
    expectParseThrows(buildSelectChain(250), /maxDepth/);
  });

  test('allows index chains up to default maxDepth', () => {
    // initial var, 10 [] calls and the variable lookup within [var]
    parse(buildIndexChain(248));
  });

  test('throws when index depth exceeds maxDepth', () => {
    expectParseThrows(buildIndexChain(249), /maxDepth/);
  });

  test('allows nested function calls up to default maxDepth', () => {
    parse(buildNestedCalls(250));
  });

  test('throws when nested function calls exceed maxDepth', () => {
    expectParseThrows(buildNestedCalls(251), /maxDepth/);
    expectParseThrows(buildNestedCalls(250, 'x'), /maxDepth/);
  });

  test('throws when AST nodes exceed configured maxAstNodes', () => {
    const env = new TestEnvironment({
      limits: {
        maxCallArguments: 4,
        maxListElements: 2,
        maxMapEntries: 3,
        maxDepth: 12,
        maxAstNodes: 30,
      },
    });

    env.parse(populate(15).join(' + '));
    assert.throws(() => env.parse(populate(16).join(' + ')), /maxAstNodes/);

    env.parse(buildNestedCalls(12));
    assert.throws(() => env.parse(buildNestedCalls(13)), /maxDepth/);

    env.parse(`foo(${populate(4).join(',')})`);
    assert.throws(
      () => env.parse(`foo(${populate(5).join(',')})`),
      /maxCallArguments/,
    );

    env.parse(`[${populate(2).join(',')}]`);
    assert.throws(
      () => env.parse(`[${populate(3).join(',')}]`),
      /maxListElements/,
    );
  });
});
