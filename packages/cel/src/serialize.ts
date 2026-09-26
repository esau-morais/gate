import { UnsignedInt } from './functions';
import { Optional } from './optional';
import { getProp, setProp } from './globals';
import type { ASTNode, ASTOperator } from './index';

/**
 * Serialize a primitive value to CEL syntax
 * @param value - The value to serialize
 * @returns The CEL representation
 */
function serializeValue(value: unknown): string {
  if (value === null) {
    return 'null';
  }

  if (typeof value === 'boolean') {
    return String(value);
  }

  if (typeof value === 'bigint') {
    return String(value);
  }

  if (typeof value === 'string') {
    return serializeString(value);
  }

  if (value instanceof Uint8Array) {
    return serializeBytes(value);
  }

  if (value instanceof UnsignedInt) {
    return `${value.value}u`;
  }

  if (value instanceof Optional) {
    if (value.hasValue()) {
      return `optional.of(${serializeValue(value.value())})`;
    }

    return 'optional.none()';
  }

  if (typeof value === 'number') {
    return value % 1 === 0
      ? `${value}.0`
      : value.toLocaleString('en-US', {
          useGrouping: false,
          maximumFractionDigits: 9,
        });
  }

  // Handle Uint8Array deserialized from JSON (becomes plain object with numeric keys)
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.every((k) => /^\d+$/.test(k))) {
      const bytes = new Uint8Array(keys.length);
      for (let i = 0; i < keys.length; i++) {
        setProp(bytes, i, getProp(value, i));
      }

      return serializeBytes(bytes);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- upstream falls back to String() for any other value, plain objects included
  return String(value);
}

/**
 * Serialize an AST back to a CEL expression string.
 *
 * @param ast - The AST node to serialize
 * @returns The CEL expression string representation
 *
 * @example
 * ```typescript
 * const evalFn = parse('1 + 2 * 3');
 * const serialized = serialize(evalFn.ast);
 * console.log(serialized); // "1 + 2 * 3"
 * ```
 */
export function serialize(ast: ASTNode): string {
  const { op, args } = ast;
  switch (op) {
    case 'value':
      return serializeValue(args);
    case 'id':
      return args;

    case '||':
    case '&&':
    case '==':
    case '!=':
    case '<':
    case '<=':
    case '>':
    case '>=':
    case 'in':
    case '+':
    case '-':
    case '*':
    case '/':
    case '%':
      return `${wrap(args[0], op)} ${op} ${wrap(args[1], op)}`;

    case '!_':
      return `!${wrap(args, op)}`;
    case '-_':
      // Add parentheses when operand is a binary operation
      return ['+', '-', '*', '/', '%'].includes(args.op)
        ? `-(${serialize(args)})`
        : `-${serialize(args)}`;

    case '.':
      return `${wrap(args[0], op)}.${args[1]}`;
    case '.?':
      return `${wrap(args[0], op)}.?${args[1]}`;
    case '[]':
      return `${wrap(args[0], op)}[${serialize(args[1])}]`;
    case '[?]':
      return `${wrap(args[0], op)}[?${serialize(args[1])}]`;

    case 'call':
      return `${args[0]}(${args[1].map(serialize).join(', ')})`;
    case 'rcall':
      return `${wrap(args[1], op)}.${args[0]}(${args[2].map(serialize).join(', ')})`;

    case 'list':
      return `[${args.map(serialize).join(', ')}]`;
    case 'map':
      return `{${args.map(([k, v]) => `${serialize(k)}: ${serialize(v)}`).join(', ')}}`;

    case '?:':
      return `${wrap(args[0], op)} ? ${wrap(args[1], op)} : ${serialize(args[2])}`;

    default:
      throw new Error(`Unknown AST operation: ${String(op)}`);
  }
}

/**
 * Serialize a string value with proper escaping
 * @param str - The string to serialize
 * @returns The escaped string with quotes
 */
function serializeString(str: string): string {
  const escaped = str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(/\f/g, '\\f')
    .replace(/[\b]/g, '\\b')
    .replace(/\v/g, '\\v');

  let result = '';
  for (let i = 0; i < escaped.length; i++) {
    const code = escaped.charCodeAt(i);
    if (code < 32 || code > 126) {
      result +=
        code <= 0xffff
          ? `\\u${code.toString(16).padStart(4, '0')}`
          : `\\U${code.toString(16).padStart(8, '0')}`;
    } else {
      result += escaped.charAt(i);
    }
  }

  return `"${result}"`;
}

/**
 * Serialize a bytes value
 * @param bytes - The bytes to serialize
 * @returns The bytes literal
 */
function serializeBytes(bytes: Uint8Array): string {
  let result = 'b"';
  for (const byte of bytes) {
    if (byte === 0x5c) {
      result += '\\\\';
    } else if (byte === 0x22) {
      result += '\\"';
    } else if (byte === 0x0a) {
      result += '\\n';
    } else if (byte === 0x0d) {
      result += '\\r';
    } else if (byte === 0x09) {
      result += '\\t';
    } else if (byte >= 32 && byte <= 126) {
      result += String.fromCharCode(byte);
    } else {
      result += `\\x${byte.toString(16).padStart(2, '0')}`;
    }
  }

  return `${result}"`;
}

/**
 * Operator precedence (higher = tighter binding)
 */
const PRECEDENCE: Readonly<Partial<Record<ASTOperator, number>>> = {
  '?:': 1,
  '||': 2,
  '&&': 3,
  '==': 4,
  '!=': 4,
  '<': 5,
  '<=': 5,
  '>': 5,
  '>=': 5,
  in: 5,
  '+': 6,
  '-': 6,
  '-_': 6,
  '*': 7,
  '/': 7,
  '%': 7,
  '!_': 8,
  '.': 9,
  '.?': 9,
  '[]': 9,
  '[?]': 9,
  call: 9,
  rcall: 9,
};

/**
 * Check if parentheses are needed based on operator precedence
 * @param ast - The AST node to check
 * @param parentOp - The parent operator
 * @returns True if parentheses are needed
 */
function needsParentheses(ast: ASTNode, parentOp: ASTOperator): boolean {
  const childOp = ast.op;
  const parentPrec = PRECEDENCE[parentOp] ?? 0;
  const childPrec = PRECEDENCE[childOp] ?? 0;

  // Atomic operations never need parentheses
  if (
    childOp === 'value' ||
    childOp === 'id' ||
    childOp === 'call' ||
    childOp === 'rcall' ||
    childOp === 'list' ||
    childOp === 'map'
  ) {
    return false;
  }

  // Unary minus in multiplicative context: -x * y, -x * y * -z
  if (
    (parentOp === '*' || parentOp === '/' || parentOp === '%') &&
    childOp === '-_'
  ) {
    return false;
  }

  if (parentOp === '*' && ast.op === '*' && ast.args[0].op === '-_') {
    return false;
  }

  // Member/index access chaining: a.b.c, a[0][1], a.?b.c
  if (
    (childOp === '.' ||
      childOp === '[]' ||
      childOp === '.?' ||
      childOp === '[?]') &&
    (parentOp === '.' ||
      parentOp === '[]' ||
      parentOp === '.?' ||
      parentOp === '[?]' ||
      parentOp === 'rcall')
  ) {
    return false;
  }

  // Ternary: only wrap if child is also ternary
  if (parentOp === '?:') {
    return childOp === '?:';
  }

  // Unary operators: wrap if child has lower precedence
  if (parentOp === '!_' || parentOp === '-_') {
    return childPrec < parentPrec;
  }

  // Division needs special handling
  if (
    parentOp === '/' &&
    (childOp === '*' || childOp === '+' || childOp === '-')
  ) {
    return true;
  }

  if (childOp === '/' && parentOp !== undefined) {
    return true;
  }

  if (
    (parentOp === '*' || parentOp === '/') &&
    ['+', '-', '*', '/'].includes(childOp)
  ) {
    return true;
  }

  // Lower precedence needs parentheses
  if (childPrec < parentPrec) {
    return true;
  }

  // Same precedence: non-associative operators need parentheses
  if (
    childPrec === parentPrec &&
    (parentOp === '/' || parentOp === '%') &&
    (childOp === '/' || childOp === '%')
  ) {
    return true;
  }

  return false;
}

/**
 * Wrap expression in parentheses if needed
 * @param ast - The AST node
 * @param parentOp - The parent operator
 * @returns The serialized expression, possibly wrapped in parentheses
 */
function wrap(ast: ASTNode, parentOp: ASTOperator): string {
  return needsParentheses(ast, parentOp)
    ? `(${serialize(ast)})`
    : serialize(ast);
}

export default serialize;
