import { ParseError, EvaluationError, TypeError } from './errors';
import { parse, evaluate, check, Environment } from './evaluator';
import { serialize } from './serialize';
import { Optional } from './optional';
import type { UnsignedInt } from './functions';
import type { SourceLocation, SourceRange } from './errors';

/**
 * Represents a CEL expression AST node produced by the parser.
 * Each node stores its operator, operands, type metadata, and helpers for
 * evaluation/type-checking.
 */

export type BinaryOperator =
  '!=' | '==' | 'in' | '+' | '-' | '*' | '/' | '%' | '<' | '<=' | '>' | '>=';
export type UnaryOperator = '!_' | '-_';
export type AccessOperator = '.' | '.?' | '[]' | '[?]';
export type StructuralOperator =
  'value' | 'id' | 'call' | 'rcall' | 'list' | 'map' | '?:' | '||' | '&&';

type LiteralValue =
  string | number | bigint | boolean | null | Uint8Array | UnsignedInt;
type BinaryArgs = [ASTNode, ASTNode];
type MapEntry = [ASTNode, ASTNode];

interface ASTNodeArgsMap {
  value: LiteralValue;
  id: string;
  '.': [ASTNode, string];
  '.?': [ASTNode, string];
  '[]': BinaryArgs;
  '[?]': BinaryArgs;
  call: [string, ASTNode[]];
  rcall: [string, ASTNode, ASTNode[]];
  list: ASTNode[];
  map: MapEntry[];
  '?:': [ASTNode, ASTNode, ASTNode];
  '||': BinaryArgs;
  '&&': BinaryArgs;
  '!_': ASTNode;
  '-_': ASTNode;
}

type ASTNodeArgsMapWithBinary = ASTNodeArgsMap & {
  [K in BinaryOperator]: BinaryArgs;
};
export type ASTOperator = keyof ASTNodeArgsMapWithBinary;

type ASTNodeArgs<T extends ASTOperator> = ASTNodeArgsMapWithBinary[T];
export type LegacyAstTuple = [string, ...unknown[]];

export type {
  ErrorLocation,
  ErrorNode,
  ErrorOptions,
  SourceLocation,
  SourceRange,
} from './errors';

interface ASTNodeBase<T extends ASTOperator> extends SourceLocation {
  /** The original CEL input string for this parsed AST node. */
  readonly input: string;
  /** The full source range for this AST node. */
  readonly range: SourceRange;
  /** Operator for this node */
  readonly op: T;
  /** Operator-specific operand payload */
  readonly args: ASTNodeArgs<T>;
  /** Convert back to the historical tuple representation. */
  toOldStructure(): LegacyAstTuple;
}

export type ASTNode = {
  [K in ASTOperator]: ASTNodeBase<K>;
}[ASTOperator];

/**
 * Variables for evaluation, as a plain object or a Map.
 * Values can be any nested structure of primitive values, arrays, and objects.
 */
export type Context = Record<string, unknown> | Map<string, unknown>;

export type {
  DefinitionFunction,
  DefinitionFunctionParam,
  DefinitionsResult,
  DefinitionVariable,
  ObjectSchema,
  OperatorHandler,
  OverlayContext,
  RegisterConstantDeclaration,
  RegisterFunctionDeclaration,
  RegisterFunctionMetadata,
  RegisterFunctionOptions,
  RegisterFunctionWithName,
  RegisterFunctionWithSignature,
  RegisterOperatorOptions,
  RegisterTypeDeclaration,
  RegisterTypeDefinition,
  RegisteredFunctionHandler,
  RegisteredFunctionParam,
  RegisteredFunctionTypedParam,
  RegisteredType,
  RegisteredTypeFieldDeclaration,
  RegisteredVariableType,
  RegisterVariableDeclaration,
  RegisterVariableMetadata,
  RegisterVariableOptions,
  RegisterVariableSchemaOptions,
  RegisterVariableTypeOptions,
  RootContext,
  TypeConstructor,
  TypeDeclaration,
  ValueConverter,
} from './registry';

/**
 * Result of type checking an expression.
 */
export type TypeCheckResult =
  | {
      /** Whether the expression passed type checking */
      valid: true;
      /** The inferred type of the expression */
      type: string;
      error?: undefined;
    }
  | {
      valid: false;
      type?: undefined;
      /** Whatever parsing or type checking threw, usually a ParseError or TypeError */
      error: unknown;
    };

export type ParseResult = {
  (context?: Context): unknown;
  /** The parsed AST */
  ast: ASTNode;
  /** Type check the expression without evaluating it */
  check(): TypeCheckResult;
};

export type {
  EnvironmentOptions,
  Limits,
  ResolvedEnvironmentOptions,
} from './options';

export {
  parse,
  evaluate,
  check,
  Environment,
  ParseError,
  EvaluationError,
  TypeError,
  serialize,
  Optional,
};

/**
 * Default export containing all main functions and classes.
 */
export default {
  parse,
  evaluate,
  check,
  Environment,
  ParseError,
  EvaluationError,
  TypeError,
  serialize,
  Optional,
};
