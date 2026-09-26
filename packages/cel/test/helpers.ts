import assert from 'node:assert/strict';
import { Environment } from '../src/index';
import type { Context, ParseResult } from '../src/index';
import { Duration } from '../src/functions';

export type ErrorMatcher = string | RegExp | object;

// Environment instances are not extensible, so the helpers are getters instead of fields.
export class TestEnvironment extends Environment {
  get expectEval() {
    return (
      expr: string,
      expected: unknown,
      context?: Context,
      message?: string,
    ): void => {
      assert.strictEqual(this.#evaluateSync(expr, context), expected, message);
    };
  }

  get expectEvalAsync() {
    return async (
      expr: string,
      expected: unknown,
      context?: Context,
      message?: string,
    ): Promise<void> => {
      assert.strictEqual(await this.evaluate(expr, context), expected, message);
    };
  }

  get expectEvalDeep() {
    return (
      expr: string,
      expected: unknown,
      context?: Context,
      message?: string,
    ): void => {
      assert.deepStrictEqual(
        normalize(this.#evaluateSync(expr, context)),
        normalize(expected),
        message,
      );
    };
  }

  get expectEvalDeepAsync() {
    return async (
      expr: string,
      expected: unknown,
      context?: Context,
      message?: string,
    ): Promise<void> => {
      assert.deepStrictEqual(
        normalize(await this.evaluate(expr, context)),
        normalize(expected),
        message,
      );
    };
  }

  get expectEvalThrows() {
    return (expr: string, matcher?: ErrorMatcher, context?: Context): unknown =>
      assertThrows(() => this.#evaluateSync(expr, context), matcher);
  }

  get expectEvalThrowsAsync() {
    return async (
      expr: string,
      matcher?: ErrorMatcher,
      context?: Context,
    ): Promise<unknown> => {
      try {
        await this.evaluate(expr, context);
      } catch (e) {
        return assertError(e, matcher);
      }

      return assertError(undefined, matcher);
    };
  }

  get expectParseThrows() {
    return (expr: string, matcher?: ErrorMatcher): unknown =>
      assertThrows(() => this.parse(expr), matcher);
  }

  get expectType() {
    return (expr: string, expected: string): void => {
      const result = this.check(expr);
      if (!result.valid) {
        throw result.error;
      }

      assert.strictEqual(result.type, expected);
    };
  }

  get expectCheckThrows() {
    return (expr: string, matcher?: ErrorMatcher): unknown =>
      assertThrows(() => {
        const result = this.check(expr);
        if (!result.valid) {
          throw result.error;
        }
      }, matcher);
  }

  #evaluateSync(expr: string, context?: Context): unknown {
    const res = this.evaluate(expr, context);
    if (res instanceof Promise) {
      throw new TypeError(`${expr} is async, use an Async helper`);
    }

    return res;
  }
}

function assertError(err: unknown, matcher: ErrorMatcher | undefined): unknown {
  const block = (): never => {
    throw err;
  };

  if (matcher === undefined) {
    assert.throws(block);
  } else {
    assert.throws(
      block,
      typeof matcher === 'string' ? { message: matcher } : matcher,
    );
  }

  return err;
}

function assertThrows(fn: () => unknown, matcher?: ErrorMatcher): unknown {
  try {
    fn();
  } catch (e) {
    return assertError(e, matcher);
  }

  return assertError(undefined, matcher);
}

const defaultExpectations = new TestEnvironment({
  unlistedVariablesAreDyn: true,
  enableOptionalTypes: true,
});

export const {
  expectType,
  expectEval,
  expectEvalDeep,
  expectEvalThrows,
  expectParseThrows,
} = defaultExpectations;

export function evaluate(expr: string, context?: Context): unknown {
  return defaultExpectations.evaluate(expr, context);
}

export function parse(expr: string): ParseResult {
  return defaultExpectations.parse(expr);
}

export { assert };

export function expectParseAst(
  expression: string,
  expectedAst: unknown,
): ParseResult {
  const result = parse(expression);
  assert.deepStrictEqual(toSimpleAst(result.ast), expectedAst);

  return result;
}

function toSimpleAst(node: unknown): unknown {
  if (node === null || typeof node !== 'object' || !('op' in node)) {
    return node;
  }

  const simple: { op: unknown; args?: unknown } = { op: node.op };
  const args = 'args' in node ? node.args : undefined;
  if (Array.isArray(args)) {
    simple.args = args.map(toSimpleAst);
  } else if (args !== undefined) {
    simple.args = toSimpleAst(args);
  }

  return simple;
}

function normalize(value: unknown): unknown {
  return value instanceof Duration ? { Duration: value.valueOf() } : value;
}
