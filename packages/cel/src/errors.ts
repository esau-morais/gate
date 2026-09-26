import { truthy } from './globals';
import type { ASTOperator, LegacyAstTuple } from './index';
import type { AnyNode } from './parser';

export interface SourceRange {
  readonly start: number;
  readonly end: number;
}

export interface SourceLocation {
  /** Compatibility position used by existing consumers and error reporting. */
  readonly pos: number;
  /** The full source range start for this node or error anchor. */
  readonly start: number;
  /** The full source range end for this node or error anchor. */
  readonly end: number;
  /** The original CEL input string */
  readonly input?: string;
  /** The full source range for this node or error anchor. */
  readonly range?: SourceRange;
}

export interface ErrorLocation extends SourceLocation {
  /** Present when the error is attached to a parsed AST node. */
  readonly op?: ASTOperator;
  /** Present when the error is attached to a parsed AST node. */
  readonly args?: unknown;
  /** Present when the error is attached to a parsed AST node. */
  toOldStructure?(): LegacyAstTuple;
}

/** Errors attach either a plain location or a parsed node, including nodes created by macro expansion. */
export type ErrorNode = ErrorLocation | AnyNode;

export interface ErrorOptions {
  readonly code?: string | undefined;
  readonly message?: string | undefined;
  readonly node?: ErrorNode | undefined;
  readonly cause?: unknown;
  readonly range?: SourceRange | undefined;
}

interface CelErrorInit {
  name: string;
  code: string;
  message: string | undefined;
  node: ErrorNode | undefined;
  cause: unknown;
  range?: SourceRange | undefined;
}

interface RangeLike {
  readonly pos?: number;
  readonly start?: number;
  readonly end?: number;
}

class CelError extends Error {
  #node: ErrorNode | undefined;
  #code: string;
  #range: SourceRange | undefined;
  #summary: string | undefined;

  constructor({ name, code, message, node, cause, range }: CelErrorInit) {
    super(message, truthy(cause) ? { cause } : undefined);

    this.name = name;
    this.#code = code;

    this.#summary = message;
    this.#node = node;
    this.#range = (range && normalizeRange(range)) || normalizeRange(node);

    if (node === undefined) {
      return;
    }

    const input = node.input;
    if (input === undefined || input === '') {
      return;
    }

    setMessage(
      this,
      formatErrorWithHighlight(this.#summary, node, input, this.#range),
    );
  }

  get node(): ErrorNode | undefined {
    return this.#node;
  }

  get code(): string {
    return this.#code;
  }

  get range(): SourceRange | undefined {
    return this.#range;
  }

  get summary(): string | undefined {
    return this.#summary;
  }

  withAst(node: ErrorNode | undefined): this {
    if (this.#node || node === undefined) {
      return this;
    }

    const input = node.input;
    if (input === undefined || input === '') {
      return this;
    }

    this.#node = node;
    this.#range ??= normalizeRange(node);
    setMessage(
      this,
      formatErrorWithHighlight(this.#summary, node, input, this.#range),
    );

    return this;
  }
}

/** Assigns `message` like upstream, which can store undefined when the error has no summary or position. */
function setMessage(error: Error, message: string | undefined): void {
  Reflect.set(error, 'message', message);
}

function normalizeArgs(
  name: string,
  defaultCode: string,
  message: string | ErrorOptions,
  node: ErrorNode | undefined,
  cause: unknown,
): CelErrorInit {
  if (typeof message === 'string') {
    return { name, code: defaultCode, message, node, cause };
  }

  const opts = message;
  if (typeof opts !== 'object') {
    throw new Error('First param to error must be a string or object');
  }

  return {
    name,
    code: opts.code === undefined || opts.code === '' ? defaultCode : opts.code,
    message: opts.message,
    node: opts.node,
    cause: opts.cause,
    range: opts.range,
  };
}

/**
 * Error thrown during parsing when the CEL expression syntax is invalid.
 */
export class ParseError extends CelError {
  declare readonly name: 'ParseError';

  constructor(message: string, node?: ErrorNode, cause?: unknown);
  constructor(options: ErrorOptions);
  constructor(
    message: string | ErrorOptions,
    node?: ErrorNode,
    cause?: unknown,
  ) {
    super(normalizeArgs('ParseError', 'parse_error', message, node, cause));
  }
}

/**
 * Error thrown during evaluation when an error occurs while executing the CEL expression.
 */
export class EvaluationError extends CelError {
  declare readonly name: 'EvaluationError';

  constructor(message: string, node?: ErrorNode, cause?: unknown);
  constructor(options: ErrorOptions);
  constructor(
    message: string | ErrorOptions,
    node?: ErrorNode,
    cause?: unknown,
  ) {
    super(
      normalizeArgs(
        'EvaluationError',
        'evaluation_error',
        message,
        node,
        cause,
      ),
    );
  }
}

/**
 * Error thrown during type checking when a type error is detected in the expression.
 * The error message includes source position highlighting.
 */
export class TypeError extends CelError {
  declare readonly name: 'TypeError';

  constructor(message: string, node?: ErrorNode, cause?: unknown);
  constructor(options: ErrorOptions);
  constructor(
    message: string | ErrorOptions,
    node?: ErrorNode,
    cause?: unknown,
  ) {
    super(normalizeArgs('TypeError', 'type_error', message, node, cause));
  }
}

export type CreateError = {
  (options: ErrorOptions): Error;
  (code: string, message: string, node?: ErrorNode): Error;
};

export function parseError(options: ErrorOptions): ParseError;
export function parseError(
  code: string,
  message: string,
  node?: ErrorNode,
): ParseError;
export function parseError(
  code: string | ErrorOptions,
  message?: string,
  node?: ErrorNode,
): ParseError {
  if (typeof code === 'object') {
    return new ParseError(code);
  }

  return new ParseError({ code, message, node });
}

export function evaluationError(options: ErrorOptions): EvaluationError;
export function evaluationError(
  code: string,
  message: string,
  node?: ErrorNode,
): EvaluationError;
export function evaluationError(
  code: string | ErrorOptions,
  message?: string,
  node?: ErrorNode,
): EvaluationError {
  if (typeof code === 'object') {
    return new EvaluationError(code);
  }

  return new EvaluationError({ code, message, node });
}

export function typeError(options: ErrorOptions): TypeError;
export function typeError(
  code: string,
  message: string,
  node?: ErrorNode,
): TypeError;
export function typeError(
  code: string | ErrorOptions,
  message?: string,
  node?: ErrorNode,
): TypeError {
  if (typeof code === 'object') {
    return new TypeError(code);
  }

  return new TypeError({ code, message, node });
}

function normalizeRange(node: RangeLike | undefined): SourceRange | undefined {
  const start = node?.pos ?? node?.start;
  if (typeof start !== 'number') {
    return undefined;
  }

  const end = typeof node?.end === 'number' ? node.end : start;

  return { start, end };
}

function formatErrorWithHighlight(
  message: string | undefined,
  node: ErrorNode,
  input: string,
  range: SourceRange | undefined,
): string | undefined {
  const pos = node.pos ?? range?.start;
  if (typeof pos !== 'number') {
    return message;
  }

  let lineNum = 1;
  let currentPos = 0;
  let columnNum = 0;
  while (currentPos < pos) {
    if (input[currentPos] === '\n') {
      lineNum++;
      columnNum = 0;
    } else {
      columnNum++;
    }

    currentPos++;
  }

  let contextStart = pos;
  let contextEnd = pos;
  while (contextStart > 0 && input[contextStart - 1] !== '\n') {
    contextStart--;
  }

  while (contextEnd < input.length && input[contextEnd] !== '\n') {
    contextEnd++;
  }

  const line = input.slice(contextStart, contextEnd);
  const highlight = `> ${`${lineNum}`.padStart(4, ' ')} | ${line}\n${' '.repeat(9 + columnNum)}^`;

  return `${message}\n\n${highlight}`;
}

export function attachErrorAst(error: unknown, node: ErrorNode): unknown {
  if (error instanceof CelError) {
    return error.withAst(node);
  }

  return error;
}
