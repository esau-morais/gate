import { createRegistry, RootContext } from './registry';
import type {
  ContextObject,
  DefinitionsResult,
  OperatorHandler,
  RegisterConstantDeclaration,
  RegisterFunctionDeclaration,
  RegisterFunctionMetadata,
  RegisterFunctionOptions,
  RegisteredFunctionHandler,
  RegisteredVariableType,
  RegisterOperatorOptions,
  RegisterTypeDeclaration,
  RegisterTypeDefinition,
  RegisterVariableDeclaration,
  RegisterVariableMetadata,
  RegisterVariableOptions,
  Registry,
  TypeDeclaration,
} from './registry';
import { evaluationError } from './errors';
import { registerFunctions, Duration, UnsignedInt } from './functions';
import { registerMacros } from './macros';
import { registerOverloads } from './overloads';
import { TypeChecker } from './type-checker';
import { Parser } from './parser';
import type { AnyNode } from './parser';
import { createOptions } from './options';
import type { EnvironmentOptions, ResolvedEnvironmentOptions } from './options';
import { Base } from './operators';
import type { BaseOptions } from './operators';
import { expectDefined, getProp, isPromise, isUnknownMap } from './globals';
import type { ASTNode, Context, ParseResult, TypeCheckResult } from './index';
import type { EvalContext } from './registry';

const globalRegistry = createRegistry({ enableOptionalTypes: false });
registerFunctions(globalRegistry);
registerOverloads(globalRegistry);
registerMacros(globalRegistry);

function toPublicAst(ast: AnyNode): ASTNode {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- the parser only produces public operators at the root and in arguments; internal operators live in macro metadata
  return ast as ASTNode;
}

/**
 * Environment for CEL expression evaluation with type checking and custom functions.
 *
 * @example
 * ```typescript
 * const env = new Environment()
 *   .registerVariable('name', 'string')
 *   .registerVariable('age', 'int')
 *   .registerFunction('double(int): int', (x: bigint) => x * 2n)
 *
 * const result = env.evaluate('double(age)', { age: 21n }) // 42n
 * ```
 */
class Environment {
  #registry: Registry;
  #evaluator: Evaluator;
  #typeChecker: TypeChecker;
  #evalTypeChecker: TypeChecker;
  #parser: Parser;
  /** The fully resolved options for this environment instance. */
  declare readonly opts: ResolvedEnvironmentOptions;

  /**
   * Create a new Environment with optional configuration.
   *
   * @param opts - Optional configuration options
   * @param inherited - The environment to copy registrations from; `clone` passes it
   */
  constructor(opts?: EnvironmentOptions, inherited?: Environment) {
    this.opts = createOptions(opts, inherited?.opts);
    this.#registry = (
      inherited instanceof Environment ? inherited.#registry : globalRegistry
    ).clone(this.opts);

    const childOpts = { registry: this.#registry, opts: this.opts };
    this.#typeChecker = new TypeChecker(childOpts);
    this.#evalTypeChecker = new TypeChecker(childOpts, true);
    this.#evaluator = new Evaluator(childOpts);
    this.#parser = new Parser(this.opts.limits, this.#registry);
    Object.freeze(this);
  }

  /**
   * Create a fast, isolated copy that stops the parent from registering more entries.
   *
   * @param opts - Optional configuration options
   * @returns A new environment
   */
  clone(opts?: EnvironmentOptions): Environment {
    return new Environment(opts, this);
  }

  /**
   * Register a custom function or method.
   *
   * Supports signature-based registration as well as a single declaration object.
   * @param signature - Function signature in format 'name(type1, type2): returnType' or 'Type.method(args): returnType'
   * @param handler - The function implementation
   * @param opts - Optional metadata such as descriptions, param docs, and async hints
   * @returns This environment for chaining
   */
  registerFunction(
    signature: string,
    handler: RegisteredFunctionHandler,
    opts?: RegisterFunctionMetadata,
  ): this;
  registerFunction(signature: string, options: RegisterFunctionOptions): this;
  registerFunction(definition: RegisterFunctionDeclaration): this;
  registerFunction(
    signature: string | RegisterFunctionDeclaration,
    handler?: RegisteredFunctionHandler | RegisterFunctionOptions,
    opts?: RegisterFunctionMetadata,
  ): this {
    this.#registry.registerFunctionOverload(signature, handler, opts);

    return this;
  }

  /**
   * Register a custom operator overload.
   *
   * @param string - Operator signature in format 'type1 op type2' (e.g., 'Vector + Vector')
   * @param handler - The operator implementation
   * @returns This environment for chaining
   */
  registerOperator(
    string: string,
    handler: OperatorHandler,
    opts?: RegisterOperatorOptions,
  ): this {
    this.#registry.registerOperatorOverload(string, handler, opts);

    return this;
  }

  /**
   * Register a custom type for use in expressions.
   *
   * @param typename - The name of the type (e.g., 'Vector', 'Point')
   * @param constructor - The type constructor or registration object
   * @returns This environment for chaining
   */
  registerType(typename: string, constructor: RegisterTypeDefinition): this;
  registerType(definition: RegisterTypeDeclaration): this;
  registerType(
    typename: string | RegisterTypeDeclaration,
    constructor?: RegisterTypeDefinition,
  ): this {
    this.#registry.registerType(typename, constructor);

    return this;
  }

  /**
   * Register a variable with its expected type.
   *
   * Supports `name + type`, `name + {type|schema}`, and a single declaration object.
   * @returns This environment for chaining
   * @throws Error if variable is already registered
   */
  registerVariable(
    name: string,
    type: RegisteredVariableType,
    opts?: RegisterVariableMetadata,
  ): this;
  registerVariable(name: string, options: RegisterVariableOptions): this;
  registerVariable(definition: RegisterVariableDeclaration): this;
  registerVariable(
    name: string | RegisterVariableDeclaration,
    type?: RegisteredVariableType | RegisterVariableOptions,
    opts?: RegisterVariableMetadata,
  ): this {
    this.#registry.registerVariable(name, type, opts);

    return this;
  }

  /**
   * Register a constant value that is always available in expressions without providing it via context.
   *
   * Supports `name + type + value` and a single declaration object.
   * @returns This environment for chaining further registrations
   */
  registerConstant(
    name: string,
    type: RegisteredVariableType,
    value: unknown,
  ): this;
  registerConstant(definition: RegisterConstantDeclaration): this;
  registerConstant(
    name: string | RegisterConstantDeclaration,
    type?: RegisteredVariableType,
    value?: unknown,
  ): this {
    this.#registry.registerConstant(name, type, value);

    return this;
  }

  /**
   * Check if a variable is registered in this environment.
   *
   * @param name - The variable name to check
   * @returns True if the variable is registered
   */
  hasVariable(name: string): boolean {
    return this.#registry.variables.has(name);
  }

  /**
   * Return user-facing definitions for all registered variables and functions,
   * including the built-ins inherited from the global environment.
   */
  getDefinitions(): DefinitionsResult {
    return this.#registry.getDefinitions();
  }

  /**
   * Type check a CEL expression without evaluating it.
   *
   * @param expression - The CEL expression string to check
   * @returns An object containing validation result and type information
   */
  check(expression: string): TypeCheckResult {
    try {
      return this.#checkAST(this.#parser.parse(expression));
    } catch (error) {
      return { valid: false, error };
    }
  }

  #checkAST(ast: AnyNode): TypeCheckResult {
    try {
      const typeDecl = this.#typeChecker.check(
        ast,
        new RootContext(this.#registry),
      );

      return { valid: true, type: this.#formatTypeForCheck(typeDecl) };
    } catch (error) {
      return { valid: false, error };
    }
  }

  #formatTypeForCheck(typeDecl: TypeDeclaration): string {
    if (typeDecl.name === `list<dyn>`) {
      return 'list';
    }

    if (typeDecl.name === `map<dyn, dyn>`) {
      return 'map';
    }

    return typeDecl.name;
  }

  /**
   * Parse a CEL expression and return a reusable evaluation function.
   *
   * @param expression - The CEL expression string to parse
   * @returns A function that can be called with context to evaluate the expression
   * @throws ParseError if the expression is syntactically invalid
   */
  parse(expression: string): ParseResult {
    const ast = this.#parser.parse(expression);
    const evaluateParsed = this.#evaluateAST.bind(this, ast);

    return Object.assign(evaluateParsed, {
      check: this.#checkAST.bind(this, ast),
      ast: toPublicAst(ast),
    });
  }

  /**
   * Evaluate a CEL expression with the given context.
   *
   * @param expression - The CEL expression string to evaluate
   * @param context - Optional context object for variable resolution
   * @returns The result of evaluating the expression
   * @throws ParseError if the expression syntax is invalid
   * @throws EvaluationError if evaluation fails
   */
  evaluate(expression: string, context?: Context): unknown {
    return this.#evaluateAST(this.#parser.parse(expression), context);
  }

  #evaluateAST(ast: AnyNode, context?: Context): unknown {
    if (ast.checkedType) {
      return ast.evaluate(
        this.#evaluator,
        ast,
        new RootContext(this.#registry, context),
      );
    } else {
      const ctx = new RootContext(this.#registry, context);
      this.#evalTypeChecker.check(ast, ctx);

      return ast.evaluate(this.#evaluator, ast, ctx);
    }
  }
}

class Evaluator extends Base {
  constructor(opts: BaseOptions) {
    super(opts);
    this.createError = evaluationError;
  }

  #firstMapElement(coll: unknown): readonly [unknown, unknown] | undefined {
    if (isUnknownMap(coll)) {
      return coll.entries().next().value;
    }

    if (coll === undefined || coll === null) {
      return undefined;
    }

    for (const key in coll) {
      return [key, getProp(coll, key)];
    }

    return undefined;
  }

  debugRuntimeType(
    value: unknown,
    checkedType?: TypeDeclaration,
  ): TypeDeclaration {
    return checkedType?.hasDynType === false
      ? checkedType
      : this.debugTypeDeep(value);
  }

  debugTypeDeep(value: unknown): TypeDeclaration {
    const runtimeType = this.debugType(value);
    switch (runtimeType.kind) {
      case 'list': {
        let first: unknown;
        if (value instanceof Array) {
          first = value[0];
        } else if (value instanceof Set) {
          first = value.values().next().value;
        }

        if (first === undefined) {
          return runtimeType;
        }

        return this.registry.getListType(this.debugTypeDeep(first));
      }
      case 'map': {
        const first = this.#firstMapElement(value);
        if (!first) {
          return runtimeType;
        }

        const keyType = expectDefined(runtimeType.keyType, 'map key type');
        const valueType = expectDefined(
          runtimeType.valueType,
          'map value type',
        );

        return this.registry.getMapType(
          keyType.hasDynType ? this.debugTypeDeep(first[0]) : keyType,
          valueType.hasDynType ? this.debugTypeDeep(first[1]) : valueType,
        );
      }
      case 'primitive':
      case 'message':
      case 'enum':
      case 'dyn':
      case 'optional':
      case 'param':
        return runtimeType;
    }
  }

  tryEval(ast: AnyNode, ctx: EvalContext): unknown {
    try {
      const res = this.run(ast, ctx);
      if (isPromise(res)) {
        return res.catch((err: unknown) => err);
      }

      return res;
    } catch (err) {
      return err;
    }
  }

  run(ast: AnyNode, ctx: EvalContext): unknown {
    return ast.evaluate(this, ast, ctx);
  }
}

export type { Evaluator };

const globalEnvironment = new Environment({
  unlistedVariablesAreDyn: true,
});

/**
 * Parse a CEL expression string into an evaluable function.
 *
 * @param expression - The CEL expression string to parse
 * @returns A function that can be called with context to evaluate the expression
 * @throws ParseError if the expression is syntactically invalid
 */
export function parse(expression: string): ParseResult {
  return globalEnvironment.parse(expression);
}

/**
 * Evaluate a CEL expression string directly.
 *
 * @param expression - The CEL expression string to evaluate
 * @param context - Optional context object for variable resolution
 * @returns The result of evaluating the expression
 * @throws ParseError if the expression syntax is invalid
 * @throws EvaluationError if evaluation fails
 */
export function evaluate(expression: string, context?: Context): unknown {
  return globalEnvironment.evaluate(expression, context);
}

/**
 * Type check a CEL expression string directly.
 *
 * @param expression - The CEL expression string to check
 * @returns Validation result with inferred type or error details
 */
export function check(expression: string): TypeCheckResult {
  return globalEnvironment.check(expression);
}

export { Duration, UnsignedInt, Environment };
export type { ContextObject };

export default {
  parse,
  evaluate,
  check,
  Environment,
  Duration,
  UnsignedInt,
};
