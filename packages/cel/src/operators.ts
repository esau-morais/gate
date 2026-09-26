import { celTypes } from './registry';
import type {
  CallableHandler,
  EvalContext,
  OverlayContext,
  RegisteredType,
  Registry,
  TypeDeclaration,
} from './registry';
import {
  constructorOf,
  expectDefined,
  getProp,
  hasOwn,
  isMutableArray,
  isPromise,
  isUnknownArray,
  isUnknownMap,
  nullObject,
  objKeys,
  setProp,
  truthy,
} from './globals';
import { attachErrorAst } from './errors';
import { UnsignedInt } from './functions';
import type { CreateError, ErrorNode } from './errors';
import type { ResolvedEnvironmentOptions } from './options';
import type { TypeChecker } from './type-checker';
import type { Evaluator } from './evaluator';
import type {
  AccessNode,
  AccuPushNode,
  AnyNode,
  ASTNode,
  BinaryNode,
  BinaryOp,
  CallNode,
  ComprehensionArgs,
  FieldOp,
  IndexOp,
  LogicalNode,
  LogicalOp,
  NodeHandle,
  NodeKind,
  RcallNode,
  TernaryNode,
  UnaryNode,
  UnaryOp,
} from './parser';

const dynType = celTypes.dyn;

export interface BaseOptions {
  registry: Registry;
  opts: Readonly<ResolvedEnvironmentOptions>;
}

export class Base {
  dynType = celTypes.dyn;
  optionalType = celTypes.optional;
  stringType = celTypes.string;
  intType = celTypes.int;
  doubleType = celTypes.double;
  boolType = celTypes.bool;
  nullType = celTypes.null;
  listType = celTypes.list;
  mapType = celTypes.map;

  declare readonly opts: Readonly<ResolvedEnvironmentOptions>;
  declare readonly registry: Registry;
  declare readonly objectTypes: Map<string, RegisteredType>;
  declare readonly objectTypesByConstructor: Map<unknown, RegisteredType>;
  /** Set by the subclass: type errors while checking, evaluation errors while evaluating. */
  declare createError: CreateError;

  constructor(opts: BaseOptions) {
    this.opts = opts.opts;
    this.registry = opts.registry;
    this.objectTypes = this.registry.objectTypes;
    this.objectTypesByConstructor = this.registry.objectTypesByConstructor;
  }

  /**
   * Get a TypeDeclaration instance for a type name
   * @param typeName - The type name (e.g., 'string', 'int', 'dyn')
   * @returns The type declaration instance
   */
  getType(typeName: string): TypeDeclaration {
    return this.registry.getType(typeName);
  }

  debugType(v: unknown): TypeDeclaration {
    switch (typeof v) {
      case 'string':
        return this.stringType;
      case 'bigint':
        return this.intType;
      case 'number':
        return this.doubleType;
      case 'boolean':
        return this.boolType;
      case 'object': {
        if (v === null) {
          return this.nullType;
        }

        const ctor = constructorOf(v);
        switch (ctor) {
          case undefined:
          case Object:
          case Map:
            return this.mapType;
          case Array:
          case Set:
            return this.listType;
          default: {
            const registered = this.objectTypesByConstructor.get(ctor)?.type;
            if (registered) {
              return registered;
            }

            const name =
              ctor === null || ctor === undefined
                ? undefined
                : getProp(ctor, 'name');

            return unsupportedType(this, truthy(name) ? name : typeof v);
          }
        }
      }
      case 'symbol':
      case 'undefined':
      case 'function':
      default:
        return unsupportedType(this, typeof v);
    }
  }
}

function unsupportedType(self: Base, type: unknown): never {
  throw self.createError(
    'unsupported_type',
    `Unsupported type: ${String(type)}`,
  );
}

type AsyncOperand = AnyNode | readonly AnyNode[] | boolean;

function isNodeArray(a: AsyncOperand): a is readonly AnyNode[] {
  return Array.isArray(a);
}

const maybeAsyncArray = (a: AsyncOperand): boolean =>
  isNodeArray(a) ? a.some((n) => n.maybeAsync) : false;

function isMaybeAsync(operand: AsyncOperand): boolean {
  if (operand === true) {
    return true;
  }

  if (operand === false) {
    return false;
  }

  return isNodeArray(operand) ? maybeAsyncArray(operand) : operand.maybeAsync;
}

function maybeAsync(
  l: AsyncOperand,
  r: AsyncOperand,
  h: NodeHandle,
): NodeHandle {
  if (isMaybeAsync(r)) {
    return maybeAsyncBoth(h);
  }

  if (isMaybeAsync(l)) {
    return maybeAsyncFirst(h);
  }

  return h;
}

function maybeAsyncBoth(handler: NodeHandle): NodeHandle {
  return (handler.__asyncBoth ??= function handle(
    a: unknown,
    b: unknown,
    c: unknown,
    d: unknown,
  ): unknown {
    if (isPromise(a)) {
      if (isPromise(b)) {
        return Promise.all([a, b]).then((p) => handler(p[0], p[1], c, d));
      }

      return a.then((_a) => handler(_a, b, c, d));
    }

    if (isPromise(b)) {
      return b.then((_b) => handler(a, _b, c, d));
    }

    return handler(a, b, c, d);
  });
}

function maybeAsyncFirst(handler: NodeHandle): NodeHandle {
  return (handler.__asyncFirst ??= function handle(
    a: unknown,
    b: unknown,
    c: unknown,
    d: unknown,
  ): unknown {
    if (isPromise(a)) {
      return a.then((_a) => handler(_a, b, c, d));
    }

    return handler(a, b, c, d);
  });
}

function checkAccessNode(
  chk: TypeChecker,
  ast: AccessNode,
  ctx: EvalContext,
): TypeDeclaration {
  ast.right = ast.args[1];
  const leftType = chk.check((ast.left = ast.args[0]), ctx);
  if (ast.op === '[]') {
    chk.check(ast.right, ctx);
  }

  ast.handle = maybeAsync(
    ast.left,
    ast.op === '[]' ? ast.right : false,
    leftType !== dynType ? fieldAccessStatic : fieldAccess,
  );

  if (leftType.kind !== 'optional') {
    return chk.checkAccessOnType(ast, ctx, leftType);
  }

  return chk.registry.getOptionalType(
    chk.checkAccessOnType(
      ast,
      ctx,
      expectDefined(leftType.valueType, 'optional value type'),
      true,
    ),
  );
}

function checkOptionalAccessNode(
  chk: TypeChecker,
  ast: AccessNode,
  ctx: EvalContext,
): TypeDeclaration {
  ast.right = ast.args[1];
  const leftType = chk.check((ast.left = ast.args[0]), ctx);
  if (ast.op === '[?]') {
    chk.check(ast.right, ctx);
  }

  ast.handle = maybeAsync(
    ast.left,
    ast.op === '[?]' ? ast.right : false,
    oFieldAccess,
  );

  const actualType =
    leftType.kind === 'optional'
      ? expectDefined(leftType.valueType, 'optional value type')
      : leftType;

  return chk.registry.getOptionalType(
    chk.checkAccessOnType(ast, ctx, actualType, true),
  );
}

const HOMOGENEOUS_PREFIX = {
  heterogeneous_list_element: 'List elements must have the same type,',
  heterogeneous_map_key: 'Map key uses wrong type,',
  heterogeneous_map_value: 'Map value uses wrong type,',
};

type HomogeneousCode = keyof typeof HOMOGENEOUS_PREFIX;

function checkElementHomogenous(
  chk: TypeChecker,
  ctx: EvalContext,
  expected: TypeDeclaration,
  el: AnyNode,
  code: HomogeneousCode,
): TypeDeclaration {
  const type = chk.check(el, ctx);
  if (type === expected || truthy(expected.isEmpty())) {
    return type;
  }

  if (truthy(type.isEmpty())) {
    return expected;
  }

  throw chk.createError(
    code,
    `${HOMOGENEOUS_PREFIX[code]} expected type '${chk.formatType(expected)}' but found '${chk.formatType(type)}'`,
    el,
  );
}

function checkElement(
  chk: TypeChecker,
  ctx: EvalContext,
  expected: TypeDeclaration,
  el: AnyNode,
): TypeDeclaration {
  return expected.unify(chk.registry, chk.check(el, ctx)) || dynType;
}

function labelOf(node: AnyNode, fallback: string): string {
  const label = node.meta.label;

  return label === undefined || label === '' ? fallback : label;
}

function ternaryConditionError(
  ev: Evaluator,
  value: unknown,
  node: AnyNode,
): Error {
  const type = ev.debugRuntimeType(value);

  return ev.createError(
    'invalid_condition_type',
    `${labelOf(node, 'Ternary condition must be bool')}, got '${type.name}'`,
    node,
  );
}

function handleTernary(
  c: unknown,
  ev: Evaluator,
  ast: TernaryNode,
  ctx: EvalContext,
): unknown {
  if (c === true) {
    return ev.run(ast.left, ctx);
  }

  if (c === false) {
    return ev.run(ast.right, ctx);
  }

  throw ternaryConditionError(ev, c, ast.condition);
}

function logicalOperandError(
  ev: Evaluator,
  value: unknown,
  node: AnyNode,
): Error {
  const type = ev.debugRuntimeType(value);

  return ev.createError(
    'invalid_logical_operand',
    `Logical operator requires bool operands, got '${type.name}'`,
    node,
  );
}

function logicalValueOrErr(ev: Evaluator, v: unknown, node: AnyNode): Error {
  if (v instanceof Error) {
    return v;
  }

  return logicalOperandError(ev, v, node);
}

function _logicalOp(
  exp: boolean,
  ev: Evaluator,
  ast: LogicalNode,
  left: unknown,
  right: unknown,
): unknown {
  if (right === exp) {
    return exp;
  }

  if (right === !exp) {
    if (left === right) {
      return right;
    }

    throw logicalValueOrErr(ev, left, ast.left);
  }

  if (isPromise(right)) {
    return right.then((r) => _logicalOpAsync(exp, ev, ast, left, r));
  }

  throw logicalOperandError(ev, right, ast.left);
}

function _logicalOpAsync(
  exp: boolean,
  ev: Evaluator,
  ast: LogicalNode,
  left: unknown,
  right: unknown,
): boolean {
  if (right === exp) {
    return exp;
  }

  if (typeof right !== 'boolean') {
    throw logicalOperandError(ev, right, ast.right);
  }

  if (typeof left !== 'boolean') {
    throw logicalValueOrErr(ev, left, ast.left);
  }

  return !exp;
}

function checkLogicalOp(
  chk: TypeChecker,
  ast: LogicalNode,
  ctx: EvalContext,
): TypeDeclaration {
  const leftType = chk.check((ast.left = ast.args[0]), ctx);
  const rightType = chk.check((ast.right = ast.args[1]), ctx);

  if (!leftType.isDynOrBool()) {
    throw chk.createError(
      'invalid_logical_operand',
      `Logical operator requires bool operands, got '${chk.formatType(leftType)}'`,
      ast,
    );
  }

  if (!rightType.isDynOrBool()) {
    throw chk.createError(
      'invalid_logical_operand',
      `Logical operator requires bool operands, got '${chk.formatType(rightType)}'`,
      ast,
    );
  }

  return chk.boolType;
}

function checkUnary(
  chk: TypeChecker,
  ast: UnaryNode,
  ctx: EvalContext,
): TypeDeclaration {
  const op = ast.op;
  const right = chk.check(ast.args, ctx);
  ast.candidates = chk.registry.operatorCandidates(op);

  if (right.kind === 'dyn') {
    ast.handle = maybeAsync(ast.args, false, handleUnary);

    return expectDefined(ast.candidates.returnType, 'unary return type');
  }

  const overload = ast.candidates.findUnaryOverload(right);
  if (overload === false) {
    throw chk.createError(
      'no_such_overload',
      `no such overload: ${op[0]}${chk.formatType(right)}`,
      ast,
    );
  }

  ast.handle = maybeAsync(ast.args, false, overload.handler);

  return overload.returnType;
}

function handleUnary(left: unknown, ast: UnaryNode, ev: Evaluator): unknown {
  const leftType = ev.debugRuntimeType(left, ast.args.checkedType);
  const overload = ast.candidates.findUnaryOverload(leftType);
  if (overload !== false) {
    return overload.handler(left, ast, ev);
  }

  throw ev.createError(
    'no_such_overload',
    `no such overload: ${ast.op[0]}${leftType.name}`,
    ast,
  );
}

function evaluateUnary(
  ev: Evaluator,
  ast: UnaryNode,
  ctx: EvalContext,
): unknown {
  return ast.handle(ev.run(ast.args, ctx), ast, ev);
}

function checkBinary(
  chk: TypeChecker,
  ast: BinaryNode,
  ctx: EvalContext,
): TypeDeclaration {
  const op = ast.op;
  const left = chk.check((ast.left = ast.args[0]), ctx);
  const right = chk.check((ast.right = ast.args[1]), ctx);
  ast.candidates = chk.registry.operatorCandidates(op);

  const overload =
    left.hasDynType || right.hasDynType
      ? undefined
      : ast.candidates.findBinaryOverload(left, right);

  const found = overload !== undefined && overload !== false;
  ast.handle = maybeAsync(
    ast.left,
    ast.right,
    found ? overload.handler : handleBinary,
  );
  if (found) {
    return overload.returnType;
  }

  const type = ast.candidates.checkBinaryOverload(left, right);
  if (!left.hasDynType) {
    ast.leftStaticType = left;
  }

  if (!right.hasDynType) {
    ast.rightStaticType = right;
  }

  if (type !== false) {
    return type;
  }

  throw chk.createError(
    'no_such_overload',
    `no such overload: ${chk.formatType(left)} ${op} ${chk.formatType(right)}`,
    ast,
  );
}

function evaluateBinary(
  ev: Evaluator,
  ast: BinaryNode | ASTNode<IndexOp>,
  ctx: EvalContext,
): unknown {
  return ast.handle(ev.run(ast.left, ctx), ev.run(ast.right, ctx), ast, ev);
}

function evaluateBinaryFirst(
  ev: Evaluator,
  ast: ASTNode<FieldOp>,
  ctx: EvalContext,
): unknown {
  return ast.handle(ev.run(ast.left, ctx), ast.right, ast, ev);
}

function handleBinary(
  left: unknown,
  right: unknown,
  ast: BinaryNode,
  ev: Evaluator,
): unknown {
  const leftType = ast.leftStaticType || ev.debugTypeDeep(left).wrappedType;
  const rightType = ast.rightStaticType || ev.debugTypeDeep(right).wrappedType;
  const overload = ast.candidates.findBinaryOverload(leftType, rightType);
  if (overload !== false) {
    return overload.handler(left, right, ast, ev);
  }

  throw ev.createError(
    'no_such_overload',
    `no such overload: ${leftType.name} ${ast.op} ${rightType.name}`,
    ast,
  );
}

function callFunctionHandler(
  handler: CallableHandler,
  ev: Evaluator,
  args: unknown[],
  ast: ErrorNode,
): unknown {
  try {
    const result = handler.apply(ev, args);
    if (isPromise(result)) {
      return result.catch((error: unknown) => {
        throw attachErrorAst(error, ast);
      });
    }

    return result;
  } catch (error) {
    throw attachErrorAst(error, ast);
  }
}

function callFn(args: unknown[], ast: CallNode, ev: Evaluator): unknown {
  const argAst = ast.args[1];
  const types = ast.argTypes;
  let i = argAst.length;
  while (i-- !== 0) {
    types[i] = ev.debugRuntimeType(
      args[i],
      expectDefined(argAst[i], 'argument node').checkedType,
    );
  }

  const decl = ast.candidates.findFunction(types);
  if (decl) {
    return callFunctionHandler(decl.handler, ev, args, ast);
  }

  throw ev.createError(
    'no_matching_overload',
    `found no matching overload for '${ast.args[0]}(${types
      .map((t) => t.unwrappedType)
      .join(', ')})'`,
    ast,
  );
}

function callRecFn(args: unknown[], ev: Evaluator, ast: RcallNode): unknown {
  const [, receiverAst, argAst] = ast.args;
  const types = ast.argTypes;
  for (let i = 0; i < types.length; i++) {
    types[i] = ev.debugRuntimeType(
      args[i + 1],
      expectDefined(argAst[i], 'argument node').checkedType,
    );
  }

  const receiverType = ev.debugRuntimeType(args[0], receiverAst.checkedType);
  const decl = ast.candidates.findFunction(types, receiverType);
  if (decl) {
    return callFunctionHandler(decl.handler, ev, args, ast);
  }

  throw ev.createError(
    'no_matching_overload',
    `found no matching overload for '${receiverType.type}.${ast.args[0]}(${types
      .map((t) => t.unwrappedType)
      .join(', ')})'`,
    ast,
  );
}

function resolveAstArray(
  ev: Evaluator,
  astArray: readonly AnyNode[],
  ctx: EvalContext,
  i = astArray.length,
): unknown[] | Promise<unknown[]> {
  if (i === 0) {
    return [];
  }

  let async: boolean | undefined;
  const results = new Array<unknown>(i);
  while (i-- !== 0) {
    if (
      isPromise((results[i] = ev.run(expectDefined(astArray[i], 'node'), ctx)))
    ) {
      async ??= true;
    }
  }

  return async === true ? Promise.all(results) : results;
}

function isMapKey(k: unknown): boolean {
  return (
    typeof k === 'string' ||
    typeof k === 'bigint' ||
    typeof k === 'boolean' ||
    k instanceof UnsignedInt
  );
}

function safeFromEntries(
  entries: readonly unknown[],
  ev: Evaluator,
  astEntries: readonly (readonly [AnyNode, AnyNode])[],
): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!isUnknownArray(entry)) {
      throw new TypeError('Map entry was not resolved');
    }

    const [k, v] = entry;
    if (!isMapKey(k)) {
      throw ev.createError(
        'unsupported_key_type',
        `Unsupported map key type: ${ev.debugType(k).name}`,
        astEntries[i]?.[0],
      );
    }

    if (k === '__proto__' || k === 'constructor' || k === 'prototype') {
      continue;
    }

    // Keys are stored as strings, so equal numeric keys of different types (0 and 0u) also collide here.
    if (hasOwn(obj, k)) {
      throw ev.createError(
        'repeated_map_key',
        `Repeated map key: ${String(k)}`,
        astEntries[i]?.[0],
      );
    }

    setProp(obj, k, v);
  }

  return obj;
}

function comprehensionElementType(
  chk: TypeChecker,
  iterable: AnyNode,
  ctx: EvalContext,
): TypeDeclaration {
  const iterType = chk.check(iterable, ctx);
  if (iterType.kind === 'dyn') {
    return iterType;
  }

  if (iterType.kind === 'list') {
    return expectDefined(iterType.valueType, 'list value type');
  }

  if (iterType.kind === 'map') {
    return expectDefined(iterType.keyType, 'map key type');
  }

  throw chk.createError(
    'invalid_comprehension_range',
    `Expression of type '${chk.formatType(
      iterType,
    )}' cannot be range of a comprehension (must be list, map, or dynamic).`,
    iterable,
  );
}

function toIterable(
  ev: Evaluator,
  args: ComprehensionArgs,
  coll: unknown,
): readonly unknown[] {
  if (coll instanceof Set) {
    return [...coll];
  }

  if (coll instanceof Map) {
    return [...coll.keys()];
  }

  if (truthy(coll) && typeof coll === 'object') {
    return objKeys(coll);
  }

  throw ev.createError(
    'invalid_comprehension_range',
    `Expression of type '${
      ev.debugType(coll).name
    }' cannot be range of a comprehension (must be list, map, or dynamic).`,
    args.iterable,
  );
}

function runQualifier(
  items: unknown,
  args: ComprehensionArgs,
  ev: Evaluator,
  ctx: EvalContext,
): unknown {
  const list = isUnknownArray(items) ? items : toIterable(ev, args, items);
  const iterCtx = expectDefined(args.iterCtx, 'comprehension context');
  const loopCtx = iterCtx.reuse(ctx);
  const accu = ev.run(args.init, loopCtx);
  loopCtx.accuValue = accu;
  if (loopCtx === args.iterCtx) {
    return iterateQuantifier(ev, loopCtx, args, list, accu, 0);
  }

  return continueQuantifier(ev, loopCtx, args, list, accu, 0);
}

function runComprehension(
  items: unknown,
  args: ComprehensionArgs,
  ev: Evaluator,
  ctx: EvalContext,
): unknown {
  const list = isUnknownArray(items) ? items : toIterable(ev, args, items);
  const iterCtx = expectDefined(args.iterCtx, 'comprehension context');
  const loopCtx = iterCtx.reuse(ctx);
  const accu = ev.run(args.init, loopCtx);
  loopCtx.accuValue = accu;
  if (loopCtx === args.iterCtx) {
    return iterateLoop(ev, loopCtx, args, list, accu, 0);
  }

  return continueLoop(ev, loopCtx, args, list, accu, 0);
}

function iterateLoop(
  ev: Evaluator,
  ctx: OverlayContext,
  args: ComprehensionArgs,
  items: readonly unknown[],
  accu: unknown,
  i: number,
): unknown {
  const condition = args.condition;
  const step = args.step;
  const len = items.length;
  while (i < len) {
    if (condition && !truthy(condition(accu))) {
      break;
    }

    accu = ev.run(step, ctx.setIterValue(items[i++], ev));
    if (isPromise(accu)) {
      return continueLoop(ev, ctx, args, items, accu, i);
    }
  }

  return args.result(accu);
}

async function continueLoop(
  ev: Evaluator,
  ctx: OverlayContext,
  args: ComprehensionArgs,
  items: readonly unknown[],
  accu: unknown,
  i: number,
): Promise<unknown> {
  if (ctx === args.iterCtx) {
    ctx.async = true;
  }

  const condition = args.condition;
  const step = args.step;
  const len = items.length;
  accu = await accu;
  while (i < len) {
    if (condition && !truthy(condition(accu))) {
      return args.result(accu);
    }

    accu = ev.run(step, ctx.setIterValue(items[i++], ev));
    if (isPromise(accu)) {
      accu = await accu;
    }
  }

  return args.result(accu);
}

function iterateQuantifier(
  ev: Evaluator,
  ctx: OverlayContext,
  args: ComprehensionArgs,
  items: readonly unknown[],
  accu: unknown,
  i: number,
  error?: Error,
  stp?: unknown,
): unknown {
  const condition = expectDefined(args.condition, 'quantifier condition');
  const step = args.step;
  const len = items.length;
  while (i < len) {
    if (!truthy(condition(accu))) {
      return args.result(accu);
    }

    stp = ev.tryEval(step, ctx.setIterValue(items[i++], ev));
    if (isPromise(stp)) {
      return continueQuantifier(ev, ctx, args, items, accu, i, error, stp);
    }

    if (stp instanceof Error) {
      error ??= stp;
      continue;
    }

    accu = stp;
  }

  if (error && truthy(condition(accu))) {
    throw error;
  }

  return args.result(accu);
}

async function continueQuantifier(
  ev: Evaluator,
  ctx: OverlayContext,
  args: ComprehensionArgs,
  items: readonly unknown[],
  accu: unknown,
  i: number,
  error?: Error,
  stp?: unknown,
): Promise<unknown> {
  if (ctx === args.iterCtx) {
    ctx.async = true;
  }

  const condition = expectDefined(args.condition, 'quantifier condition');
  const step = args.step;
  const len = items.length;

  stp = await stp;
  if (stp instanceof Error) {
    error ??= stp;
  } else {
    accu = stp;
  }

  while (i < len) {
    if (!truthy(condition(accu))) {
      return args.result(accu);
    }

    stp = ev.tryEval(step, ctx.setIterValue(items[i++], ev));
    if (isPromise(stp)) {
      stp = await stp;
    }

    if (stp instanceof Error) {
      error ??= stp;
      continue;
    }

    accu = stp;
  }

  if (error && truthy(condition(accu))) {
    throw error;
  }

  return args.result(accu);
}

function oFieldAccess(
  left: unknown,
  right: unknown,
  ast: AccessNode,
  ev: Evaluator,
): unknown {
  return ev.optionalType.field(left, right, ast, ev);
}

function fieldAccessStatic(
  left: unknown,
  right: unknown,
  ast: AccessNode,
  ev: Evaluator,
): unknown {
  return expectDefined(ast.left.checkedType, 'checked type').field(
    left,
    right,
    ast,
    ev,
  );
}

const empty = nullObject<never>();
function fieldAccess(
  left: unknown,
  right: unknown,
  ast: AccessNode,
  ev: Evaluator,
): unknown {
  const ctor = constructorOf(left);
  switch (ctor) {
    case undefined:
    case Object: {
      const target = truthy(left) ? left : empty;
      const v = hasOwn(target, right) ? getProp(target, right) : undefined;
      if (v !== undefined) {
        return (ev.debugType(v), v);
      }

      break;
    }
    case Map: {
      const v = isUnknownMap(left) ? left.get(right) : undefined;
      if (v !== undefined) {
        return (ev.debugType(v), v);
      }

      break;
    }
    case Array:
    case Set:
      return ev.listType.field(left, right, ast, ev);
    default: {
      const t = ev.objectTypesByConstructor.get(ctor);
      if (t) {
        return t.type.field(left, right, ast, ev);
      } else if (typeof left === 'object' && left !== null) {
        unsupportedType(ev, typeof ctor === 'function' ? ctor.name : 'object');
      }
    }
  }

  throw ev.createError('no_such_key', `No such key: ${String(right)}`, ast);
}

const emptyList = (): unknown[] => [];
const emptyMap = (): Record<string, unknown> => ({});

/**
 * An operator definition. `check` and `evaluate` receive the node kind they
 * are registered for; the parser attaches each definition only to nodes of
 * its own kind, which TypeScript accepts through method-signature bivariance
 * when the definition is stored as a `NodeOperator`.
 */
export interface OperatorDef<
  K extends NodeKind,
  C extends EvalContext = EvalContext,
> {
  readonly name: K;
  readonly alias?: string;
  check(this: void, chk: TypeChecker, ast: ASTNode<K>, ctx: C): TypeDeclaration;
  evaluate(this: void, ev: Evaluator, ast: ASTNode<K>, ctx: C): unknown;
}

const valueOp: OperatorDef<'value'> = {
  name: 'value',
  check(chk, ast) {
    return chk.debugType(ast.args);
  },
  evaluate(_ev, ast) {
    return ast.args;
  },
};

const idOp: OperatorDef<'id'> = {
  name: 'id',
  check(chk, ast, ctx) {
    const variable = ctx.getVariable(ast.args);
    if (!variable) {
      throw chk.createError(
        'unknown_variable',
        `Unknown variable: ${ast.args}`,
        ast,
      );
    }

    if (variable.constant) {
      const alternate = ast.clone(valueOp, variable.value);
      ast.setMeta('alternate', alternate);

      return chk.check(alternate, ctx);
    }

    return variable.type;
  },
  evaluate(ev, ast, ctx) {
    return ctx.getCheckedValue(ev, ast);
  },
};

const fieldAccessOp: OperatorDef<FieldOp> = {
  name: '.',
  alias: 'fieldAccess',
  check: checkAccessNode,
  evaluate: evaluateBinaryFirst,
};

const optionalFieldAccessOp: OperatorDef<FieldOp> = {
  name: '.?',
  alias: 'optionalFieldAccess',
  check: checkOptionalAccessNode,
  evaluate: evaluateBinaryFirst,
};

const bracketAccessOp: OperatorDef<IndexOp> = {
  name: '[]',
  alias: 'bracketAccess',
  check: checkAccessNode,
  evaluate: evaluateBinary,
};

const optionalBracketAccessOp: OperatorDef<IndexOp> = {
  name: '[?]',
  alias: 'optionalBracketAccess',
  check: checkOptionalAccessNode,
  evaluate: evaluateBinary,
};

const callOp: OperatorDef<'call'> = {
  name: 'call',
  check(chk, ast, ctx) {
    const [functionName, args] = ast.args;
    const candidates = (ast.candidates = chk.registry.functionCandidates(
      false,
      functionName,
      args.length,
    ));

    const argTypes = (ast.argTypes = args.map((a) => chk.check(a, ctx)));
    const decl = candidates.findFunction(argTypes);

    if (!decl) {
      throw chk.createError(
        'no_matching_overload',
        `found no matching overload for '${functionName}(${chk.formatTypeList(argTypes)})'`,
        ast,
      );
    }

    const handle = argTypes.some((t) => t.hasDynType)
      ? callFn
      : (decl.handler.__handle ??= (
          l: unknown[],
          _ast: CallNode,
          e: Evaluator,
        ) => callFunctionHandler(decl.handler, e, l, _ast));

    ast.handle = maybeAsync(args, false, handle);

    return decl.returnType;
  },
  evaluate(ev, ast, ctx) {
    return ast.handle(resolveAstArray(ev, ast.args[1], ctx), ast, ev);
  },
};

const rcallOp: OperatorDef<'rcall'> = {
  name: 'rcall',
  check(chk, ast, ctx) {
    const [methodName, receiver, args] = ast.args;
    const receiverType = chk.check(receiver, ctx);
    const candidates = (ast.candidates = chk.registry.functionCandidates(
      true,
      methodName,
      args.length,
    ));

    const argTypes = (ast.argTypes = args.map((a) => chk.check(a, ctx)));
    ast.receiverWithArgs = [receiver, ...args];
    ast.handle = maybeAsync(ast.receiverWithArgs, false, callRecFn);

    if (receiverType.kind === 'dyn' && candidates.returnType) {
      return candidates.returnType;
    }

    const decl = candidates.findFunction(argTypes, receiverType);

    if (!decl) {
      throw chk.createError(
        'no_matching_overload',
        `found no matching overload for '${receiverType.type}.${methodName}(${chk.formatTypeList(
          argTypes,
        )})'`,
        ast,
      );
    }

    if (
      !receiverType.hasPlaceholderType &&
      !argTypes.some((t) => t.hasDynType)
    ) {
      const fn = decl.handler;
      const handle = (fn.__rcallHandle ??= (
        a: unknown[],
        ev: Evaluator,
        _ast: RcallNode,
      ) => callFunctionHandler(fn, ev, a, _ast));
      ast.handle = maybeAsync(ast.receiverWithArgs, false, handle);
    }

    return decl.returnType;
  },
  evaluate(ev, ast, ctx) {
    return ast.handle(resolveAstArray(ev, ast.receiverWithArgs, ctx), ev, ast);
  },
};

const listOp: OperatorDef<'list'> = {
  name: 'list',
  check(chk, ast, ctx) {
    const arr = ast.args;
    const arrLen = arr.length;
    if (arrLen === 0) {
      ast.setMeta('evaluate', emptyList);

      return chk.getType('list<T>');
    }

    let valueType = chk.check(expectDefined(arr[0], 'list element'), ctx);
    const check = chk.opts.homogeneousAggregateLiterals
      ? checkElementHomogenous
      : checkElement;

    for (let i = 1; i < arrLen; i++) {
      valueType = check(
        chk,
        ctx,
        valueType,
        expectDefined(arr[i], 'list element'),
        'heterogeneous_list_element',
      );
    }

    return chk.registry.getListType(valueType);
  },
  evaluate(ev, ast, ctx) {
    return resolveAstArray(ev, ast.args, ctx);
  },
};

const mapOp: OperatorDef<'map'> = {
  name: 'map',
  check(chk, ast, ctx) {
    const arr = ast.args;
    const arrLen = arr.length;
    if (arrLen === 0) {
      ast.setMeta('evaluate', emptyMap);

      return chk.getType('map<K, V>');
    }

    const check = chk.opts.homogeneousAggregateLiterals
      ? checkElementHomogenous
      : checkElement;
    const first = expectDefined(arr[0], 'map entry');
    let keyType = chk.check(first[0], ctx);
    let valueType = chk.check(first[1], ctx);
    for (let i = 1; i < arrLen; i++) {
      const e = expectDefined(arr[i], 'map entry');
      keyType = check(chk, ctx, keyType, e[0], 'heterogeneous_map_key');
      valueType = check(chk, ctx, valueType, e[1], 'heterogeneous_map_value');
    }

    return chk.registry.getMapType(keyType, valueType);
  },
  evaluate(ev, ast, ctx) {
    const astEntries = ast.args;
    const len = astEntries.length;
    const results = new Array<unknown>(len);
    let async: boolean | undefined;
    for (let i = 0; i < len; i++) {
      const e = expectDefined(astEntries[i], 'map entry');
      const k = ev.run(e[0], ctx);
      const v = ev.run(e[1], ctx);
      if (isPromise(k) || isPromise(v)) {
        results[i] = Promise.all([k, v]);
        async ??= true;
      } else {
        results[i] = [k, v];
      }
    }

    if (async === true) {
      return Promise.all(results).then((r) =>
        safeFromEntries(r, ev, astEntries),
      );
    }

    return safeFromEntries(results, ev, astEntries);
  },
};

const comprehensionOp: OperatorDef<'comprehension'> = {
  name: 'comprehension',
  check(chk, ast, ctx) {
    const args = ast.args;
    const iterCtx = (args.iterCtx = ctx
      .forkWithVariable(
        args.iterVarName,
        comprehensionElementType(chk, args.iterable, ctx),
      )
      .setAccuType(chk.check(args.init, ctx)));

    const stepType = chk.check(args.step, iterCtx);
    const handler = args.errorsAreFatal ? runComprehension : runQualifier;
    ast.handle = maybeAsync(args.iterable, false, handler);
    if (args.kind === 'quantifier') {
      return chk.boolType;
    }

    return stepType;
  },
  evaluate(ev, ast, ctx) {
    return ast.handle(ev.run(ast.args.iterable, ctx), ast.args, ev, ctx);
  },
};

const accuValueOp: OperatorDef<'accuValue', OverlayContext> = {
  name: 'accuValue',
  check(_chk, _ast, ctx) {
    return expectDefined(ctx.accuType, 'accumulator type');
  },
  evaluate(_ev, _ast, ctx) {
    return ctx.accuValue;
  },
};

const accuIncOp: OperatorDef<'accuInc', OverlayContext> = {
  name: 'accuInc',
  check(_chk, _ast, ctx) {
    return expectDefined(ctx.accuType, 'accumulator type');
  },
  evaluate(_ev, _ast, ctx) {
    const accu = ctx.accuValue;
    if (typeof accu !== 'number') {
      throw new TypeError('Accumulator must be a number');
    }

    return (ctx.accuValue = accu + 1);
  },
};

function accumulatorList(ctx: OverlayContext): unknown[] {
  const accu = ctx.accuValue;
  if (!isMutableArray(accu)) {
    throw new TypeError('Accumulator must be a list');
  }

  return accu;
}

interface AccuPushDef extends OperatorDef<'accuPush', OverlayContext> {
  evaluateSync(
    this: void,
    ev: Evaluator,
    ast: AccuPushNode,
    ctx: OverlayContext,
  ): unknown;
}

const accuPushOp: AccuPushDef = {
  name: 'accuPush',
  check(chk, ast, ctx) {
    const listType = expectDefined(ctx.accuType, 'accumulator type');
    const itemType = chk.check(ast.args, ctx);
    if (!ast.args.maybeAsync) {
      ast.setMeta('evaluate', accuPushOp.evaluateSync);
    }

    if (
      listType.kind === 'list' &&
      expectDefined(listType.valueType, 'list value type').kind !== 'param'
    ) {
      return listType;
    }

    return chk.registry.getListType(itemType);
  },
  evaluateSync(ev, ast, ctx) {
    accumulatorList(ctx).push(ev.run(ast.args, ctx));

    return ctx.accuValue;
  },
  evaluate(ev, ast, ctx) {
    const arr = accumulatorList(ctx);
    const el = ev.run(ast.args, ctx);
    if (isPromise(el)) {
      return el.then((_e) => (arr.push(_e), arr));
    }

    arr.push(el);

    return arr;
  },
};

const ternaryOp: OperatorDef<'?:'> = {
  name: '?:',
  alias: 'ternary',
  check(chk, ast, ctx) {
    const condast = (ast.condition = ast.args[0]);
    const leftast = (ast.left = ast.args[1]);
    const rightast = (ast.right = ast.args[2]);
    const condType = chk.check(condast, ctx);
    if (!condType.isDynOrBool()) {
      throw chk.createError(
        'invalid_condition_type',
        `${labelOf(condast, 'Ternary condition must be bool')}, got '${chk.formatType(condType)}'`,
        condast,
      );
    }

    const leftType = chk.check(leftast, ctx);
    const rightType = chk.check(rightast, ctx);
    const unified = leftType.unify(chk.registry, rightType);

    ast.handle = maybeAsync(condast, false, handleTernary);
    if (unified) {
      return unified;
    }

    throw chk.createError(
      'incompatible_ternary_branches',
      `Ternary branches must have the same type, got '${chk.formatType(
        leftType,
      )}' and '${chk.formatType(rightType)}'`,
      ast,
    );
  },
  evaluate(ev, ast, ctx) {
    return ast.handle(ev.run(ast.condition, ctx), ev, ast, ctx);
  },
};

const orOp: OperatorDef<LogicalOp> = {
  name: '||',
  check: checkLogicalOp,
  evaluate(ev, ast, ctx) {
    const l = ev.tryEval(ast.left, ctx);
    if (l === true) {
      return true;
    }

    if (l === false) {
      const right = ev.run(ast.right, ctx);
      if (typeof right === 'boolean') {
        return right;
      }

      return _logicalOp(true, ev, ast, l, right);
    }

    if (isPromise(l)) {
      return l.then((_l) =>
        _l === true
          ? _l
          : _logicalOp(true, ev, ast, _l, ev.run(ast.right, ctx)),
      );
    }

    return _logicalOp(true, ev, ast, l, ev.run(ast.right, ctx));
  },
};

const andOp: OperatorDef<LogicalOp> = {
  name: '&&',
  check: checkLogicalOp,
  evaluate(ev, ast, ctx) {
    const l = ev.tryEval(ast.left, ctx);
    if (l === false) {
      return false;
    }

    if (l === true) {
      const right = ev.run(ast.right, ctx);
      if (typeof right === 'boolean') {
        return right;
      }

      return _logicalOp(false, ev, ast, l, right);
    }

    if (isPromise(l)) {
      return l.then((_l) =>
        _l === false
          ? _l
          : _logicalOp(false, ev, ast, _l, ev.run(ast.right, ctx)),
      );
    }

    return _logicalOp(false, ev, ast, l, ev.run(ast.right, ctx));
  },
};

const unaryNotOp: OperatorDef<UnaryOp> = {
  name: '!_',
  alias: 'unaryNot',
  check: checkUnary,
  evaluate: evaluateUnary,
};

const unaryMinusOp: OperatorDef<UnaryOp> = {
  name: '-_',
  alias: 'unaryMinus',
  check: checkUnary,
  evaluate: evaluateUnary,
};

function binaryOp(name: BinaryOp): OperatorDef<BinaryOp> {
  return { name, check: checkBinary, evaluate: evaluateBinary };
}

export const OPERATORS = {
  value: valueOp,
  id: idOp,
  '.': fieldAccessOp,
  '.?': optionalFieldAccessOp,
  '[]': bracketAccessOp,
  '[?]': optionalBracketAccessOp,
  call: callOp,
  rcall: rcallOp,
  list: listOp,
  map: mapOp,
  comprehension: comprehensionOp,
  accuValue: accuValueOp,
  accuInc: accuIncOp,
  accuPush: accuPushOp,
  '?:': ternaryOp,
  '||': orOp,
  '&&': andOp,
  '!_': unaryNotOp,
  '-_': unaryMinusOp,
  '!=': binaryOp('!='),
  '==': binaryOp('=='),
  in: binaryOp('in'),
  '+': binaryOp('+'),
  '-': binaryOp('-'),
  '*': binaryOp('*'),
  '/': binaryOp('/'),
  '%': binaryOp('%'),
  '<': binaryOp('<'),
  '<=': binaryOp('<='),
  '>': binaryOp('>'),
  '>=': binaryOp('>='),
  fieldAccess: fieldAccessOp,
  optionalFieldAccess: optionalFieldAccessOp,
  bracketAccess: bracketAccessOp,
  optionalBracketAccess: optionalBracketAccessOp,
  ternary: ternaryOp,
  unaryNot: unaryNotOp,
  unaryMinus: unaryMinusOp,
};
