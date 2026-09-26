import { evaluationError } from './errors';
import { expectDefined, isPromise } from './globals';
import type { EvalContext, Registry, TypeDeclaration } from './registry';
import type { TypeChecker } from './type-checker';
import type { Evaluator } from './evaluator';
import type { AnyNode, CallNode, MacroInput, RcallNode } from './parser';

/**
 * Represents an optional value that may or may not be present.
 * Used with optional chaining (.?/.[]?) and optional.* helpers.
 */
export class Optional<T = unknown> {
  #value: T | undefined;

  constructor(value?: T) {
    this.#value = value;
  }

  /**
   * Create a new Optional with a value.
   * @param value - The value to wrap
   * @returns A new Optional instance
   */
  static of<T>(value: T): Optional<T> {
    if (value === undefined) {
      return OPTIONAL_NONE;
    }

    return new Optional(value);
  }

  /**
   * Create an empty Optional.
   * @returns The singleton empty Optional instance
   */
  static none(): Optional<never> {
    return OPTIONAL_NONE;
  }

  /** Check if a value is present. */
  hasValue(): boolean {
    return this.#value !== undefined;
  }

  /**
   * Get the wrapped value.
   * @returns The wrapped value
   * @throws EvaluationError if no value is present
   */
  value(): T {
    if (this.#value === undefined) {
      throw evaluationError(
        'optional_value_missing',
        'Optional value is not present',
      );
    }

    return this.#value;
  }

  /**
   * Return this Optional if it has a value, otherwise return the provided Optional.
   * @param optional - The fallback Optional
   * @returns An Optional instance
   */
  or<U>(optional: Optional<U>): Optional<T | U> {
    if (this.#value !== undefined) {
      return this;
    }

    if (optional instanceof Optional) {
      return optional;
    }

    throw evaluationError(
      'invalid_optional_argument',
      'Optional.or must be called with an Optional argument',
    );
  }

  /**
   * Return the wrapped value if present, otherwise return the default value.
   * @param defaultValue - The fallback value
   * @returns The resulting value
   */
  orValue<U>(defaultValue: U): T | U {
    return this.#value === undefined ? defaultValue : this.#value;
  }

  get [Symbol.toStringTag](): string {
    return 'optional';
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return this.#value === undefined
      ? `Optional { none }`
      : `Optional { value: ${JSON.stringify(this.#value)} }`;
  }
}

const none = new Optional<never>();
Object.freeze(none);
export const OPTIONAL_NONE: Optional<never> = none;

class OptionalNamespace {}
const optionalNamespace = new OptionalNamespace();

export function toggleOptionalTypes(registry: Registry, enable: boolean): void {
  const optionalConstant = enable ? optionalNamespace : undefined;
  registry.deleteVariable('optional');
  registry.registerConstant('optional', 'OptionalNamespace', optionalConstant);
}

interface OptionalMacro {
  ast: CallNode | RcallNode;
  functionDesc: string;
  receiver: AnyNode;
  arg: AnyNode;
  evaluate(ev: Evaluator, macro: OptionalMacro, ctx: EvalContext): unknown;
  typeCheck(
    check: TypeChecker,
    macro: OptionalMacro,
    ctx: EvalContext,
  ): TypeDeclaration;
  onHasValue(optional: Optional): unknown;
  onEmpty(ev: Evaluator, macro: OptionalMacro, ctx: EvalContext): unknown;
}

type OptionalMacroSpec = Pick<
  OptionalMacro,
  'functionDesc' | 'evaluate' | 'typeCheck' | 'onHasValue' | 'onEmpty'
>;

export function register(registry: Registry): void {
  const sync = { async: false };
  const functionOverload = (
    sig: string,
    handler: (...args: never[]) => unknown,
  ): void => registry.registerFunctionOverload(sig, handler, sync);

  const optionalConstant = registry.enableOptionalTypes
    ? optionalNamespace
    : undefined;
  registry.registerType('OptionalNamespace', OptionalNamespace);
  registry.registerConstant('optional', 'OptionalNamespace', optionalConstant);
  functionOverload('optional.hasValue(): bool', (v: Optional) => v.hasValue());
  functionOverload('optional<A>.value(): A', (v: Optional) => v.value());
  registry.registerFunctionOverload(
    'OptionalNamespace.none(): optional<T>',
    () => Optional.none(),
  );
  functionOverload(
    'OptionalNamespace.of(A): optional<A>',
    (_: OptionalNamespace, value: unknown) => Optional.of(value),
  );
  function ensureOptional(
    value: unknown,
    ast: AnyNode,
    description: string,
  ): Optional {
    if (value instanceof Optional) {
      return value;
    }

    throw evaluationError(
      'optional_expected',
      `${description} must be optional`,
      ast,
    );
  }

  function evaluateOptional(
    ev: Evaluator,
    macro: OptionalMacro,
    ctx: EvalContext,
  ): unknown {
    const v = ev.run(macro.receiver, ctx);
    if (isPromise(v)) {
      return v.then((_v: unknown) =>
        handleOptionalResolved(_v, ev, macro, ctx),
      );
    }

    return handleOptionalResolved(v, ev, macro, ctx);
  }

  function handleOptionalResolved(
    value: unknown,
    ev: Evaluator,
    macro: OptionalMacro,
    ctx: EvalContext,
  ): unknown {
    const optional = ensureOptional(
      value,
      macro.receiver,
      `${macro.functionDesc} receiver`,
    );
    if (optional.hasValue()) {
      return macro.onHasValue(optional);
    }

    return macro.onEmpty(ev, macro, ctx);
  }

  function ensureOptionalType(
    checker: TypeChecker,
    node: AnyNode,
    ctx: EvalContext,
    description: string,
  ): TypeDeclaration {
    const type = checker.check(node, ctx);
    if (type.kind === 'optional') {
      return type;
    }

    if (type.kind === 'dyn') {
      return checker.getType('optional');
    }

    throw checker.createError(
      'optional_expected',
      `${description} must be optional, got '${type.name}'`,
      node,
    );
  }

  function createOptionalMacro({
    functionDesc,
    evaluate,
    typeCheck,
    onHasValue,
    onEmpty,
  }: OptionalMacroSpec) {
    return ({ ast, args, receiver }: MacroInput): OptionalMacro => ({
      ast,
      functionDesc,
      receiver: expectDefined(receiver, 'optional macro receiver'),
      arg: expectDefined(args[0], 'optional macro argument'),
      evaluate,
      typeCheck,
      onHasValue,
      onEmpty,
    });
  }

  const invalidOrValueReceiver = 'optional.orValue() receiver';
  const invalidOrReceiver = 'optional.or(optional) receiver';
  const invalidOrArg = 'optional.or(optional) argument';
  registry.registerFunctionOverload(
    'optional.or(ast): optional<dyn>',
    createOptionalMacro({
      functionDesc: 'optional.or(optional)',
      evaluate: evaluateOptional,
      typeCheck(check, macro, ctx) {
        const l = ensureOptionalType(
          check,
          macro.receiver,
          ctx,
          invalidOrReceiver,
        );
        const r = ensureOptionalType(check, macro.arg, ctx, invalidOrArg);
        if (!(macro.receiver.maybeAsync || macro.arg.maybeAsync)) {
          macro.ast.setMeta('async', false);
        }

        const unified = l.unify(check.registry, r);
        if (unified) {
          return unified;
        }

        throw check.createError(
          'incompatible_argument_type',
          `${macro.functionDesc} argument must be compatible type, got '${l.name}' and '${r.name}'`,
          macro.arg,
        );
      },
      onHasValue: (optional) => optional,
      onEmpty(ev, macro, ctx) {
        const ast = macro.arg;
        const v = ev.run(ast, ctx);
        if (isPromise(v)) {
          return v.then((_v: unknown) => ensureOptional(_v, ast, invalidOrArg));
        }

        return ensureOptional(v, ast, invalidOrArg);
      },
    }),
  );

  registry.registerFunctionOverload(
    'optional.orValue(ast): dyn',
    createOptionalMacro({
      functionDesc: 'optional.orValue(value)',
      onHasValue: (optionalValue) => optionalValue.value(),
      onEmpty(ev, macro, ctx) {
        return ev.run(macro.arg, ctx);
      },
      evaluate: evaluateOptional,
      typeCheck(check, macro, ctx) {
        const l = expectDefined(
          ensureOptionalType(check, macro.receiver, ctx, invalidOrValueReceiver)
            .valueType,
          'optional value type',
        );
        const r = check.check(macro.arg, ctx);
        if (!(macro.receiver.maybeAsync || macro.arg.maybeAsync)) {
          macro.ast.setMeta('async', false);
        }

        const unified = l.unify(check.registry, r);
        if (unified) {
          return unified;
        }

        throw check.createError(
          'incompatible_argument_type',
          `${macro.functionDesc} argument must be compatible type, got '${l.name}' and '${r.name}'`,
          macro.arg,
        );
      },
    }),
  );
}
