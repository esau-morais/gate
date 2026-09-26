import { UnsignedInt } from './functions';
import { parseError } from './errors';
import { OPERATORS as OPS } from './operators';
import {
  MAX_INT,
  MIN_INT,
  RESERVED,
  expectDefined,
  getProp,
  isAsync,
  isUnknownArray,
  objEntries,
  truthy,
} from './globals';
import type { LegacyAstTuple } from './index';
import type { Limits } from './options';
import type {
  Candidates,
  EvalContext,
  FunctionDeclaration,
  OperatorDeclaration,
  OverlayContext,
  Registry,
  TypeDeclaration,
} from './registry';
import type { TypeChecker } from './type-checker';
import type { Evaluator } from './evaluator';

export type BinaryOp =
  '!=' | '==' | 'in' | '+' | '-' | '*' | '/' | '%' | '<' | '<=' | '>' | '>=';
export type FieldOp = '.' | '.?';
export type IndexOp = '[]' | '[?]';
export type LogicalOp = '||' | '&&';
export type UnaryOp = '!_' | '-_';

/**
 * Node kinds. Operators that share an argument shape share one kind, so a
 * node's `op` narrows `AnyNode` to the node type that carries its arguments.
 */
export type NodeKind =
  | 'value'
  | 'id'
  | FieldOp
  | IndexOp
  | 'call'
  | 'rcall'
  | 'list'
  | 'map'
  | '?:'
  | LogicalOp
  | UnaryOp
  | BinaryOp
  | 'comprehension'
  | 'accuValue'
  | 'accuInc'
  | 'accuPush';

export interface ComprehensionArgs {
  kind?: 'quantifier';
  errorsAreFatal: boolean;
  iterable: AnyNode;
  iterVarName: string;
  init: AnyNode;
  condition?: ((accu: unknown) => unknown) | undefined;
  step: AnyNode;
  result: (accu: unknown) => unknown;
  /** Set by type-checking. */
  iterCtx?: OverlayContext;
}

type BinaryArgs = [AnyNode, AnyNode];

type NodeArgs = {
  value: unknown;
  id: string;
  '.': [AnyNode, string];
  '.?': [AnyNode, string];
  '[]': BinaryArgs;
  '[?]': BinaryArgs;
  call: [string, AnyNode[]];
  rcall: [string, AnyNode, AnyNode[]];
  list: AnyNode[];
  map: [AnyNode, AnyNode][];
  '?:': [AnyNode, AnyNode, AnyNode];
  '!_': AnyNode;
  '-_': AnyNode;
  comprehension: ComprehensionArgs;
  accuValue: undefined;
  accuInc: undefined;
  accuPush: AnyNode;
} & Record<LogicalOp | BinaryOp, BinaryArgs>;

type When<K, Kinds, T> = [K] extends [Kinds] ? T : undefined;

type CandidatesFor<K> = [K] extends ['call' | 'rcall']
  ? Candidates<FunctionDeclaration>
  : When<K, UnaryOp | BinaryOp, Candidates<OperatorDeclaration>>;

type RightOperand<K> = [K] extends [FieldOp]
  ? string
  : When<K, IndexOp | BinaryOp | LogicalOp | '?:', AnyNode>;

interface HandleSignature {
  handle(a?: unknown, b?: unknown, c?: unknown, d?: unknown): unknown;
}

/**
 * The per-node evaluation callback chosen during type-checking. Its argument
 * order depends on the node kind; method-signature bivariance lets each kind
 * install a handler with its own parameter types.
 */
export type NodeHandle = HandleSignature['handle'] & {
  __asyncBoth?: NodeHandle;
  __asyncFirst?: NodeHandle;
  __handle?: NodeHandle;
};

/**
 * The operator definition stored on a node. Node kinds narrow the `ast`
 * parameter through method-signature bivariance; see `OperatorDef`.
 */
export interface NodeOperator<K extends NodeKind> {
  readonly name: K;
  check(
    this: void,
    chk: TypeChecker,
    ast: AnyNode,
    ctx: EvalContext,
  ): TypeDeclaration;
  evaluate(this: void, ev: Evaluator, ast: AnyNode, ctx: EvalContext): unknown;
}

export interface MacroObject {
  typeCheck(
    checker: TypeChecker,
    macro: MacroObject,
    ctx: EvalContext,
  ): TypeDeclaration;
  evaluate(ev: Evaluator, macro: MacroObject, ctx: EvalContext): unknown;
  async?: unknown;
  callAst?: AnyNode;
}

export interface MacroInput {
  ast: CallNode | RcallNode;
  args: AnyNode[];
  receiver: AnyNode | null;
  methodName: string;
  parser: Parser;
}

interface NodeMeta {
  check(chk: TypeChecker, ast: AnyNode, ctx: EvalContext): TypeDeclaration;
  evaluate(this: void, ev: Evaluator, ast: AnyNode, ctx: EvalContext): unknown;
  alternate?: AnyNode;
  macro?: MacroObject;
  async?: boolean;
  label?: string;
}

/**
 * A parsed node. Fields declared below `checkedType` are written by
 * type-checking; evaluation only runs on checked nodes.
 */
export class ASTNode<K extends NodeKind = NodeKind> {
  #meta: NodeMeta;
  #input: string;
  declare readonly op: K;
  declare args: NodeArgs[K];
  declare pos: number;
  declare start: number;
  declare end: number;
  declare checkedType?: TypeDeclaration;
  declare handle: NodeHandle;
  declare left: When<
    K,
    FieldOp | IndexOp | BinaryOp | LogicalOp | '?:',
    AnyNode
  >;
  declare right: RightOperand<K>;
  declare condition: When<K, '?:', AnyNode>;
  declare candidates: CandidatesFor<K>;
  declare argTypes: When<K, 'call' | 'rcall', TypeDeclaration[]>;
  declare receiverWithArgs: When<K, 'rcall', AnyNode[]>;
  declare leftStaticType?: TypeDeclaration;
  declare rightStaticType?: TypeDeclaration;

  constructor(
    input: string,
    pos: number,
    start: number,
    end: number,
    op: NodeOperator<K>,
    args: NodeArgs[K],
  ) {
    this.#meta = { check: op.check, evaluate: op.evaluate };
    this.#input = input;
    this.op = op.name;
    this.args = args;
    this.pos = pos;
    this.start = start;
    this.end = end;
  }

  clone<C extends NodeKind>(
    op: NodeOperator<C>,
    args: NodeArgs[C],
  ): ASTNode<C> {
    return new ASTNode(this.#input, this.pos, this.start, this.end, op, args);
  }

  get meta(): NodeMeta {
    return this.#meta;
  }

  get input(): string {
    return this.#input;
  }

  /**
   * Check whether we can optimize away async calling
   * If no ast members includes a function, we can optimize the call
   * for which we want to return true here.
   */
  get maybeAsync(): boolean {
    return (this.#meta.async ??= computeIsAsync(
      this.#meta.alternate ?? asAnyNode(this),
    ));
  }

  check(chk: TypeChecker, ast: AnyNode, ctx: EvalContext): TypeDeclaration {
    const meta = this.#meta;
    if (meta.alternate) {
      return chk.check(meta.alternate, ctx);
    } else if (meta.macro) {
      return meta.macro.typeCheck(chk, meta.macro, ctx);
    }

    return meta.check(chk, ast, ctx);
  }

  evaluate(ev: Evaluator, ast: AnyNode, ctx: EvalContext): unknown {
    const meta = this.#meta;
    if (meta.alternate) {
      this.evaluate = this.#evaluateAlternate;
    } else if (meta.macro) {
      this.evaluate = this.#evaluateMacro;
    } else {
      this.evaluate = meta.evaluate;
    }

    return this.evaluate(ev, ast, ctx);
  }

  #evaluateAlternate(ev: Evaluator, _ast: AnyNode, ctx: EvalContext): unknown {
    const alternate = expectDefined(this.#meta.alternate, 'macro alternate');

    return alternate.evaluate(ev, alternate, ctx);
  }

  #evaluateMacro(ev: Evaluator, _ast: AnyNode, ctx: EvalContext): unknown {
    const macro = expectDefined(this.#meta.macro, 'macro');

    return macro.evaluate(ev, macro, ctx);
  }

  setMeta<Key extends keyof NodeMeta>(
    key: Key,
    value: Required<NodeMeta>[Key],
  ): this {
    return ((this.#meta[key] = value), this);
  }

  get range(): { start: number; end: number } {
    return { start: this.start, end: this.end };
  }

  toOldStructure(): LegacyAstTuple {
    const args = isUnknownArray(this.args) ? this.args : [this.args];

    return [
      this.op,
      ...args.map((a) => (a instanceof ASTNode ? a.toOldStructure() : a)),
    ];
  }
}

export type ValueNode = ASTNode<'value'>;
export type IdNode = ASTNode<'id'>;
export type FieldNode = ASTNode<FieldOp>;
export type IndexNode = ASTNode<IndexOp>;
export type AccessNode = FieldNode | IndexNode;
export type CallNode = ASTNode<'call'>;
export type RcallNode = ASTNode<'rcall'>;
export type ListNode = ASTNode<'list'>;
export type MapNode = ASTNode<'map'>;
export type TernaryNode = ASTNode<'?:'>;
export type LogicalNode = ASTNode<LogicalOp>;
export type UnaryNode = ASTNode<UnaryOp>;
export type BinaryNode = ASTNode<BinaryOp>;
export type ComprehensionNode = ASTNode<'comprehension'>;
export type AccuValueNode = ASTNode<'accuValue'>;
export type AccuIncNode = ASTNode<'accuInc'>;
export type AccuPushNode = ASTNode<'accuPush'>;

export type AnyNode =
  | ValueNode
  | IdNode
  | FieldNode
  | IndexNode
  | CallNode
  | RcallNode
  | ListNode
  | MapNode
  | TernaryNode
  | LogicalNode
  | UnaryNode
  | BinaryNode
  | ComprehensionNode
  | AccuValueNode
  | AccuIncNode
  | AccuPushNode;

function asAnyNode(node: ASTNode): AnyNode {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- every ASTNode is constructed with an operator whose name is its kind, so it is one of the AnyNode members; TypeScript cannot narrow a generic `this`
  return node as AnyNode;
}

function computeIsAsync(ast: AnyNode): boolean {
  switch (ast.op) {
    case 'value':
    case 'id':
    case 'accuValue':
    case 'accuInc':
      return false;
    case 'accuPush':
      return ast.args.maybeAsync;
    case '!_':
    case '-_':
      if (ast.candidates?.async !== false) {
        return true;
      }

      return ast.args.maybeAsync;
    case '!=':
    case '==':
    case 'in':
    case '+':
    case '-':
    case '*':
    case '/':
    case '%':
    case '<':
    case '<=':
    case '>':
    case '>=':
      if (ast.candidates?.async !== false) {
        return true;
      }

      return ast.args.some((a) => a.maybeAsync);
    case 'call':
      if (ast.candidates?.async !== false) {
        return true;
      }

      return ast.args[1].some((a) => a.maybeAsync);
    case 'rcall':
      if (ast.candidates?.async !== false) {
        return true;
      }

      return ast.receiverWithArgs.some((a) => a.maybeAsync);
    case 'comprehension':
      return ast.args.iterable.maybeAsync || ast.args.step.maybeAsync;
    case '.':
    case '.?':
      return ast.args[0].maybeAsync;
    case '?:':
    case 'list':
    case '[]':
    case '[?]':
      return ast.args.some((a) => a.maybeAsync);
    case '||':
    case '&&':
      return ast.args.some((a) => a.maybeAsync);
    case 'map':
      return ast.args.some((a) => a[0].maybeAsync || a[1].maybeAsync);
  }
}

const TOKEN = {
  EOF: 0,
  NUMBER: 1,
  STRING: 2,
  BOOLEAN: 3,
  NULL: 4,
  IDENTIFIER: 5,
  PLUS: 6,
  MINUS: 7,
  MULTIPLY: 8,
  DIVIDE: 9,
  MODULO: 10,
  EQ: 11,
  NE: 12,
  LT: 13,
  LE: 14,
  GT: 15,
  GE: 16,
  AND: 17,
  OR: 18,
  NOT: 19,
  IN: 20,
  LPAREN: 21,
  RPAREN: 22,
  LBRACKET: 23,
  RBRACKET: 24,
  LBRACE: 25,
  RBRACE: 26,
  DOT: 27,
  COMMA: 28,
  COLON: 29,
  QUESTION: 30,
  BYTES: 31,
};

const OP_FOR_TOKEN: Readonly<Record<number, NodeOperator<BinaryOp>>> = {
  [TOKEN.EQ]: OPS['=='],
  [TOKEN.PLUS]: OPS['+'],
  [TOKEN.MINUS]: OPS['-'],
  [TOKEN.MULTIPLY]: OPS['*'],
  [TOKEN.DIVIDE]: OPS['/'],
  [TOKEN.MODULO]: OPS['%'],
  [TOKEN.LE]: OPS['<='],
  [TOKEN.LT]: OPS['<'],
  [TOKEN.GE]: OPS['>='],
  [TOKEN.GT]: OPS['>'],
  [TOKEN.NE]: OPS['!='],
  [TOKEN.IN]: OPS.in,
};

const TOKEN_BY_NUMBER: Record<number, string> = {};
for (const [key, value] of objEntries(TOKEN)) {
  TOKEN_BY_NUMBER[value] = key;
}

const utf8Encoder = new TextEncoder();

function utf8ByteString(str: string): string {
  let out = '';
  for (const byte of utf8Encoder.encode(str)) {
    out += String.fromCharCode(byte);
  }

  return out;
}

const HEX_CODES = new Uint8Array(128);
for (const ch of '0123456789abcdefABCDEF') {
  HEX_CODES[ch.charCodeAt(0)] = 1;
}

const ESCAPE_ERRORS = {
  bytes_unicode_escape: (e?: string) => `\\${e} not allowed in bytes literals`,
  invalid_unicode_escape: (e?: string) => `Invalid Unicode escape: \\${e}`,
  invalid_unicode_surrogate: (e?: string) =>
    `Invalid Unicode surrogate: \\${e}`,
  invalid_hex_escape: (e?: string) => `Invalid hex escape: \\${e}`,
  invalid_octal_escape: () => 'Octal escape must be 3 digits',
  octal_escape_out_of_range: (e?: string) =>
    `Octal escape out of range: \\${e}`,
  invalid_escape_sequence: (e?: string) => `Invalid escape sequence: \\${e}`,
};

type EscapeErrorCode = keyof typeof ESCAPE_ERRORS;

const STRING_ESCAPES: Readonly<Record<string, string>> = {
  '\\': '\\',
  '?': '?',
  '"': '"',
  "'": "'",
  '`': '`',
  a: '\x07',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
};

class Lexer {
  input = '';
  pos = 0;
  length = 0;

  tokenPos = 0;
  tokenType = TOKEN.EOF;
  tokenValue: unknown;

  reset(input: string): string {
    this.pos = 0;
    this.input = input;
    this.length = input.length;

    return input;
  }

  token(pos: number, type: number, value?: unknown): this {
    this.tokenPos = pos;
    this.tokenType = type;
    this.tokenValue = value;

    return this;
  }

  // Read next token
  nextToken(): this {
    while (true) {
      const { pos, input, length } = this;
      if (pos >= length) {
        return this.token(pos, TOKEN.EOF);
      }

      const ch = input[pos];
      switch (ch) {
        // Whitespaces
        case ' ':
        case '\t':
        case '\n':
        case '\r':
          this.pos++;
          continue;

        // Operators
        case '=':
          if (input[pos + 1] !== '=') {
            break;
          }

          return this.token((this.pos += 2) - 2, TOKEN.EQ);
        case '&':
          if (input[pos + 1] !== '&') {
            break;
          }

          return this.token((this.pos += 2) - 2, TOKEN.AND);
        case '|':
          if (input[pos + 1] !== '|') {
            break;
          }

          return this.token((this.pos += 2) - 2, TOKEN.OR);
        case '+':
          return this.token(this.pos++, TOKEN.PLUS);
        case '-':
          return this.token(this.pos++, TOKEN.MINUS);
        case '*':
          return this.token(this.pos++, TOKEN.MULTIPLY);
        case '/':
          if (input[pos + 1] === '/') {
            while (this.pos < length && this.input[this.pos] !== '\n') {
              this.pos++;
            }

            continue;
          }

          return this.token(this.pos++, TOKEN.DIVIDE);
        case '%':
          return this.token(this.pos++, TOKEN.MODULO);
        case '<':
          if (input[pos + 1] === '=') {
            return this.token((this.pos += 2) - 2, TOKEN.LE);
          }

          return this.token(this.pos++, TOKEN.LT);
        case '>':
          if (input[pos + 1] === '=') {
            return this.token((this.pos += 2) - 2, TOKEN.GE);
          }

          return this.token(this.pos++, TOKEN.GT);
        case '!':
          if (input[pos + 1] === '=') {
            return this.token((this.pos += 2) - 2, TOKEN.NE);
          }

          return this.token(this.pos++, TOKEN.NOT);
        case '(':
          return this.token(this.pos++, TOKEN.LPAREN);
        case ')':
          return this.token(this.pos++, TOKEN.RPAREN);
        case '[':
          return this.token(this.pos++, TOKEN.LBRACKET);
        case ']':
          return this.token(this.pos++, TOKEN.RBRACKET);
        case '{':
          return this.token(this.pos++, TOKEN.LBRACE);
        case '}':
          return this.token(this.pos++, TOKEN.RBRACE);
        case '.':
          return this.token(this.pos++, TOKEN.DOT);
        case ',':
          return this.token(this.pos++, TOKEN.COMMA);
        case ':':
          return this.token(this.pos++, TOKEN.COLON);
        case '?':
          return this.token(this.pos++, TOKEN.QUESTION);
        case `"`:
        case `'`:
          return this.readString(ch);
        // Check for string prefixes (b, B, r, R followed by quote)
        case 'b':
        case 'B':
        case 'r':
        case 'R': {
          // This is a prefixed string, advance past the prefix and read string
          const next = input[pos + 1];
          if (next === '"' || next === "'") {
            ++this.pos;

            return this.readString(next, ch);
          }

          return this.readIdentifier();
        }
        case undefined:
        default: {
          const code = input.charCodeAt(pos);
          if (code <= 57 && code >= 48) {
            return this.readNumber();
          }

          if (this._isIdentifierCharCode(code)) {
            return this.readIdentifier();
          }
        }
      }

      throw parseError('unexpected_character', `Unexpected character: ${ch}`, {
        pos,
        start: pos,
        end: pos + 1,
        input,
      });
    }
  }

  // Characters: 0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_
  _isIdentifierCharCode(c: number): boolean {
    if (c < 48 || c > 122) {
      return false;
    }

    return c >= 97 || (c >= 65 && c <= 90) || c <= 57 || c === 95;
  }

  _parseAsDouble(start: number, end: number): this {
    const value = Number(this.input.substring(start, end));
    if (Number.isFinite(value)) {
      return this.token(start, TOKEN.NUMBER, value);
    }

    throw parseError('invalid_number', `Invalid number: ${value}`, {
      pos: start,
      start,
      end,
      input: this.input,
    });
  }

  _parseAsBigInt(
    start: number,
    end: number,
    isHex: boolean,
    unsigned: string | undefined,
  ): this {
    const string = this.input.substring(start, end);
    if (unsigned === 'u' || unsigned === 'U') {
      this.pos++;
      try {
        return this.token(start, TOKEN.NUMBER, new UnsignedInt(string));
      } catch {
        // fall through to the parse error below
      }
    } else {
      try {
        return this.token(start, TOKEN.NUMBER, BigInt(string));
      } catch {
        // fall through to the parse error below
      }
    }

    throw parseError(
      isHex ? 'invalid_hex_integer' : 'invalid_integer',
      isHex ? `Invalid hex integer: ${string}` : `Invalid integer: ${string}`,
      { pos: start, start, end: this.pos, input: this.input },
    );
  }

  _readDigits(input: string, length: number, pos: number): number {
    let code: number;
    while (
      pos < length &&
      (code = input.charCodeAt(pos)) !== 0 &&
      !(code > 57 || code < 48)
    ) {
      pos++;
    }

    return pos;
  }

  _readExponent(input: string, length: number, pos: number): number {
    let ch = pos < length && input[pos];
    if (ch === 'e' || ch === 'E') {
      ch = ++pos < length && input[pos];
      if (ch === '-' || ch === '+') {
        pos++;
      }

      const start = pos;
      pos = this._readDigits(input, length, pos);
      if (start === pos) {
        throw parseError('invalid_exponent', 'Invalid exponent', {
          pos,
          start: pos,
          end: Math.min(pos + 1, input.length),
          input,
        });
      }
    }

    return pos;
  }

  readNumber(): this {
    const { input, length, pos: start } = this;
    let pos = start;
    if (
      input[pos] === '0' &&
      (input[pos + 1] === 'x' || input[pos + 1] === 'X')
    ) {
      pos += 2;
      while (pos < length && HEX_CODES[input.charCodeAt(pos)] === 1) {
        pos++;
      }

      return this._parseAsBigInt(start, (this.pos = pos), true, input[pos]);
    }

    pos = this._readDigits(input, length, pos);
    if (pos + 1 < length) {
      let isDouble = false;
      let afterpos =
        input[pos] === '.' ? this._readDigits(input, length, pos + 1) : pos + 1;
      if (afterpos !== pos + 1) {
        isDouble = true;
        pos = afterpos;
      }

      afterpos = this._readExponent(input, length, pos);
      if (afterpos !== pos) {
        isDouble = true;
        pos = afterpos;
      }

      if (isDouble) {
        return this._parseAsDouble(start, (this.pos = pos));
      }
    }

    return this._parseAsBigInt(start, (this.pos = pos), false, input[pos]);
  }

  readString(del: string, prefix?: string): this {
    const { input: i, pos: s } = this;
    if (i[s + 1] === del && i[s + 2] === del) {
      return this.readTripleQuotedString(del, prefix);
    }

    return this.readSingleQuotedString(del, prefix);
  }

  _closeQuotedString(
    rawStart: number,
    rawValue: string,
    prefix: string | undefined,
    pos: number,
  ): this {
    switch (prefix) {
      case 'b':
      case 'B': {
        const processed = this.processEscapes(rawStart, rawValue, true);
        const bytes = new Uint8Array(processed.length);
        for (let i = 0; i < processed.length; i++) {
          bytes[i] = processed.charCodeAt(i) & 0xff;
        }

        return this.token(pos - 1, TOKEN.BYTES, bytes);
      }
      case 'r':
      case 'R': {
        return this.token(pos - 1, TOKEN.STRING, rawValue);
      }
      case undefined:
      default: {
        const value = this.processEscapes(rawStart, rawValue, false);

        return this.token(pos, TOKEN.STRING, value);
      }
    }
  }

  readSingleQuotedString(delimiter: string, prefix: string | undefined): this {
    const { input, length, pos: start } = this;

    let ch: string | undefined;
    let pos = this.pos + 1;
    while (pos < length && (ch = input[pos]) !== undefined) {
      switch (ch) {
        case delimiter: {
          const rawStart = start + 1;
          const rawValue = input.slice(rawStart, pos);
          this.pos = pos + 1;

          return this._closeQuotedString(rawStart, rawValue, prefix, start);
        }
        case '\n':
        case '\r':
          throw parseError(
            'newline_in_string',
            'Newlines not allowed in single-quoted strings',
            {
              pos,
              start: pos,
              end: pos + 1,
              input,
            },
          );
        case '\\':
          pos++;
      }

      pos++;
    }

    throw parseError('unterminated_string', 'Unterminated string', {
      pos: start,
      start,
      end: input.length,
      input,
    });
  }

  readTripleQuotedString(delimiter: string, prefix: string | undefined): this {
    const { input, length, pos: start } = this;

    let ch: string | undefined;
    let pos = this.pos + 3;
    while (pos < length && (ch = input[pos]) !== undefined) {
      switch (ch) {
        case delimiter:
          if (input[pos + 1] === delimiter && input[pos + 2] === delimiter) {
            const rawStart = start + 3;
            const rawValue = input.slice(rawStart, pos);
            this.pos = pos + 3;

            return this._closeQuotedString(rawStart, rawValue, prefix, start);
          }

          break;
        case '\\':
          pos++;
      }

      pos++;
    }

    throw parseError(
      'unterminated_triple_quoted_string',
      'Unterminated triple-quoted string',
      {
        pos: start,
        start,
        end: input.length,
        input,
      },
    );
  }

  #escapeErr(
    code: EscapeErrorCode,
    offset: number,
    len: number,
    i: number,
    chars: number,
    extra?: string,
  ): Error {
    const start = offset + i;

    return parseError(code, ESCAPE_ERRORS[code](extra), {
      input: this.input,
      pos: start,
      start,
      end: Math.min(start + chars, offset + len),
    });
  }

  /** In bytes mode, the result holds one byte per char, and unescaped text becomes its UTF-8 bytes. */
  processEscapes(offset: number, str: string, isBytes: boolean): string {
    if (!str.includes('\\')) {
      return isBytes ? utf8ByteString(str) : str;
    }

    const len = str.length;
    let result = '';
    let i = 0;
    while (i < len) {
      if (str[i] !== '\\' || i + 1 >= len) {
        if (isBytes) {
          const next = str.indexOf('\\', i + 1);
          const end = next === -1 ? len : next;
          result += utf8ByteString(str.slice(i, end));
          i = end;
        } else {
          result += str.charAt(i++);
        }

        continue;
      }

      const next = str.charAt(i + 1);
      const escaped = STRING_ESCAPES[next];
      if (escaped !== undefined) {
        result += escaped;
        i += 2;
      } else if (next === 'u' || next === 'U') {
        if (isBytes) {
          throw this.#escapeErr(
            'bytes_unicode_escape',
            offset,
            len,
            i,
            2,
            next,
          );
        }

        const hexLen = next === 'u' ? 4 : 8;
        const hex = str.substring(i + 2, i + 2 + hexLen);
        const c = Number.parseInt(hex, 16);
        if (
          hex.length !== hexLen ||
          !/^[0-9a-fA-F]+$/.test(hex) ||
          c > 0x10ffff
        ) {
          throw this.#escapeErr(
            'invalid_unicode_escape',
            offset,
            len,
            i,
            2 + hexLen,
            next + hex,
          );
        }

        if (c >= 0xd800 && c <= 0xdfff) {
          throw this.#escapeErr(
            'invalid_unicode_surrogate',
            offset,
            len,
            i,
            2 + hexLen,
            next + hex,
          );
        }

        result += String.fromCodePoint(c);
        i += 2 + hexLen;
      } else if (next === 'x' || next === 'X') {
        const h = str.substring(i + 2, i + 4);
        if (!/^[0-9a-fA-F]{2}$/.test(h)) {
          throw this.#escapeErr(
            'invalid_hex_escape',
            offset,
            len,
            i,
            4,
            next + h,
          );
        }

        result += String.fromCharCode(Number.parseInt(h, 16));
        i += 4;
      } else if (next >= '0' && next <= '7') {
        const o = str.substring(i + 1, i + 4);
        if (!/^[0-7]{3}$/.test(o)) {
          throw this.#escapeErr('invalid_octal_escape', offset, len, i, 4);
        }

        const value = Number.parseInt(o, 8);
        if (value > 0xff) {
          throw this.#escapeErr(
            'octal_escape_out_of_range',
            offset,
            len,
            i,
            4,
            o,
          );
        }

        result += String.fromCharCode(value);
        i += 4;
      } else {
        throw this.#escapeErr(
          'invalid_escape_sequence',
          offset,
          len,
          i,
          2,
          next,
        );
      }
    }

    return result;
  }

  readIdentifier(): this {
    const { pos, input, length } = this;
    let p = pos;
    while (p < length && this._isIdentifierCharCode(input.charCodeAt(p))) {
      p++;
    }

    const value = input.substring(pos, (this.pos = p));
    switch (value) {
      case 'true':
        return this.token(pos, TOKEN.BOOLEAN, true);
      case 'false':
        return this.token(pos, TOKEN.BOOLEAN, false);
      case 'null':
        return this.token(pos, TOKEN.NULL, null);
      case 'in':
        return this.token(pos, TOKEN.IN);
      default:
        return this.token(pos, TOKEN.IDENTIFIER, value);
    }
  }
}

/** Identifier tokens always carry their text; this recovers the type after `consume` checked the token. */
function identifierText(value: unknown): string {
  if (typeof value !== 'string') {
    throw new TypeError('Identifier token without text');
  }

  return value;
}

const globalLexer = new Lexer();
export class Parser {
  lexer = globalLexer;
  input = '';
  maxDepthRemaining = 0;
  astNodesRemaining = 0;

  type = TOKEN.EOF;
  pos = 0;
  #negated = false;

  declare readonly limits: Readonly<Limits>;
  declare readonly registry: Registry;

  constructor(limits: Readonly<Limits>, registry: Registry) {
    this.limits = limits;
    this.registry = registry;
  }

  #limitExceeded(limitKey: keyof Limits, pos = this.pos): never {
    throw parseError(
      'limit_exceeded',
      `Exceeded ${limitKey} (${this.limits[limitKey]})`,
      {
        pos,
        start: pos,
        end: pos,
        input: this.input,
      },
    );
  }

  #node<K extends NodeKind>(
    start: number,
    end: number,
    op: NodeOperator<K>,
    args: NodeArgs[K],
    pos = start,
  ): ASTNode<K> {
    const node = new ASTNode(this.input, pos, start, end, op, args);
    if (!truthy(this.astNodesRemaining--)) {
      this.#limitExceeded('maxAstNodes', pos);
    }

    return node;
  }

  #infixNode(
    op: NodeOperator<BinaryOp>,
    left: AnyNode,
    right: AnyNode,
  ): BinaryNode {
    return this.#node(left.start, right.end, op, [left, right]);
  }

  #logicalNode(
    op: NodeOperator<LogicalOp>,
    left: AnyNode,
    right: AnyNode,
  ): LogicalNode {
    return this.#node(left.start, right.end, op, [left, right]);
  }

  #ternaryNode(
    expression: AnyNode,
    consequent: AnyNode,
    alternate: AnyNode,
  ): TernaryNode {
    return this.#node(expression.start, alternate.end, OPS.ternary, [
      expression,
      consequent,
      alternate,
    ]);
  }

  #unaryNode(pos: number, op: NodeOperator<UnaryOp>, arg: AnyNode): UnaryNode {
    return this.#node(pos, arg.end, op, arg);
  }

  #advanceToken(): number;
  #advanceToken<T>(returnValue: T): T;
  #advanceToken(returnValue: unknown = this.pos): unknown {
    const l = this.lexer.nextToken();
    this.pos = l.tokenPos;
    this.type = l.tokenType;

    return returnValue;
  }

  // The value of the current token is accessed less regularly,
  // so we use a getter to reduce assignment overhead
  get value(): unknown {
    return this.lexer.tokenValue;
  }

  consume(expectedType: number): number {
    if (this.type === expectedType) {
      return this.#advanceToken();
    }

    throw parseError(
      'expected_token',
      `Expected ${TOKEN_BY_NUMBER[expectedType]}, got ${TOKEN_BY_NUMBER[this.type]}`,
      {
        pos: this.pos,
        start: this.pos,
        end: this.lexer.pos,
        input: this.input,
      },
    );
  }

  match(type: number): boolean {
    return this.type === type;
  }

  // Parse entry point
  parse(input: string): AnyNode {
    if (typeof input !== 'string') {
      throw parseError(
        'expression_must_be_string',
        'Expression must be a string',
      );
    }

    this.input = this.lexer.reset(input);
    this.#advanceToken();
    this.maxDepthRemaining = this.limits.maxDepth;
    this.astNodesRemaining = this.limits.maxAstNodes;

    const result = this.parseExpression();
    if (this.match(TOKEN.EOF)) {
      return result;
    }

    throw parseError(
      'unexpected_character',
      `Unexpected character: '${this.input[this.lexer.pos - 1]}'`,
      {
        pos: this.pos,
        start: this.pos,
        end: this.lexer.pos,
        input: this.input,
      },
    );
  }

  #expandMacro(ast: CallNode | RcallNode): AnyNode {
    const methodName = ast.args[0];
    const receiver = ast.op === 'rcall' ? ast.args[1] : null;
    const fnArgs = ast.op === 'rcall' ? ast.args[2] : ast.args[1];
    const decl = this.registry.findMacro(
      methodName,
      receiver !== null,
      fnArgs.length,
    );
    if (decl === false) {
      return ast;
    }

    const input: MacroInput = {
      ast,
      args: fnArgs,
      receiver,
      methodName,
      parser: this,
    };
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- macro handlers are wrapped by wrapMacroExpander, which rejects results without callAst or evaluate/typeCheck
    const macro = decl.handler(input) as MacroObject;
    if (macro.callAst) {
      return ast.setMeta('alternate', macro.callAst);
    }

    return ast
      .setMeta('macro', macro)
      .setMeta('async', isAsync(getProp(macro, 'evaluate'), macro.async));
  }

  // Expression ::= LogicalOr ('?' Expression ':' Expression)?
  parseExpression(): AnyNode {
    if (!truthy(this.maxDepthRemaining--)) {
      this.#limitExceeded('maxDepth');
    }

    const expr = this.parseLogicalOr();
    if (!this.match(TOKEN.QUESTION)) {
      ++this.maxDepthRemaining;

      return expr;
    }

    this.#advanceToken();
    const consequent = this.parseExpression();
    this.consume(TOKEN.COLON);
    const alternate = this.parseExpression();
    this.maxDepthRemaining++;

    return this.#ternaryNode(expr, consequent, alternate);
  }

  // LogicalOr ::= LogicalAnd ('||' LogicalAnd)*
  parseLogicalOr(): AnyNode {
    let expr = this.parseLogicalAnd();
    while (this.match(TOKEN.OR)) {
      this.#advanceToken();
      expr = this.#logicalNode(OPS['||'], expr, this.parseLogicalAnd());
    }

    return expr;
  }

  // LogicalAnd ::= Equality ('&&' Equality)*
  parseLogicalAnd(): AnyNode {
    let expr = this.parseEquality();
    while (this.match(TOKEN.AND)) {
      this.#advanceToken();
      expr = this.#logicalNode(OPS['&&'], expr, this.parseEquality());
    }

    return expr;
  }

  #binaryOperator(): NodeOperator<BinaryOp> {
    return expectDefined(OP_FOR_TOKEN[this.type], 'binary operator');
  }

  // Equality ::= Relational (('==' | '!=') Relational)*
  parseEquality(): AnyNode {
    let expr = this.parseRelational();
    while (this.match(TOKEN.EQ) || this.match(TOKEN.NE)) {
      const op = this.#binaryOperator();
      this.#advanceToken();
      expr = this.#infixNode(op, expr, this.parseRelational());
    }

    return expr;
  }

  // Relational ::= Additive (('<' | '<=' | '>' | '>=' | 'in') Additive)*
  parseRelational(): AnyNode {
    let expr = this.parseAdditive();
    while (
      this.match(TOKEN.LT) ||
      this.match(TOKEN.LE) ||
      this.match(TOKEN.GT) ||
      this.match(TOKEN.GE) ||
      this.match(TOKEN.IN)
    ) {
      const op = this.#binaryOperator();
      this.#advanceToken();
      expr = this.#infixNode(op, expr, this.parseAdditive());
    }

    return expr;
  }

  // Additive ::= Multiplicative (('+' | '-') Multiplicative)*
  parseAdditive(): AnyNode {
    let expr = this.parseMultiplicative();
    while (this.match(TOKEN.PLUS) || this.match(TOKEN.MINUS)) {
      const op = this.#binaryOperator();
      this.#advanceToken();
      expr = this.#infixNode(op, expr, this.parseMultiplicative());
    }

    return expr;
  }

  // Multiplicative ::= Unary (('*' | '/' | '%') Unary)*
  parseMultiplicative(): AnyNode {
    let expr = this.parseUnary();
    while (
      this.match(TOKEN.MULTIPLY) ||
      this.match(TOKEN.DIVIDE) ||
      this.match(TOKEN.MODULO)
    ) {
      const op = this.#binaryOperator();
      this.#advanceToken();
      expr = this.#infixNode(op, expr, this.parseUnary());
    }

    return expr;
  }

  // Unary ::= ('!' | '-')* Postfix
  parseUnary(): AnyNode {
    if (this.type === TOKEN.NOT) {
      this.#negated = false;

      return this.#unaryNode(
        this.#advanceToken(),
        OPS.unaryNot,
        this.parseUnary(),
      );
    }

    if (this.type === TOKEN.MINUS) {
      const pos = this.#advanceToken();
      this.#negated = true;

      return this.#unaryNode(pos, OPS.unaryMinus, this.parseUnary());
    }

    return this.parsePostfix();
  }

  // Postfix ::= Primary (('.' IDENTIFIER ('(' ArgumentList ')')? | '[' Expression ']'))*
  parsePostfix(): AnyNode {
    let expr = this.parsePrimary();
    const depth = this.maxDepthRemaining;
    while (true) {
      if (this.match(TOKEN.DOT)) {
        const dot = this.#advanceToken();
        if (!truthy(this.maxDepthRemaining--)) {
          this.#limitExceeded('maxDepth', dot);
        }

        const op =
          this.match(TOKEN.QUESTION) &&
          this.registry.enableOptionalTypes &&
          truthy(this.#advanceToken())
            ? OPS.optionalFieldAccess
            : OPS.fieldAccess;

        const propertyValue = this.value;
        const start = this.pos;
        const end = this.lexer.pos;
        this.consume(TOKEN.IDENTIFIER);
        const property = identifierText(propertyValue);
        if (
          op === OPS.fieldAccess &&
          this.match(TOKEN.LPAREN) &&
          truthy(this.#advanceToken())
        ) {
          const args = this.parseArgumentList();
          const closeEnd = this.lexer.pos;
          this.consume(TOKEN.RPAREN);
          expr = this.#expandMacro(
            this.#node(expr.start, closeEnd, OPS.rcall, [property, expr, args]),
          );
        } else {
          expr = this.#node(expr.start, end, op, [expr, property], start);
        }

        continue;
      }

      if (this.match(TOKEN.LBRACKET)) {
        const bracket = this.#advanceToken();
        if (!truthy(this.maxDepthRemaining--)) {
          this.#limitExceeded('maxDepth', bracket);
        }

        const op =
          this.match(TOKEN.QUESTION) &&
          this.registry.enableOptionalTypes &&
          truthy(this.#advanceToken())
            ? OPS.optionalBracketAccess
            : OPS.bracketAccess;

        const index = this.parseExpression();
        const closeEnd = this.lexer.pos;
        this.consume(TOKEN.RBRACKET);
        expr = this.#node(expr.start, closeEnd, op, [expr, index]);
        continue;
      }

      break;
    }

    this.maxDepthRemaining = depth;

    return expr;
  }

  // Primary ::= NUMBER | STRING | BOOLEAN | NULL | IDENTIFIER | '(' Expression ')' | Array | Object
  parsePrimary(): AnyNode {
    const negated = this.#negated;
    this.#negated = false;
    switch (this.type) {
      case TOKEN.NUMBER:
        return this.#consumeNumber(negated);
      case TOKEN.STRING:
      case TOKEN.BYTES:
      case TOKEN.BOOLEAN:
      case TOKEN.NULL:
        return this.#consumeLiteral();
      case TOKEN.IDENTIFIER:
        return this.#parseIdentifierPrimary();
      case TOKEN.LPAREN:
        return this.#parseParenthesizedExpression();
      case TOKEN.LBRACKET:
        return this.parseList();
      case TOKEN.LBRACE:
        return this.parseMap();
    }

    throw parseError(
      'unexpected_token',
      `Unexpected token: ${TOKEN_BY_NUMBER[this.type]}`,
      {
        pos: this.pos,
        start: this.pos,
        end: this.lexer.pos,
        input: this.input,
      },
    );
  }

  // Only `-9223372036854775808` may exceed MAX_INT, because the minus sign is part of the literal.
  #consumeNumber(negated: boolean): ValueNode {
    const value = this.value;
    if (
      typeof value === 'bigint' &&
      value > MAX_INT &&
      !(negated && value === -MIN_INT)
    ) {
      throw parseError('invalid_integer', `Invalid integer: ${value}`, {
        pos: this.pos,
        start: this.pos,
        end: this.lexer.pos,
        input: this.input,
      });
    }

    return this.#consumeLiteral();
  }

  #consumeLiteral(): ValueNode {
    return this.#advanceToken(
      this.#node(this.pos, this.lexer.pos, OPS.value, this.value),
    );
  }

  #parseIdentifierPrimary(): AnyNode {
    const token = this.value;
    const end = this.lexer.pos;
    const start = this.consume(TOKEN.IDENTIFIER);
    const value = identifierText(token);
    if (RESERVED.has(value)) {
      throw parseError('reserved_identifier', `Reserved identifier: ${value}`, {
        pos: start,
        start,
        end,
        input: this.input,
      });
    }

    if (!this.match(TOKEN.LPAREN)) {
      return this.#node(start, end, OPS.id, value);
    }

    this.#advanceToken();
    const args = this.parseArgumentList();
    const closeEnd = this.lexer.pos;
    this.consume(TOKEN.RPAREN);

    return this.#expandMacro(
      this.#node(start, closeEnd, OPS.call, [value, args]),
    );
  }

  #parseParenthesizedExpression(): AnyNode {
    this.consume(TOKEN.LPAREN);
    const expr = this.parseExpression();
    this.consume(TOKEN.RPAREN);

    return expr;
  }

  parseList(): ListNode {
    const start = this.consume(TOKEN.LBRACKET);
    const elements: AnyNode[] = [];
    let remainingElements = this.limits.maxListElements;

    if (!this.match(TOKEN.RBRACKET)) {
      const first = this.parseExpression();
      elements.push(first);
      if (!truthy(remainingElements--)) {
        this.#limitExceeded('maxListElements', first.pos);
      }

      while (this.match(TOKEN.COMMA)) {
        this.#advanceToken();
        if (this.match(TOKEN.RBRACKET)) {
          break;
        }

        const element = this.parseExpression();
        elements.push(element);
        if (!truthy(remainingElements--)) {
          this.#limitExceeded('maxListElements', element.pos);
        }
      }
    }

    const closeEnd = this.lexer.pos;
    this.consume(TOKEN.RBRACKET);

    return this.#node(start, closeEnd, OPS.list, elements);
  }

  parseMap(): MapNode {
    const start = this.consume(TOKEN.LBRACE);
    const props: [AnyNode, AnyNode][] = [];
    let remainingEntries = this.limits.maxMapEntries;

    if (!this.match(TOKEN.RBRACE)) {
      const first = this.parseProperty();
      props.push(first);
      if (!truthy(remainingEntries--)) {
        this.#limitExceeded('maxMapEntries', first[0].pos);
      }

      while (this.match(TOKEN.COMMA)) {
        this.#advanceToken();
        if (this.match(TOKEN.RBRACE)) {
          break;
        }

        const prop = this.parseProperty();
        props.push(prop);
        if (!truthy(remainingEntries--)) {
          this.#limitExceeded('maxMapEntries', prop[0].pos);
        }
      }
    }

    const closeEnd = this.lexer.pos;
    this.consume(TOKEN.RBRACE);

    return this.#node(start, closeEnd, OPS.map, props);
  }

  parseProperty(): [AnyNode, AnyNode] {
    const key = this.parseExpression();
    this.consume(TOKEN.COLON);

    return [key, this.parseExpression()];
  }

  parseArgumentList(): AnyNode[] {
    const args: AnyNode[] = [];
    let remainingArgs = this.limits.maxCallArguments;

    if (!this.match(TOKEN.RPAREN)) {
      const first = this.parseExpression();
      args.push(first);
      if (!truthy(remainingArgs--)) {
        this.#limitExceeded('maxCallArguments', first.pos);
      }

      while (this.match(TOKEN.COMMA)) {
        this.#advanceToken();
        if (this.match(TOKEN.RPAREN)) {
          break;
        }

        const arg = this.parseExpression();
        args.push(arg);
        if (!truthy(remainingArgs--)) {
          this.#limitExceeded('maxCallArguments', arg.pos);
        }
      }
    }

    return args;
  }
}
