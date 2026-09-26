import { EvaluationError, evaluationError } from './errors';
import type { ErrorNode } from './errors';
import { UnsignedInt } from './functions';
import { Optional, OPTIONAL_NONE, toggleOptionalTypes } from './optional';
import {
  constructorOf,
  expectDefined,
  getProp,
  hasOwn,
  isAsync,
  isUnknownMap,
  nullObject,
  objEntries,
  objFreeze,
  objKeys,
  RESERVED,
  truthy,
} from './globals';
import type { Base } from './operators';
import type { IdNode, NodeHandle } from './parser';

/**
 * Represents a CEL type value.
 */
export class Type {
  #name: string;
  constructor(name: string) {
    this.#name = name;
    objFreeze(this);
  }

  get name(): string {
    return this.#name;
  }

  get [Symbol.toStringTag](): string {
    return `Type<${this.#name}>`;
  }

  toString(): string {
    return `Type<${this.#name}>`;
  }
}

export const TYPES = {
  string: new Type('string'),
  bool: new Type('bool'),
  int: new Type('int'),
  uint: new Type('uint'),
  double: new Type('double'),
  map: new Type('map'),
  list: new Type('list'),
  bytes: new Type('bytes'),
  null_type: new Type('null'),
  type: new Type('type'),
};

// not exposed to cel expression
const optionalType = new Type('optional');

export type TypeKind =
  | 'primitive'
  | 'list'
  | 'map'
  | 'message'
  | 'enum'
  | 'dyn'
  | 'optional'
  | 'param';

type ValueMatcher = (this: TypeDeclaration, v: unknown, ev: Base) => boolean;

function dyn(this: TypeDeclaration, v: unknown, ev: Base): boolean {
  switch (typeof v) {
    case 'string':
    case 'bigint':
    case 'number':
    case 'boolean':
      return true;
    case 'object': {
      if (v === null) {
        return true;
      }

      const ctor = constructorOf(v);
      switch (ctor) {
        case null:
        case undefined:
        case Object:
        case Map:
        case Array:
        case Set:
          return true;
        default:
          if (ev.objectTypesByConstructor.get(ctor)) {
            return true;
          }
      }

      break;
    }
    case 'symbol':
    case 'undefined':
    case 'function':
      break;
  }

  return ev.debugType(v) !== undefined;
}

const valueTypeMatchers: Readonly<Record<string, ValueMatcher>> = {
  dyn,
  string(v) {
    return typeof v === 'string';
  },
  int(v) {
    return typeof v === 'bigint';
  },
  double(v) {
    return typeof v === 'number';
  },
  bool(v) {
    return typeof v === 'boolean';
  },
  null(v) {
    return v === null;
  },
  bytes(v) {
    return v instanceof Uint8Array;
  },
  uint(v) {
    return v instanceof UnsignedInt;
  },
  type(v) {
    return v instanceof Type;
  },
  list(v) {
    const ctor = truthy(v) ? constructorOf(v) : undefined;
    switch (ctor) {
      case Array:
      case Set:
        return true;
      default:
        return false;
    }
  },
  map(v) {
    const ctor: unknown =
      typeof v === 'object' && v !== null ? constructorOf(v) : null;
    switch (ctor) {
      case undefined:
      case Object:
      case Map:
        return true;
      default:
        return false;
    }
  },
  optional(v) {
    return v instanceof Optional;
  },
  message(v, ev) {
    return this === ev.debugType(v);
  },
  param: dyn,
};

type TypeBindings = Map<string, TypeDeclaration>;

export interface TypeDeclarationOptions {
  kind: TypeKind;
  type: string;
  name: string;
  keyType?: TypeDeclaration | undefined;
  valueType?: TypeDeclaration | undefined;
}

/**
 * Represents a type declaration with metadata about its structure.
 */
export class TypeDeclaration {
  #matchesCache = new WeakMap<TypeDeclaration, boolean>();
  /** The kind of type (primitive, list, map, message, enum, dyn, optional, param). */
  declare readonly kind: TypeKind;
  /** The type name. */
  declare readonly type: string;
  /** The message or enum type name. */
  declare readonly name: string;
  /** For map types, the key type. */
  declare readonly keyType: TypeDeclaration | undefined;
  /** For list and map types, the value type. */
  declare readonly valueType: TypeDeclaration | undefined;
  /** The underlying non-dyn type. */
  declare readonly unwrappedType: TypeDeclaration;
  /** A wrapped dyn variant of this type. */
  declare readonly wrappedType: TypeDeclaration;
  /** True when this declaration contains dyn anywhere in its structure. */
  declare readonly hasDynType: boolean;
  /** True when this declaration contains placeholder type parameters. */
  declare readonly hasPlaceholderType: boolean;
  /** Undefined for types that never describe runtime values, such as `ast`. */
  declare readonly matchesValueType: ValueMatcher | undefined;

  constructor({
    kind,
    type,
    name,
    keyType,
    valueType,
  }: TypeDeclarationOptions) {
    this.kind = kind;
    this.type = type;
    this.name = name;
    this.keyType = keyType;
    this.valueType = valueType;

    this.unwrappedType =
      kind === 'dyn' && valueType ? valueType.unwrappedType : this;
    this.wrappedType =
      kind === 'dyn' ? this : _createDynType(this.unwrappedType);

    this.hasDynType =
      this.kind === 'dyn' ||
      this.valueType?.hasDynType === true ||
      this.keyType?.hasDynType === true;

    this.hasPlaceholderType =
      this.kind === 'param' ||
      this.keyType?.hasPlaceholderType === true ||
      this.valueType?.hasPlaceholderType === true;

    if (kind === 'list') {
      this.fieldLazy = this.#getListField;
    } else if (kind === 'map') {
      this.fieldLazy = this.#getMapField;
    } else if (kind === 'message') {
      this.fieldLazy = this.#getMessageField;
    } else if (kind === 'optional') {
      this.fieldLazy = this.#getOptionalField;
    }

    this.matchesValueType =
      (hasOwn(valueTypeMatchers, name) ? valueTypeMatchers[name] : undefined) ||
      valueTypeMatchers[kind];
    objFreeze(this);
  }

  /** Check if this type is 'dyn' or 'bool'. */
  isDynOrBool(): boolean {
    return this.type === 'bool' || this.kind === 'dyn';
  }

  /** Check if this declaration represents an empty aggregate placeholder. */
  isEmpty(): boolean | undefined {
    return this.valueType && this.valueType.kind === 'param';
  }

  /** Attempt to unify this declaration with another declaration. */
  unify(r: Registry, t2: TypeDeclaration): TypeDeclaration | null | undefined {
    if (this === t2 || this.kind === 'dyn' || t2.kind === 'param') {
      return this;
    }

    if (t2.kind === 'dyn' || this.kind === 'param') {
      return t2;
    }

    if (this.kind !== t2.kind) {
      return null;
    }

    if (!(
      this.hasPlaceholderType ||
      t2.hasPlaceholderType ||
      this.hasDynType ||
      t2.hasDynType
    )) {
      return null;
    }

    const valueType = valueTypeOf(this).unify(r, valueTypeOf(t2));
    if (!valueType) {
      return null;
    }

    switch (this.kind) {
      case 'optional':
        return r.getOptionalType(valueType);
      case 'list':
        return r.getListType(valueType);
      case 'map': {
        const keyType = keyTypeOf(this).unify(r, keyTypeOf(t2));

        return keyType ? r.getMapType(keyType, valueType) : null;
      }
      case 'primitive':
      case 'message':
      case 'enum':
        return undefined;
    }
  }

  /** Replace placeholder types using the provided bindings. */
  templated(r: Registry, bind?: TypeBindings | null): TypeDeclaration {
    if (!this.hasPlaceholderType) {
      return this;
    }

    switch (this.kind) {
      case 'dyn':
        return valueTypeOf(this).templated(r, bind);
      case 'param':
        return bind?.get(this.name) || this;
      case 'map':
        return r.getMapType(
          keyTypeOf(this).templated(r, bind),
          valueTypeOf(this).templated(r, bind),
        );
      case 'list':
        return r.getListType(valueTypeOf(this).templated(r, bind));
      case 'optional':
        return r.getOptionalType(valueTypeOf(this).templated(r, bind));
      case 'primitive':
      case 'message':
      case 'enum':
        return this;
    }
  }

  /** Convert to string representation. */
  toString(): string {
    return this.name;
  }

  #getOptionalField(
    obj: unknown,
    key: unknown,
    ast: ErrorNode | undefined,
    ev: Base,
  ): unknown {
    obj = obj instanceof Optional ? obj.orValue(undefined) : obj;
    if (obj === undefined) {
      return OPTIONAL_NONE;
    }

    const type = ev.debugType(obj);
    if (type.kind === 'primitive' || type.kind === 'enum') {
      throw evaluationError('no_such_key', `No such key: ${String(key)}`, ast);
    }

    try {
      return Optional.of(type.fieldLazy(obj, key, ast, ev));
    } catch (e) {
      if (e instanceof EvaluationError) {
        return OPTIONAL_NONE;
      }

      throw e;
    }
  }

  #getMessageField(
    obj: unknown,
    key: unknown,
    ast: ErrorNode | undefined,
    ev: Base,
  ): unknown {
    if (!truthy(obj)) {
      return undefined;
    }

    const message = ev.objectTypesByConstructor.get(constructorOf(obj));
    if (!message) {
      return undefined;
    }

    const type = message.fields ? message.fields[String(key)] : dynType;
    if (!type) {
      return undefined;
    }

    const value = isUnknownMap(obj) ? obj.get(key) : getProp(obj, key);
    if (value === undefined) {
      return undefined;
    }

    if (matchesValue(type, value, ev)) {
      return value;
    }

    throw evaluationError(
      'field_type_mismatch',
      `Field '${String(key)}' is not of type '${type.name}', got '${ev.debugType(value).name}'`,
      ast,
    );
  }

  #getMapField(
    obj: unknown,
    key: unknown,
    ast: ErrorNode | undefined,
    ev: Base,
  ): unknown {
    let value: unknown;
    if (isUnknownMap(obj)) {
      value = obj.get(key);
    } else if (truthy(obj) && hasOwn(obj, key)) {
      value = getProp(obj, key);
    }

    if (value === undefined) {
      return undefined;
    }

    const valueType = valueTypeOf(this);
    if (matchesValue(valueType, value, ev)) {
      return value;
    }

    throw evaluationError(
      'field_type_mismatch',
      `Field '${String(key)}' is not of type '${valueType.name}', got '${ev.debugType(value).name}'`,
      ast,
    );
  }

  #getListElementAtIndex(list: unknown, pos: number): unknown {
    if (list === undefined || list === null) {
      return undefined;
    }

    const ctor = constructorOf(list);
    switch (ctor) {
      case Array:
        return getProp(list, pos);
      case Set: {
        let i = 0;
        for (const item of iterableOf(list)) {
          if (i++ !== pos) {
            continue;
          }

          return item;
        }
      }
    }

    return undefined;
  }

  #getListField(
    obj: unknown,
    key: unknown,
    ast: ErrorNode | undefined,
    ev: Base,
  ): unknown {
    let index: number;
    if (typeof key === 'bigint') {
      index = Number(key);
    } else if (typeof key === 'number') {
      index = key;
    } else {
      return undefined;
    }

    const value = this.#getListElementAtIndex(obj, index);
    if (value === undefined) {
      if (!truthy(obj)) {
        return undefined;
      }

      throw evaluationError(
        'index_out_of_bounds',
        `No such key: index out of bounds, index ${index} ${
          index < 0 ? '< 0' : `>= size ${String(listSizeForMessage(obj))}`
        }`,
        ast,
      );
    }

    const valueType = valueTypeOf(this);
    if (matchesValue(valueType, value, ev)) {
      return value;
    }

    throw evaluationError(
      'list_item_type_mismatch',
      `List item with index '${index}' is not of type '${valueType.name}', got '${ev.debugType(value).name}'`,
      ast,
    );
  }

  fieldLazy(
    obj: unknown,
    key: unknown,
    ast: ErrorNode | undefined,
    ev: Base,
  ): unknown;
  fieldLazy(): unknown {
    return undefined;
  }

  field(
    obj: unknown,
    key: unknown,
    ast: ErrorNode | undefined,
    ev: Base,
  ): unknown {
    const v = this.fieldLazy(obj, key, ast, ev);
    if (v !== undefined) {
      return v;
    }

    throw evaluationError('no_such_key', `No such key: ${String(key)}`, ast);
  }

  matchesBoth(other: TypeDeclaration): boolean {
    return this.matches(other) && other.matches(this);
  }

  matches(o: TypeDeclaration): boolean {
    const s = this.unwrappedType;
    o = o.unwrappedType;
    if (s === o || s.kind === 'dyn' || o.kind === 'dyn' || o.kind === 'param') {
      return true;
    }

    const cached = this.#matchesCache.get(o);
    if (cached !== undefined) {
      return cached;
    }

    const result = this.#matches(s, o);
    this.#matchesCache.set(o, result);

    return result;
  }

  #matches(s: TypeDeclaration, o: TypeDeclaration): boolean {
    switch (s.kind) {
      case 'dyn':
      case 'param':
        return true;
      case 'list':
        return o.kind === 'list' && valueTypeOf(s).matches(valueTypeOf(o));
      case 'map':
        return (
          o.kind === 'map' &&
          keyTypeOf(s).matches(keyTypeOf(o)) &&
          valueTypeOf(s).matches(valueTypeOf(o))
        );
      case 'optional':
        return o.kind === 'optional' && valueTypeOf(s).matches(valueTypeOf(o));
      case 'primitive':
      case 'message':
      case 'enum':
        return s.name === o.name;
    }
  }
}

function valueTypeOf(t: TypeDeclaration): TypeDeclaration {
  return expectDefined(t.valueType, `value type of '${t.name}'`);
}

function keyTypeOf(t: TypeDeclaration): TypeDeclaration {
  return expectDefined(t.keyType, `key type of '${t.name}'`);
}

/** `for...of` over a value whose constructor is Set, as upstream iterates it. */
function iterableOf(list: NonNullable<unknown>): Iterable<unknown> {
  if (list instanceof Set) {
    return list;
  }

  throw new TypeError('list is not iterable');
}

function listSizeForMessage(list: NonNullable<unknown>): unknown {
  const length = getProp(list, 'length');

  return truthy(length) ? length : getProp(list, 'size');
}

/** Calls the type's runtime matcher. Upstream calls it unguarded, which throws a TypeError for `ast`. */
export function matchesValue(
  type: TypeDeclaration,
  v: unknown,
  ev: Base,
): boolean {
  const matcher = type.matchesValueType;
  if (matcher === undefined) {
    throw new TypeError(`Type '${type.name}' has no runtime value matcher`);
  }

  return matcher.call(type, v, ev);
}

const macroEvaluateErr = `have a .callAst property or .evaluate(checker, macro, ctx) method.`;
const macroTypeCheckErr = `have a .callAst property or .typeCheck(checker, macro, ctx) method.`;
function wrapMacroExpander(
  name: string,
  handler: CallableHandler,
): CallableHandler {
  const p = `Macro '${name}' must`;

  return function macroExpander(opts: unknown): unknown {
    const macro = handler(opts);
    if (!truthy(macro) || typeof macro !== 'object') {
      throw new Error(`${p} return an object.`);
    }

    if (truthy(getProp(macro, 'callAst'))) {
      return macro;
    }

    if (!truthy(getProp(macro, 'evaluate'))) {
      throw new Error(`${p} ${macroEvaluateErr}`);
    }

    if (!truthy(getProp(macro, 'typeCheck'))) {
      throw new Error(`${p} ${macroTypeCheckErr}`);
    }

    return macro;
  };
}

export class VariableDeclaration {
  declare readonly name: string;
  declare readonly type: TypeDeclaration;
  declare readonly description: string | null;
  declare readonly constant: boolean;
  declare readonly value: unknown;

  constructor(
    name: string,
    type: TypeDeclaration,
    description?: string | null,
    value?: unknown,
  ) {
    this.name = name;
    this.type = type;
    this.description = description ?? null;
    this.constant = value !== undefined;
    this.value = value;
    objFreeze(this);
  }
}

/**
 * A function registered with the registry. Handlers declare narrower parameter
 * types than `unknown`; the CEL signature check establishes those types before
 * a handler runs, which TypeScript cannot relate to the signature string.
 */
export type RegisteredFunctionHandler = (...args: never[]) => unknown;

/** The same handler, as the evaluator calls it. The evaluator caches its node callbacks on the function. */
export interface CallableHandler {
  (this: unknown, ...args: unknown[]): unknown;
  __handle?: NodeHandle;
  __rcallHandle?: NodeHandle;
  __asyncBoth?: NodeHandle;
  __asyncFirst?: NodeHandle;
}

function toCallable(handler: RegisteredFunctionHandler): CallableHandler {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- handler parameter types are guaranteed by the CEL signature check before the call, see RegisteredFunctionHandler
  return handler as CallableHandler;
}

export interface FunctionParam {
  name: string;
  type: TypeDeclaration;
  description: string | null;
}

interface FunctionDeclarationOptions {
  name: string | undefined;
  receiverType: TypeDeclaration | null;
  returnType: TypeDeclaration;
  handler: RegisteredFunctionHandler | undefined;
  description: string | undefined;
  params: FunctionParam[];
  async: boolean | undefined;
}

export class FunctionDeclaration {
  declare readonly name: string;
  declare readonly async: boolean;
  declare readonly receiverType: TypeDeclaration | null;
  declare readonly returnType: TypeDeclaration;
  declare readonly description: string | null;
  declare readonly params: FunctionParam[];
  declare readonly argTypes: TypeDeclaration[];
  declare readonly macro: boolean;
  declare readonly signature: string;
  declare readonly handler: CallableHandler;
  declare readonly partitionKey: string;
  declare readonly hasPlaceholderType: boolean;

  constructor({
    name,
    receiverType,
    returnType,
    handler,
    description,
    params,
    async,
  }: FunctionDeclarationOptions) {
    if (typeof name !== 'string') {
      throw new Error('name must be a string');
    }

    if (typeof handler !== 'function') {
      throw new Error('handler must be a function');
    }

    this.name = name;
    this.async = isAsync(handler, async);
    this.receiverType = receiverType ?? null;
    this.returnType = returnType;
    this.description = description ?? null;
    this.params = params;
    this.argTypes = params.map((p) => p.type);
    this.macro = this.argTypes.includes(astType);

    const receiverString = receiverType ? `${receiverType.name}.` : '';
    this.signature = `${receiverString}${name}(${this.argTypes.join(', ')}): ${returnType.name}`;
    this.handler = this.macro
      ? wrapMacroExpander(this.signature, toCallable(handler))
      : toCallable(handler);
    this.partitionKey = `${receiverType ? 'rcall' : 'call'}:${name}:${params.length}`;

    this.hasPlaceholderType =
      this.returnType.hasPlaceholderType ||
      this.receiverType?.hasPlaceholderType === true ||
      this.argTypes.some((t) => t.hasPlaceholderType);

    objFreeze(this);
  }

  matchesArgs(argTypes: readonly TypeDeclaration[]): this | null {
    return argTypes.length === this.argTypes.length &&
      this.argTypes.every((t, i) =>
        t.matches(expectDefined(argTypes[i], 'argument type')),
      )
      ? this
      : null;
  }
}

interface OperatorDeclarationOptions {
  op: string;
  leftType: TypeDeclaration;
  rightType?: TypeDeclaration;
  handler: CallableHandler;
  returnType: TypeDeclaration;
  async: boolean | undefined;
}

export class OperatorDeclaration {
  declare readonly operator: string;
  declare readonly leftType: TypeDeclaration;
  declare readonly rightType: TypeDeclaration | null;
  declare readonly handler: CallableHandler;
  declare readonly async: boolean;
  declare readonly returnType: TypeDeclaration;
  declare readonly signature: string;
  declare readonly hasPlaceholderType: boolean;

  constructor({
    op,
    leftType,
    rightType,
    handler,
    returnType,
    async,
  }: OperatorDeclarationOptions) {
    this.operator = op;
    this.leftType = leftType;
    this.rightType = rightType || null;
    this.handler = handler;
    this.async = isAsync(handler, async);
    this.returnType = returnType;

    if (rightType) {
      this.signature = `${leftType.name} ${op} ${rightType.name}: ${returnType.name}`;
    } else {
      this.signature = `${op}${leftType.name}: ${returnType.name}`;
    }

    this.hasPlaceholderType =
      this.leftType.hasPlaceholderType ||
      this.rightType?.hasPlaceholderType === true;

    objFreeze(this);
  }

  equals(other: OperatorDeclaration): boolean {
    return (
      this.operator === other.operator &&
      this.leftType === other.leftType &&
      this.rightType === other.rightType
    );
  }
}

function _createListType(valueType: TypeDeclaration): TypeDeclaration {
  return new TypeDeclaration({
    kind: 'list',
    name: `list<${valueType.name}>`,
    type: 'list',
    valueType,
  });
}

function _createPrimitiveType(name: string): TypeDeclaration {
  return new TypeDeclaration({ kind: 'primitive', name, type: name });
}

function _createMessageType(name: string): TypeDeclaration {
  return new TypeDeclaration({ kind: 'message', name, type: name });
}

function _createDynType(valueType?: TypeDeclaration): TypeDeclaration {
  const name = valueType ? `dyn<${valueType.name}>` : 'dyn';

  return new TypeDeclaration({ kind: 'dyn', name, type: name, valueType });
}

function _createOptionalType(valueType: TypeDeclaration): TypeDeclaration {
  const name = `optional<${valueType.name}>`;

  return new TypeDeclaration({
    kind: 'optional',
    name,
    type: 'optional',
    valueType,
  });
}

function _createMapType(
  keyType: TypeDeclaration,
  valueType: TypeDeclaration,
): TypeDeclaration {
  return new TypeDeclaration({
    kind: 'map',
    name: `map<${keyType.name}, ${valueType.name}>`,
    type: 'map',
    keyType: keyType,
    valueType: valueType,
  });
}

function _createPlaceholderType(name: string): TypeDeclaration {
  return new TypeDeclaration({ kind: 'param', name, type: name });
}

// Global immutable cache for built-in primitive types (shared across all registries)
const dynType = _createDynType();
const astType = _createPrimitiveType('ast');
const listType = _createListType(dynType);
const mapType = _createMapType(dynType, dynType);

interface CelTypes {
  string: TypeDeclaration;
  bool: TypeDeclaration;
  int: TypeDeclaration;
  uint: TypeDeclaration;
  double: TypeDeclaration;
  bytes: TypeDeclaration;
  dyn: TypeDeclaration;
  null: TypeDeclaration;
  type: TypeDeclaration;
  optional: TypeDeclaration;
  list: TypeDeclaration;
  'list<dyn>': TypeDeclaration;
  map: TypeDeclaration;
  'map<dyn, dyn>': TypeDeclaration;
  [name: string]: TypeDeclaration;
}

const types: CelTypes = {
  string: _createPrimitiveType('string'),
  bool: _createPrimitiveType('bool'),
  int: _createPrimitiveType('int'),
  uint: _createPrimitiveType('uint'),
  double: _createPrimitiveType('double'),
  bytes: _createPrimitiveType('bytes'),
  dyn: dynType,
  null: _createPrimitiveType('null'),
  type: _createPrimitiveType('type'),
  optional: _createOptionalType(dynType),
  list: listType,
  'list<dyn>': listType,
  map: mapType,
  'map<dyn, dyn>': mapType,
};

/**
 * Common CEL type declarations used throughout the registry.
 */
export const celTypes: Readonly<CelTypes> = types;

for (const t of [types.string, types.double, types.int]) {
  const list = _createListType(t);
  const map = _createMapType(types.string, t);
  types[list.name] = list;
  types[map.name] = map;
}

Object.freeze(types);

type Declaration = FunctionDeclaration | OperatorDeclaration;

interface FunctionMatch {
  async: boolean;
  handler: CallableHandler;
  signature: string;
  returnType: TypeDeclaration;
}

export interface BinaryOverload {
  async?: boolean;
  signature?: string;
  handler: CallableHandler;
  leftType?: TypeDeclaration;
  rightType?: TypeDeclaration | null;
  returnType: TypeDeclaration;
}

type BinaryCache<V> = Map<TypeDeclaration, Map<TypeDeclaration, V>>;

export class Candidates<D extends Declaration> {
  returnType: TypeDeclaration | null = null;
  async = false;
  macro: false | FunctionDeclaration = false;
  #unaryMatchCache: Map<TypeDeclaration, OperatorDeclaration | false> | null =
    null;
  #matchCache: BinaryCache<BinaryOverload | false> | null = null;
  #checkCache: BinaryCache<TypeDeclaration | false> | null = null;
  declarations: D[] = [];
  declare readonly registry: Registry;
  constructor(registry: Registry) {
    this.registry = registry;
  }

  [Symbol.iterator](): ArrayIterator<D> {
    return this.declarations[Symbol.iterator]();
  }

  add(decl: D): void {
    this.returnType =
      (this.returnType || decl.returnType).unify(
        this.registry,
        decl.returnType,
      ) || dynType;

    if (decl instanceof FunctionDeclaration && decl.macro) {
      this.macro = decl;
    }

    if (decl.async && !this.async) {
      this.async = true;
    }

    this.declarations.push(decl);
    this.#unaryMatchCache?.clear();
    this.#matchCache?.clear();
    this.#checkCache?.clear();
  }

  findFunction(
    this: Candidates<FunctionDeclaration>,
    argTypes: readonly TypeDeclaration[],
    receiverType: TypeDeclaration | null = null,
  ): FunctionDeclaration | FunctionMatch | null {
    for (const declaration of this.declarations) {
      const match = this.#matchesFunction(declaration, argTypes, receiverType);
      if (match) {
        return match;
      }
    }

    return null;
  }

  findUnaryOverload(
    this: Candidates<OperatorDeclaration>,
    left: TypeDeclaration,
  ): OperatorDeclaration | false {
    const cache = (this.#unaryMatchCache ??= new Map<
      TypeDeclaration,
      OperatorDeclaration | false
    >());
    const cached = cache.get(left);
    if (cached !== undefined) {
      return cached;
    }

    let value: OperatorDeclaration | false = false;
    for (const decl of this.declarations) {
      if (decl.leftType !== left) {
        continue;
      }

      value = decl;
      break;
    }

    cache.set(left, value);

    return value;
  }

  findBinaryOverload(
    this: Candidates<OperatorDeclaration>,
    left: TypeDeclaration,
    right: TypeDeclaration,
  ): BinaryOverload | false {
    if (left.kind === 'dyn' && left.valueType) {
      right = right.wrappedType;
    } else if (right.kind === 'dyn' && right.valueType) {
      left = left.wrappedType;
    }

    const cache = (this.#matchCache ??= new Map<
      TypeDeclaration,
      Map<TypeDeclaration, BinaryOverload | false>
    >());

    return (
      cache.get(left)?.get(right) ??
      this.#cacheBinary(
        cache,
        left,
        right,
        this.#findBinaryUncached(left, right),
      )
    );
  }

  checkBinaryOverload(
    this: Candidates<OperatorDeclaration>,
    left: TypeDeclaration,
    right: TypeDeclaration,
  ): TypeDeclaration | false {
    const cache = (this.#checkCache ??= new Map<
      TypeDeclaration,
      Map<TypeDeclaration, TypeDeclaration | false>
    >());

    return (
      cache.get(left)?.get(right) ??
      this.#cacheBinary(
        cache,
        left,
        right,
        this.#checkBinaryUncached(left, right),
      )
    );
  }

  #cacheBinary<V>(
    c: BinaryCache<V>,
    l: TypeDeclaration,
    r: TypeDeclaration,
    v: V,
  ): V {
    let inner = c.get(l);
    if (!inner) {
      inner = new Map();
      c.set(l, inner);
    }

    inner.set(r, v);

    return v;
  }

  #findBinaryUncached(
    this: Candidates<OperatorDeclaration>,
    left: TypeDeclaration,
    right: TypeDeclaration,
  ): BinaryOverload | false {
    const ops = this.#findBinaryOverloads(left, right);
    const first = ops[0];
    if (first === undefined) {
      return false;
    }

    const second = ops[1];
    if (second === undefined) {
      return first;
    }

    throw new Error(
      `Operator overload '${first.signature}' overlaps with '${second.signature}'.`,
    );
  }

  #checkBinaryUncached(
    this: Candidates<OperatorDeclaration>,
    left: TypeDeclaration,
    right: TypeDeclaration,
  ): TypeDeclaration | false {
    const ops = this.#findBinaryOverloads(left, right);
    const first = ops[0];
    if (first === undefined) {
      return false;
    }

    let rt = first.returnType;
    for (let i = 1; i < ops.length; i++) {
      const op = expectDefined(ops[i], 'operator overload');
      rt = rt.unify(this.registry, op.returnType) || dynType;
    }

    return rt;
  }

  #findBinaryOverloads(
    this: Candidates<OperatorDeclaration>,
    leftType: TypeDeclaration,
    rightType: TypeDeclaration,
  ): readonly BinaryOverload[] {
    const nonexactMatches: BinaryOverload[] = [];
    for (const decl of this.declarations) {
      if (decl.leftType === leftType && decl.rightType === rightType) {
        return [decl];
      }

      const secondary = this.#matchBinaryOverload(decl, leftType, rightType);
      if (secondary !== undefined && secondary !== false) {
        nonexactMatches.push(secondary);
      }
    }

    if (nonexactMatches.length === 0) {
      const op = this.declarations[0]?.operator;
      if ((op === '==' || op === '!=') && leftType.kind === 'dyn') {
        return fallbackDynEqualityMatchers[op];
      }
    }

    return nonexactMatches;
  }

  #matchBinaryOverload(
    decl: OperatorDeclaration,
    actualLeft: TypeDeclaration,
    actualRight: TypeDeclaration,
  ): BinaryOverload | false | undefined {
    const bindings: TypeBindings | null = decl.hasPlaceholderType
      ? new Map()
      : null;
    const leftType = this.#matchTypeWithPlaceholders(
      decl.leftType,
      actualLeft,
      bindings,
    );
    if (!leftType) {
      return undefined;
    }

    const rightType = this.#matchTypeWithPlaceholders(
      expectDefined(decl.rightType, 'binary operator right type'),
      actualRight,
      bindings,
    );
    if (!rightType) {
      return undefined;
    }

    if (
      (decl.operator === '==' || decl.operator === '!=') &&
      decl.leftType.kind === 'dyn' &&
      decl.leftType.valueType &&
      actualLeft.kind !== 'dyn' &&
      actualRight.kind !== 'dyn'
    ) {
      return false;
    }

    return decl.hasPlaceholderType
      ? {
          async: decl.async,
          signature: decl.signature,
          handler: decl.handler,
          leftType,
          rightType,
          returnType: decl.returnType.templated(this.registry, bindings),
        }
      : decl;
  }

  #matchesFunction(
    fn: FunctionDeclaration,
    argTypes: readonly TypeDeclaration[],
    receiverType: TypeDeclaration | null,
  ): FunctionDeclaration | FunctionMatch | null | undefined {
    if (fn.hasPlaceholderType) {
      return this.#matchWithPlaceholders(fn, argTypes, receiverType);
    }

    if (
      receiverType &&
      fn.receiverType &&
      !receiverType.matches(fn.receiverType)
    ) {
      return undefined;
    }

    return fn.matchesArgs(argTypes);
  }

  #matchWithPlaceholders(
    fn: FunctionDeclaration,
    argTypes: readonly TypeDeclaration[],
    receiverType: TypeDeclaration | null,
  ): FunctionMatch | null {
    const bindings: TypeBindings = new Map();
    if (receiverType && fn.receiverType) {
      if (
        !this.#matchTypeWithPlaceholders(
          fn.receiverType,
          receiverType,
          bindings,
        )
      ) {
        return null;
      }
    }

    for (let i = 0; i < argTypes.length; i++) {
      if (
        !this.#matchTypeWithPlaceholders(
          expectDefined(fn.argTypes[i], 'declared argument type'),
          expectDefined(argTypes[i], 'argument type'),
          bindings,
        )
      ) {
        return null;
      }
    }

    return {
      async: fn.async,
      handler: fn.handler,
      signature: fn.signature,
      returnType: fn.returnType.templated(this.registry, bindings),
    };
  }

  #matchTypeWithPlaceholders(
    declared: TypeDeclaration,
    actual: TypeDeclaration,
    bindings: TypeBindings | null,
  ): TypeDeclaration | null {
    if (!declared.hasPlaceholderType) {
      return actual.matches(declared) ? actual : null;
    }

    const treatAsDyn = actual.kind === 'dyn';
    if (
      !this.#collectPlaceholderBindings(declared, actual, bindings, treatAsDyn)
    ) {
      return null;
    }

    if (treatAsDyn) {
      return actual;
    }

    return actual.matches(declared.templated(this.registry, bindings))
      ? actual
      : null;
  }

  #collectPlaceholderBindings(
    dec: TypeDeclaration,
    act: TypeDeclaration | undefined,
    bind: TypeBindings | null,
    fromDyn = false,
  ): boolean {
    if (!dec.hasPlaceholderType) {
      return true;
    }

    if (!act) {
      return false;
    }

    const asDyn = fromDyn || act.kind === 'dyn';
    act = act.unwrappedType;

    switch (dec.kind) {
      case 'param': {
        const bindings = expectDefined(bind, 'placeholder bindings');
        const type = asDyn ? dynType : act;
        const existing = bindings.get(dec.name);
        if (!existing) {
          bindings.set(dec.name, type);

          return true;
        }

        return existing.kind === 'dyn' || type.kind === 'dyn'
          ? true
          : existing.matchesBoth(type);
      }
      case 'list': {
        if (act.name === 'dyn') {
          act = dec;
        }

        if (act.kind !== 'list') {
          return false;
        }

        return this.#collectPlaceholderBindings(
          valueTypeOf(dec),
          act.valueType,
          bind,
          asDyn,
        );
      }
      case 'map': {
        if (act.name === 'dyn') {
          act = dec;
        }

        if (act.kind !== 'map') {
          return false;
        }

        return (
          this.#collectPlaceholderBindings(
            keyTypeOf(dec),
            act.keyType,
            bind,
            asDyn,
          ) &&
          this.#collectPlaceholderBindings(
            valueTypeOf(dec),
            act.valueType,
            bind,
            asDyn,
          )
        );
      }
      case 'optional': {
        if (act.name === 'dyn') {
          act = dec;
        }

        if (act.kind !== 'optional') {
          return false;
        }

        return this.#collectPlaceholderBindings(
          valueTypeOf(dec),
          act.valueType,
          bind,
          asDyn,
        );
      }
      case 'primitive':
      case 'message':
      case 'enum':
      case 'dyn':
        break;
    }

    return true;
  }
}

// Helper function for splitting map type parameters
function splitByComma(str: string): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;

  for (const char of str) {
    if (char === '<') {
      depth++;
    } else if (char === '>') {
      depth--;
    } else if (char === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }

    current += char;
  }

  if (current !== '') {
    parts.push(current.trim());
  }

  return parts;
}

/** A constructor or plain function registered as the runtime representation of a CEL type. */
export type TypeConstructor =
  | (abstract new (...args: never[]) => unknown)
  | ((...args: never[]) => unknown);

export type ValueConverter = (value: unknown) => unknown;

export interface RegisteredType {
  name: string;
  typeType: Type;
  type: TypeDeclaration;
  ctor: TypeConstructor;
  convert?: ValueConverter | undefined;
  fields?: Record<string, TypeDeclaration> | undefined;
}

const objTypesDecls: readonly RegisteredType[] = (
  [
    [UnsignedInt, 'uint', TYPES.uint, celTypes.uint],
    [Type, 'type', TYPES.type, celTypes.type],
    [Optional, 'optional', optionalType, celTypes.optional],
    [Uint8Array, 'bytes', TYPES.bytes, celTypes.bytes],
    ...(typeof Buffer !== 'undefined'
      ? [[Buffer, 'bytes', TYPES.bytes, celTypes.bytes] as const]
      : []),
  ] as const
).map(([ctor, name, typeType, type]) =>
  Object.freeze({ name, typeType, type, ctor }),
);

const objTypes = objTypesDecls.map((t): [string, RegisteredType] => [
  t.name,
  t,
]);
const objTypesCtor = objTypesDecls.map((t): [unknown, RegisteredType] => [
  t.ctor,
  t,
]);

const invalidVar = (postfix: string): Error =>
  new Error(`Invalid variable declaration: ${postfix}`);
const invalidType = (postfix: string): Error =>
  new Error(`Invalid type declaration: ${postfix}`);

const fallbackDynEqualityMatchers: Readonly<
  Record<'==' | '!=', readonly BinaryOverload[]>
> = {
  '==': [{ handler: (a, b) => a === b, returnType: celTypes.bool }],
  '!=': [{ handler: (a, b) => a !== b, returnType: celTypes.bool }],
};

/**
 * Schema definition for inline typed object registration.
 * Maps field names to type strings or nested schemas.
 * When used with `registerVariable`, internally calls `registerType` to create
 * a named type with runtime conversion support.
 */
export interface ObjectSchema {
  [field: string]: string | ObjectSchema;
}

export type RegisteredVariableType = string | TypeDeclaration;

export interface RegisterVariableMetadata {
  description?: string;
}

export interface RegisterVariableTypeOptions extends RegisterVariableMetadata {
  type: RegisteredVariableType;
}

export interface RegisterVariableSchemaOptions extends RegisterVariableMetadata {
  schema: ObjectSchema;
}

export type RegisterVariableOptions =
  RegisterVariableTypeOptions | RegisterVariableSchemaOptions;

export type RegisterVariableDeclaration = {
  name: string;
} & RegisterVariableOptions;

export type RegisterConstantDeclaration = {
  name: string;
  value: unknown;
} & RegisterVariableOptions;

export interface RegisteredFunctionParam {
  name?: string;
  type?: string;
  description?: string;
}

export interface RegisteredFunctionTypedParam extends RegisteredFunctionParam {
  type: string;
}

export interface RegisterFunctionMetadata {
  description?: string;
  params?: RegisteredFunctionParam[];
  async?: boolean;
}

export interface RegisterFunctionOptions extends RegisterFunctionMetadata {
  handler: RegisteredFunctionHandler;
}

export interface RegisterFunctionWithSignature extends RegisterFunctionOptions {
  signature: string;
}

export interface RegisterFunctionWithName extends Omit<
  RegisterFunctionOptions,
  'params'
> {
  name: string;
  receiverType?: string;
  returnType: string;
  params: RegisteredFunctionTypedParam[];
}

export type RegisterFunctionDeclaration =
  RegisterFunctionWithSignature | RegisterFunctionWithName;

/** Operator handlers receive the operands, the AST node and the evaluator. */
export type OperatorHandler = (...args: never[]) => unknown;

export interface RegisterOperatorOptions {
  async?: boolean;
}

export type RegisteredTypeFieldDeclaration =
  | string
  | {
      id?: number;
      keyType?: string;
      map?: boolean;
      repeated?: boolean;
      type?: string;
    };

export interface RegisterTypeWithCtor {
  ctor: TypeConstructor;
  fields?: Record<string, RegisteredTypeFieldDeclaration>;
  convert?: ValueConverter;
}

export interface RegisterTypeWithFields {
  fields: Record<string, RegisteredTypeFieldDeclaration>;
  convert?: ValueConverter;
}

export interface RegisterTypeWithSchema {
  schema: ObjectSchema;
  ctor?: TypeConstructor;
  convert?: ValueConverter;
}

export type NamedTypeIdentity =
  { name: string; fullName?: string } | { fullName: string; name?: string };

export type RegisterTypeDeclaration =
  | ({ name?: string; fullName?: string } & RegisterTypeWithCtor)
  | (NamedTypeIdentity & RegisterTypeWithFields)
  | (NamedTypeIdentity & RegisterTypeWithSchema);

export type RegisterTypeDefinition =
  | TypeConstructor
  | RegisterTypeWithCtor
  | RegisterTypeWithFields
  | RegisterTypeWithSchema;

interface ProtobufResolvedType {
  readonly constructor: { readonly name: string };
  readonly fullName: string;
}

/** A protobufjs field, as passed through `registerType` fields. */
interface ProtobufField {
  id?: number;
  keyType?: string;
  map?: boolean;
  repeated?: boolean;
  type?: string;
  resolvedType?: ProtobufResolvedType | null;
  resolvedKeyType?: ProtobufResolvedType | null;
}

type FieldDeclarationInput = string | ProtobufField;

/** The union of every `registerType` definition shape, as the implementation reads it. */
interface TypeDefinitionInput {
  name?: string | undefined;
  fullName?: string | undefined;
  ctor?: TypeConstructor | undefined;
  fields?: Record<string, FieldDeclarationInput> | undefined;
  schema?: object | undefined;
  convert?: ValueConverter | undefined;
}

/** The union of every `registerVariable`/`registerConstant` declaration shape. */
interface VariableInput {
  name?: string | undefined;
  type?: RegisteredVariableType | undefined;
  schema?: ObjectSchema | undefined;
  description?: string | undefined;
  value?: unknown;
}

/** The union of every `registerFunctionOverload` declaration shape. */
interface FunctionInput {
  signature?: string | undefined;
  name?: string | undefined;
  receiverType?: string | undefined;
  returnType?: string | undefined;
  params?: RegisteredFunctionParam[] | undefined;
  handler?: RegisteredFunctionHandler | undefined;
  description?: string | undefined;
  async?: boolean | undefined;
}

export interface DefinitionVariable {
  name: string;
  description: string | null;
  type: string;
}

export interface DefinitionFunctionParam {
  name: string;
  type: string;
  description: string | null;
}

export interface DefinitionFunction {
  signature: string;
  name: string;
  description: string | null;
  receiverType: string | null;
  returnType: string;
  params: DefinitionFunctionParam[];
}

export interface DefinitionsResult {
  variables: DefinitionVariable[];
  functions: DefinitionFunction[];
}

/**
 * Options for creating a new registry.
 */
export interface RegistryOptions {
  parent?: Registry;
  unlistedVariablesAreDyn?: boolean | undefined;
  enableOptionalTypes?: boolean | undefined;
}

/** Registered variables; `dyn` mirrors `unlistedVariablesAreDyn` for lookups. */
export type VariableMap = Map<string, VariableDeclaration> & { dyn?: boolean };

function nonEmpty(value: string | null | undefined): string | undefined {
  return value === undefined || value === null || value === ''
    ? undefined
    : value;
}

function errorWithUnknownType(
  message: string,
  unknownType: string,
): Error & { unknownType: string } {
  const err = new Error(message);

  return Object.assign(err, { unknownType });
}

/**
 * Registry for managing function overloads, operator overloads, and type mappings.
 */
export class Registry {
  #parent: Registry | null = null;
  #typeDeclarations: Map<string, TypeDeclaration>;

  #ownsVariables = true;
  #operators: OperatorDeclaration[] | null = null;
  #functions: FunctionDeclaration[] | null = null;
  #operatorsByOp: Map<string, Candidates<OperatorDeclaration>> | null = null;
  #functionsByKey: Map<string, Candidates<FunctionDeclaration>> | null = null;
  #listTypes: Map<TypeDeclaration, TypeDeclaration>;
  #mapTypes: Map<TypeDeclaration, Map<TypeDeclaration, TypeDeclaration>>;
  #optionalTypes: Map<TypeDeclaration, TypeDeclaration>;
  #others: {
    operators: OperatorDeclaration[];
    functions: FunctionDeclaration[];
  } | null = null;

  #locked = false;

  /** Whether optional types/functions are enabled for this registry. */
  declare readonly enableOptionalTypes: boolean;
  declare readonly unlistedVariablesAreDyn: boolean;
  /** Registered object types keyed by CEL typename. */
  declare readonly objectTypes: Map<string, RegisteredType>;
  /** Map of constructors to their registered type metadata. */
  declare readonly objectTypesByConstructor: Map<unknown, RegisteredType>;
  /** Registered variables and their type declarations. */
  declare variables: VariableMap;

  constructor(opts: RegistryOptions = {}) {
    this.enableOptionalTypes = opts.enableOptionalTypes ?? false;
    this.unlistedVariablesAreDyn = opts.unlistedVariablesAreDyn ?? false;

    const parent = opts.parent instanceof Registry ? opts.parent : null;
    if (parent) {
      this.#parent = parent;

      let opParent: Registry | null = parent;
      while (opParent && !opParent.#operators) {
        opParent = opParent.#parent;
      }

      let fnParent: Registry | null = parent;
      while (fnParent && !fnParent.#functions) {
        fnParent = fnParent.#parent;
      }

      this.#others = {
        operators: expectDefined(
          expectDefined(opParent, 'operator parent').#operators,
          'parent operators',
        ),
        functions: expectDefined(
          expectDefined(fnParent, 'function parent').#functions,
          'parent functions',
        ),
      };

      this.objectTypes = new Map(parent.objectTypes);
      this.objectTypesByConstructor = new Map(parent.objectTypesByConstructor);
      this.variables = parent.variables;
      this.#ownsVariables = false;
      this.#typeDeclarations = new Map(parent.#typeDeclarations);
      this.#listTypes = parent.#listTypes;
      this.#mapTypes = parent.#mapTypes;
      this.#optionalTypes = parent.#optionalTypes;

      if (
        this.enableOptionalTypes !== parent.enableOptionalTypes ||
        this.unlistedVariablesAreDyn !== parent.unlistedVariablesAreDyn
      ) {
        toggleOptionalTypes(this, this.enableOptionalTypes);
      }
    } else {
      this.#operators = [];
      this.#functions = [];
      this.objectTypes = new Map(objTypes);
      this.objectTypesByConstructor = new Map(objTypesCtor);
      this.#typeDeclarations = new Map(objEntries(celTypes));
      this.#listTypes = new Map();
      this.#mapTypes = new Map();
      this.#optionalTypes = new Map();
      this.variables = new Map();
      this.variables.dyn = this.unlistedVariablesAreDyn;
      for (const [n, t] of objEntries(TYPES)) {
        this.registerConstant(n, 'type', t);
      }
    }
  }

  #ensureOwnVariables(): void {
    if (this.#ownsVariables) {
      return;
    }

    this.variables = new Map(this.variables);
    this.variables.dyn = this.unlistedVariablesAreDyn;
    this.#ownsVariables = true;
  }

  // Used by toggleOptionalTypes in optional.ts to clear a variable before re-registering it
  deleteVariable(name: string): void {
    this.#ensureOwnVariables();
    this.variables.delete(name);
  }

  #pushOperator(decl: OperatorDeclaration): void {
    if (!this.#operators) {
      this.#operatorsByOp = null;
    }

    this.operatorCandidates(decl.operator).add(decl);
    this.#getOperators().push(decl);
  }

  #pushFunction(decl: FunctionDeclaration): void {
    if (!this.#functions) {
      this.#functionsByKey = null;
    }

    this.#functionCandidates(decl.partitionKey).add(decl);
    this.#getFunctions().push(decl);
  }

  #ensureCandiate<D extends Declaration>(
    c: Map<string, Candidates<D>>,
    key: string,
  ): Candidates<D> {
    const existing = c.get(key);
    if (existing) {
      return existing;
    }

    const created = new Candidates<D>(this);
    c.set(key, created);

    return created;
  }

  #getOperators(): OperatorDeclaration[] {
    if (this.#operators) {
      return this.#operators;
    }

    return (this.#operators = [
      ...expectDefined(this.#others, 'inherited declarations').operators,
    ]);
  }

  #getFunctions(): FunctionDeclaration[] {
    if (this.#functions) {
      return this.#functions;
    }

    return (this.#functions = [
      ...expectDefined(this.#others, 'inherited declarations').functions,
    ]);
  }

  operatorCandidates(op: string): Candidates<OperatorDeclaration> {
    if (this.#operatorsByOp) {
      return this.#ensureCandiate(this.#operatorsByOp, op);
    }

    const c = (this.#operatorsByOp = new Map<
      string,
      Candidates<OperatorDeclaration>
    >());
    for (const decl of this.#getOperators()) {
      this.#ensureCandiate(c, decl.operator).add(decl);
    }

    return this.#ensureCandiate(c, op);
  }

  functionCandidates(
    rec: boolean,
    name: string,
    argLen: number,
  ): Candidates<FunctionDeclaration> {
    return this.#functionCandidates(
      `${rec ? 'rcall' : 'call'}:${name}:${argLen}`,
    );
  }

  #functionCandidates(key: string): Candidates<FunctionDeclaration> {
    if (this.#functionsByKey) {
      return this.#ensureCandiate(this.#functionsByKey, key);
    }

    const c = (this.#functionsByKey = new Map<
      string,
      Candidates<FunctionDeclaration>
    >());
    for (const decl of this.#getFunctions()) {
      this.#ensureCandiate(c, decl.partitionKey).add(decl);
    }

    return this.#ensureCandiate(c, key);
  }

  /**
   * Register a variable with its type, throwing if it already exists.
   * When an ObjectSchema is provided via `{schema: ...}`, a type is auto-registered
   * via `registerType` with runtime conversion support.
   * Supports `name + type`, `name + {type|schema}`, and a single declaration object.
   */
  registerVariable(
    name: string,
    type: RegisteredVariableType,
    opts?: RegisterVariableMetadata,
  ): this;
  registerVariable(name: string, options: RegisterVariableOptions): this;
  registerVariable(definition: RegisterVariableDeclaration): this;
  registerVariable(definition: RegisterConstantDeclaration): this;
  registerVariable(definition: VariableInput): this;
  registerVariable(
    name: string | VariableInput,
    type?: RegisteredVariableType | VariableInput,
    opts?: RegisterVariableMetadata,
  ): this;
  registerVariable(
    name: string | VariableInput,
    type?: RegisteredVariableType | VariableInput,
    opts?: RegisterVariableMetadata,
  ): this {
    if (this.#locked) {
      throw new Error('Cannot modify frozen registry');
    }

    let variableName: string | undefined;
    let variableType: RegisteredVariableType | undefined;
    let description = opts?.description;
    let value: unknown;
    if (typeof name === 'object') {
      if (name.schema) {
        variableType = this.registerType({
          name: `$${name.name}`,
          schema: name.schema,
        }).type;
      } else {
        variableType = name.type;
      }

      description = name.description;
      value = name.value;
      variableName = name.name;
    } else if (isVariableInput(type)) {
      variableName = name;
      description = type.description;
      value = type.value;
      if (type.schema) {
        variableType = this.registerType({
          name: `$${name}`,
          schema: type.schema,
        }).type;
      } else {
        variableType = type.type;
      }
    } else {
      variableName = name;
      variableType = type;
    }

    if (typeof variableName !== 'string' || variableName === '') {
      throw invalidVar(`name must be a string`);
    }

    if (RESERVED.has(variableName)) {
      throw invalidVar(`'${variableName}' is a reserved name`);
    }

    if (this.variables.get(variableName) !== undefined) {
      throw invalidVar(`'${variableName}' is already registered`);
    }

    if (typeof variableType === 'string') {
      variableType = this.getType(variableType);
    } else if (!(variableType instanceof TypeDeclaration)) {
      throw invalidVar(`type is required`);
    }

    this.#ensureOwnVariables();
    this.variables.set(
      variableName,
      new VariableDeclaration(variableName, variableType, description, value),
    );

    return this;
  }

  #registerSchemaAsType(
    name: string,
    schema: object | null,
  ): Record<string, string> {
    const fields = nullObject<string>();
    const definitions = expectDefined(schema, `schema of '${name}'`);
    for (const key of objKeys(definitions)) {
      const def = getProp(definitions, key);
      if (typeof def === 'object' && def !== null) {
        fields[key] = this.registerType({
          name: `${name}.${key}`,
          schema: def,
        }).type.name;
      } else if (typeof def === 'string') {
        fields[key] = def;
      } else {
        throw new Error(`Invalid field definition for '${name}.${key}'`);
      }
    }

    return fields;
  }

  /**
   * Register a constant value that is always available without requiring evaluation context.
   * Supports `name + type + value` and a single declaration object.
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
  ): this;
  registerConstant(
    name: string | RegisterConstantDeclaration,
    type?: RegisteredVariableType,
    value?: unknown,
  ): this {
    if (typeof name === 'object') {
      this.registerVariable(name);
    } else {
      this.registerVariable({ name, type, value });
    }

    return this;
  }

  /**
   * Get type declaration for a given type string.
   * @param typename - The type name (e.g., 'string', 'list<int>', 'map<string, bool>')
   * @returns The type declaration instance
   */
  getType(typename: string): TypeDeclaration {
    return this.#parseTypeString(typename, true);
  }

  getListType(type: TypeDeclaration): TypeDeclaration {
    const cached = this.#listTypes.get(type);
    if (cached) {
      return cached;
    }

    const created = this.#parseTypeString(`list<${type.name}>`, true);
    this.#listTypes.set(type, created);

    return created;
  }

  getMapType(a: TypeDeclaration, b: TypeDeclaration): TypeDeclaration {
    const cached = this.#mapTypes.get(a)?.get(b);
    if (cached) {
      return cached;
    }

    let byValue = this.#mapTypes.get(a);
    if (!byValue) {
      byValue = new Map();
      this.#mapTypes.set(a, byValue);
    }

    const created = this.#parseTypeString(`map<${a.name}, ${b.name}>`, true);
    byValue.set(b, created);

    return created;
  }

  getOptionalType(type: TypeDeclaration): TypeDeclaration {
    const cached = this.#optionalTypes.get(type);
    if (cached) {
      return cached;
    }

    const created = this.#parseTypeString(`optional<${type.name}>`, true);
    this.#optionalTypes.set(type, created);

    return created;
  }

  assertType(
    typename: string,
    type: string,
    signature: string,
  ): TypeDeclaration {
    try {
      return this.#parseTypeString(typename, true);
    } catch (e) {
      if (e instanceof Error) {
        const unknownType = 'unknownType' in e ? e.unknownType : undefined;
        e.message = `Invalid ${type} '${typeof unknownType === 'string' && unknownType !== '' ? unknownType : typename}' in '${signature}'`;
      }

      throw e;
    }
  }

  getFunctionType(typename: string | undefined): TypeDeclaration {
    if (typename === 'ast') {
      return astType;
    }

    const t = this.#parseTypeString(typename, true);
    if (t.kind === 'dyn' && t.valueType) {
      throw new Error(`type '${t.name}' is not supported`);
    }

    return t;
  }

  /**
   * Register a custom type with its constructor and optional field definitions.
   * When `ctor` is omitted but `fields` is provided, an internal wrapper class is auto-generated
   * and a default `convert` function is created to wrap plain objects at runtime.
   * @param typename - The name of the type
   * @param definition - A constructor function or registration object with ctor, fields, schema, and/or convert
   */
  registerType(
    typename: string,
    definition: RegisterTypeDefinition,
  ): RegisteredType;
  registerType(definition: RegisterTypeDeclaration): RegisteredType;
  registerType(
    typename: string | TypeDefinitionInput,
    definition?: TypeConstructor | TypeDefinitionInput,
  ): RegisteredType;
  registerType(
    typename: string | TypeDefinitionInput,
    definition?: TypeConstructor | TypeDefinitionInput,
  ): RegisteredType {
    if (this.#locked) {
      throw new Error('Cannot modify frozen registry');
    }

    let _d = definition;
    let name: string | undefined;
    if (typeof typename === 'object') {
      _d = typename;
      name = nonEmpty(_d.fullName) ?? nonEmpty(_d.name) ?? _d.ctor?.name;
    } else {
      name = typename;
    }

    if (typeof name === 'string' && name[0] === '.') {
      name = name.slice(1);
    }

    if (typeof name !== 'string' || name.length < 2 || RESERVED.has(name)) {
      throw invalidType(`name '${String(name)}' is not valid`);
    }

    if (this.objectTypes.has(name)) {
      throw invalidType(`type '${name}' already registered`);
    }

    const type = this.#parseTypeString(name, false);
    if (type.kind !== 'message') {
      throw invalidType(`type '${name}' is not valid`);
    }

    const schema: unknown =
      typeof _d === 'function' ? getProp(_d, 'schema') : _d?.schema;
    const draft = {
      name,
      typeType: new Type(name),
      type,
      ctor: typeof _d === 'function' ? _d : _d?.ctor,
      convert: typeof _d === 'function' ? undefined : _d?.convert,
      fields:
        typeof schema === 'object'
          ? this.#normalizeFields(
              name,
              this.#registerSchemaAsType(name, schema),
            )
          : this.#normalizeFields(
              name,
              typeof _d === 'function' ? undefined : _d?.fields,
            ),
    };

    const decl = hasConstructor(draft)
      ? draft
      : this.#withDefaultConvert(name, draft);

    const registered = Object.freeze(decl);
    this.objectTypes.set(name, registered);
    this.objectTypesByConstructor.set(registered.ctor, registered);
    this.registerFunctionOverload(
      `type(${name}): type`,
      () => registered.typeType,
      {
        async: false,
      },
    );

    return registered;
  }

  #withDefaultConvert<
    T extends { fields: Record<string, TypeDeclaration> | undefined },
  >(
    name: string,
    draft: T,
  ): T & { ctor: TypeConstructor; convert: ValueConverter } {
    if (!draft.fields) {
      throw invalidType(`type '${name}' requires a constructor or fields`);
    }

    return Object.assign(draft, this.#createDefaultConvert(name, draft.fields));
  }

  #parseTypeString(
    typeStr: string | undefined,
    requireKnownTypes = true,
  ): TypeDeclaration {
    const known =
      typeStr === undefined ? undefined : this.#typeDeclarations.get(typeStr);
    if (known) {
      return known;
    }

    if (typeof typeStr !== 'string' || typeStr.length === 0) {
      throw new Error(`Invalid type: must be a string`);
    }

    if (/^[A-Z]$/.test(typeStr)) {
      return this.#createDeclaration(_createPlaceholderType, typeStr, typeStr);
    }

    const match = typeStr.match(/^(dyn|list|map|optional)<(.+)>$/);
    if (!match) {
      if (requireKnownTypes) {
        throw errorWithUnknownType(`Unknown type: ${typeStr}`, typeStr);
      }

      return this.#createDeclaration(_createMessageType, typeStr, typeStr);
    }

    const kind = match[1];
    const inner = expectDefined(match[2], 'type parameter').trim();
    switch (kind) {
      case 'dyn': {
        const type = this.#parseTypeString(
          inner,
          requireKnownTypes,
        ).wrappedType;
        this.#typeDeclarations.set(type.name, type);

        return type;
      }
      case 'list': {
        const vType = this.#parseTypeString(inner, requireKnownTypes);

        return this.#createDeclaration(
          _createListType,
          `list<${vType.name}>`,
          vType,
        );
      }
      case 'map': {
        const parts = splitByComma(inner);
        if (parts.length !== 2) {
          throw new Error(`Invalid map type: ${typeStr}`);
        }

        const kType = this.#parseTypeString(
          expectDefined(parts[0], 'map key type'),
          requireKnownTypes,
        );
        const vType = this.#parseTypeString(
          expectDefined(parts[1], 'map value type'),
          requireKnownTypes,
        );

        return this.#createDeclaration(
          _createMapType,
          `map<${kType.name}, ${vType.name}>`,
          kType,
          vType,
        );
      }
      case undefined:
      default: {
        const vType = this.#parseTypeString(inner, requireKnownTypes);

        return this.#createDeclaration(
          _createOptionalType,
          `optional<${vType.name}>`,
          vType,
        );
      }
    }
  }

  #createDeclaration<A extends unknown[]>(
    creator: (...args: A) => TypeDeclaration,
    key: string,
    ...args: A
  ): TypeDeclaration {
    const existing = this.#typeDeclarations.get(key);
    if (existing) {
      return existing;
    }

    const created = creator(...args);
    this.#typeDeclarations.set(key, created);

    return created;
  }

  findMacro(
    name: string,
    hasReceiver: boolean,
    argLen: number,
  ): false | FunctionDeclaration {
    return this.functionCandidates(hasReceiver, name, argLen).macro;
  }

  findUnaryOverload(
    op: string,
    left: TypeDeclaration,
  ): OperatorDeclaration | false {
    return this.operatorCandidates(op).findUnaryOverload(left);
  }

  findBinaryOverload(
    op: string,
    left: TypeDeclaration,
    right: TypeDeclaration,
  ): BinaryOverload | false {
    return this.operatorCandidates(op).findBinaryOverload(left, right);
  }

  #toCelFieldType(field: FieldDeclarationInput): ProtobufField {
    if (typeof field === 'string') {
      return { type: field };
    }

    if (truthy(field.id)) {
      return protobufjsFieldToCelType(field);
    }

    return field;
  }

  #toCelFieldDeclaration(
    typename: string,
    fields: Record<string, FieldDeclarationInput>,
    k: string,
    requireKnownTypes = false,
  ): TypeDeclaration {
    try {
      const field = this.#toCelFieldType(expectDefined(fields[k], 'field'));
      if (typeof field.type !== 'string') {
        throw new Error(`unsupported declaration`);
      }

      return this.#parseTypeString(field.type, requireKnownTypes);
    } catch (e) {
      if (e instanceof Error) {
        e.message =
          `Field '${k}' in type '${typename}' has unsupported declaration: ` +
          `${JSON.stringify(fields[k])}`;
      }

      throw e;
    }
  }

  #normalizeFields(
    typename: string,
    fields: Record<string, FieldDeclarationInput> | undefined,
  ): Record<string, TypeDeclaration> | undefined {
    if (!fields) {
      return undefined;
    }

    const all = nullObject<TypeDeclaration>();
    for (const k of objKeys(fields)) {
      all[k] = this.#toCelFieldDeclaration(typename, fields, k);
    }

    return all;
  }

  #createDefaultConvert(
    name: string,
    fields: Record<string, TypeDeclaration>,
  ): { ctor: TypeConstructor; convert: ValueConverter } {
    const keys = objKeys(fields);

    const conversions = nullObject<ConvertibleType | false>();
    for (const k of keys) {
      const type = expectDefined(fields[k], 'field type');
      const decl = type.kind === 'message' && this.objectTypes.get(type.name);
      if (decl === undefined) {
        throw invalidType(
          `Field '${k}' in type '${name}' references unregistered type '${type.name}'`,
        );
      }

      conversions[k] = decl !== false && hasConvert(decl) ? decl : false;
    }

    const classes = {
      [name]: class extends Map<string, unknown> {
        #raw: unknown;
        constructor(v: unknown) {
          super();
          this.#raw = v;
        }

        [Symbol.iterator](): MapIterator<[string, unknown]> {
          if (this.size !== keys.length) {
            for (const k of keys) {
              this.get(k);
            }
          }

          return super[Symbol.iterator]();
        }

        get(field: string): unknown {
          let v = super.get(field);
          if (v !== undefined || this.has(field)) {
            return v;
          }

          const dec = conversions[field];
          if (dec === undefined) {
            return undefined;
          }

          const raw = this.#raw;
          if (raw instanceof Map) {
            v = raw.get(field);
          } else if (raw === undefined || raw === null) {
            v = undefined;
          } else {
            v = getProp(raw, field);
          }

          if (dec !== false && truthy(v) && typeof v === 'object') {
            const ctor = constructorOf(v);
            switch (ctor) {
              case undefined:
              case Object:
              case Map:
                v = dec.convert(v);
            }
          }

          return (super.set(field, v), v);
        }
      },
    };
    const Ctor = expectDefined(classes[name], 'generated type class');

    return {
      ctor: Ctor,
      convert(v: unknown): unknown {
        if (!truthy(v)) {
          return undefined;
        }

        if (constructorOf(v) === Ctor) {
          return v;
        }

        return new Ctor(v);
      },
    };
  }

  /**
   * Clone this registry to create a new isolated instance.
   * @returns A new registry sharing the parent's registrations until either side changes
   */
  clone(opts: {
    unlistedVariablesAreDyn?: boolean;
    enableOptionalTypes?: boolean;
  }): Registry {
    this.#locked = true;

    return new Registry({
      parent: this,
      unlistedVariablesAreDyn: opts.unlistedVariablesAreDyn,
      enableOptionalTypes: opts.enableOptionalTypes,
    });
  }

  /** Read back user-facing variable/function definitions. */
  getDefinitions(): DefinitionsResult {
    const variables: DefinitionVariable[] = [];
    const functions: DefinitionFunction[] = [];
    for (const [, varDecl] of this.variables) {
      variables.push({
        name: varDecl.name,
        description: nonEmpty(varDecl.description) ?? null,
        type: varDecl.type.name,
      });
    }

    for (const decl of this.#getFunctions()) {
      functions.push({
        signature: decl.signature,
        name: decl.name,
        description: decl.description,
        receiverType: decl.receiverType ? decl.receiverType.name : null,
        returnType: decl.returnType.name,
        params: decl.params.map((p) => ({
          name: p.name,
          type: p.type.name,
          description: p.description,
        })),
      });
    }

    return { variables, functions };
  }

  #parseSignature(signature: unknown): {
    receiverType: string | null;
    name: string;
    argTypes: string[];
    returnType: string;
  } {
    if (typeof signature !== 'string') {
      throw new Error('Invalid signature: must be a string');
    }

    const match = signature.match(
      /^(?:([a-zA-Z0-9.<>]+)\.)?(\w+)\(([^)]*)\):(.*)$/,
    );
    if (!match) {
      throw new Error(`Invalid signature: ${signature}`);
    }

    const returnType = expectDefined(match[4], 'return type').trim();
    if (returnType === '') {
      throw new Error(`Invalid signature: ${signature}`);
    }

    return {
      receiverType: match[1] ?? null,
      name: expectDefined(match[2], 'function name'),
      argTypes: splitByComma(expectDefined(match[3], 'argument list')),
      returnType,
    };
  }

  #functionSignatureOverlaps(
    a: FunctionDeclaration,
    b: FunctionDeclaration,
  ): boolean {
    if (a.name !== b.name) {
      return false;
    }

    if (a.argTypes.length !== b.argTypes.length) {
      return false;
    }

    if (
      (a.receiverType || b.receiverType) &&
      (!a.receiverType || !b.receiverType)
    ) {
      return false;
    }

    const isDifferentReceiver =
      a.receiverType !== b.receiverType &&
      a.receiverType !== dynType &&
      b.receiverType !== dynType;

    return (
      !isDifferentReceiver &&
      (b.macro ||
        a.macro ||
        b.argTypes.every((t, i) => {
          const o = a.argTypes[i];

          return t === o || t === dynType || o === dynType;
        }))
    );
  }

  #checkOverlappingSignatures(newDec: FunctionDeclaration): void {
    for (const decl of this.#functionCandidates(newDec.partitionKey)) {
      if (!this.#functionSignatureOverlaps(decl, newDec)) {
        continue;
      }

      throw new Error(
        `Function signature '${newDec.signature}' overlaps with existing overload '${decl.signature}'.`,
      );
    }
  }

  #normalizeParam(
    i: number,
    aType: string | undefined,
    param: RegisteredFunctionParam | undefined,
  ): FunctionParam {
    if (!param) {
      return {
        type: this.getFunctionType(aType),
        name: `arg${i}`,
        description: null,
      };
    }

    const type = nonEmpty(param.type) ?? aType;
    if (type === undefined || type === '') {
      throw new Error(`params[${i}].type is required`);
    }

    if (aType !== undefined && aType !== '' && type !== aType) {
      throw new Error(`params[${i}].type not equal to signature type`);
    }

    return {
      name: nonEmpty(param.name) ?? `arg${i}`,
      type: this.getFunctionType(type),
      description: param.description ?? null,
    };
  }

  /**
   * Register a function overload.
   * Supports signature-based registration as well as a single declaration object.
   */
  registerFunctionOverload(
    signature: string,
    handler: RegisteredFunctionHandler,
    opts?: RegisterFunctionMetadata,
  ): void;
  registerFunctionOverload(
    signature: string,
    options: RegisterFunctionOptions,
  ): void;
  registerFunctionOverload(definition: RegisterFunctionDeclaration): void;
  registerFunctionOverload(
    s: string | FunctionInput,
    handler?: RegisteredFunctionHandler | FunctionInput,
    opts?: FunctionInput,
  ): void;
  registerFunctionOverload(
    s: string | FunctionInput,
    handler?: RegisteredFunctionHandler | FunctionInput,
    opts?: FunctionInput,
  ): void {
    if (this.#locked) {
      throw new Error('Cannot modify frozen registry');
    }

    let options: FunctionInput;
    if (typeof s === 'object') {
      options = s;
    } else if (typeof handler === 'object') {
      options = handler;
    } else {
      options = truthy(opts) ? opts : {};
    }

    const sig = typeof s === 'string' ? s : (options.signature ?? undefined);
    const parsed = sig !== undefined ? this.#parseSignature(sig) : undefined;
    const name = nonEmpty(parsed?.name) ?? options.name;
    const receiverType = nonEmpty(parsed?.receiverType) ?? options.receiverType;
    const argTypes = parsed?.argTypes;
    const returnType = nonEmpty(parsed?.returnType) ?? options.returnType;
    const params = options.params;
    const fn = typeof handler === 'function' ? handler : options.handler;

    let dec: FunctionDeclaration;
    try {
      if (name === undefined || name === '') {
        throw new Error(`signature or name are required`);
      }

      if (returnType === undefined || returnType === '') {
        throw new Error(`must have a returnType`);
      }

      const paramList = argTypes ?? params;
      if (paramList === undefined) {
        throw new Error(`signature or params are required`);
      }

      if (params && argTypes && params.length !== argTypes.length) {
        throw new Error(`mismatched length in params and args in signature`);
      }

      dec = new FunctionDeclaration({
        name,
        async: options.async,
        receiverType:
          receiverType !== undefined && receiverType !== ''
            ? this.getType(receiverType)
            : null,
        returnType: this.getType(returnType),
        handler: fn,
        description: options.description,
        params: paramList.map((_, i) =>
          this.#normalizeParam(i, argTypes?.[i], params?.[i]),
        ),
      });
    } catch (e) {
      if (e instanceof Error) {
        if (typeof sig === 'string') {
          e.message = `Invalid function declaration '${sig}': ${e.message}`;
        } else if (name !== undefined && name !== '') {
          e.message = `Invalid function declaration '${name}': ${e.message}`;
        } else {
          e.message = `Invalid function declaration: ${e.message}`;
        }
      }

      throw e;
    }

    this.#checkOverlappingSignatures(dec);
    this.#pushFunction(dec);
  }

  /**
   * Register an operator overload.
   * @param signature - Operator signature in format 'type1 op type2' (e.g., 'Vector + Vector')
   * @param handler - The operator implementation
   */
  registerOperatorOverload(
    string: string,
    handler: OperatorHandler,
    opts?: RegisterOperatorOptions,
  ): void {
    // Parse with optional return type: "Vector + Vector: Vector" or "Vector + Vector"
    const unaryParts = string.match(/^([-!])([\w.<>]+)(?::\s*([\w.<>]+))?$/);
    if (unaryParts) {
      const [, op, operandType, returnType] = unaryParts;

      return this.unaryOverload(
        expectDefined(op, 'operator'),
        expectDefined(operandType, 'operand type'),
        handler,
        returnType,
        opts?.async,
      );
    }

    const parts = string.match(
      /^([\w.<>]+) ([-+*%/]|==|!=|<|<=|>|>=|in) ([\w.<>]+)(?::\s*([\w.<>]+))?$/,
    );
    if (!parts) {
      throw new Error(`Operator overload invalid: ${string}`);
    }

    const [, leftType, op, rightType, returnType] = parts;

    return this.binaryOverload(
      expectDefined(leftType, 'left type'),
      expectDefined(op, 'operator'),
      expectDefined(rightType, 'right type'),
      handler,
      returnType,
      opts?.async,
    );
  }

  /**
   * Register a unary operator overload.
   * @param op - The operator symbol ('-' or '!')
   * @param typeStr - The operand type
   * @param handler - The operator implementation
   * @param returnTypeStr - Optional return type (defaults to operand type)
   */
  unaryOverload(
    op: string,
    typeStr: string,
    handler: OperatorHandler,
    returnTypeStr?: string,
    async?: boolean,
  ): void {
    if (this.#locked) {
      throw new Error('Cannot modify frozen registry');
    }

    const leftType = this.assertType(typeStr, 'type', `${op}${typeStr}`);
    const returnTypeName = nonEmpty(returnTypeStr) ?? typeStr;
    const returnType = this.assertType(
      returnTypeName,
      'return type',
      `${op}${typeStr}: ${returnTypeName}`,
    );

    const d = new OperatorDeclaration({
      op: `${op}_`,
      leftType,
      returnType,
      handler: toCallable(handler),
      async,
    });
    this.#pushOperator(this.#assertOverload(d));
  }

  #hasOverload(d: OperatorDeclaration): boolean {
    for (const o of this.operatorCandidates(d.operator)) {
      if (d.equals(o)) {
        return true;
      }
    }

    return false;
  }

  #assertOverload(decl: OperatorDeclaration): OperatorDeclaration {
    if (!this.#hasOverload(decl)) {
      return decl;
    }

    throw new Error(`Operator overload already registered: ${decl.signature}`);
  }

  /**
   * Register a binary operator overload.
   * @param leftTypeStr - The left operand type
   * @param op - The operator symbol
   * @param rightTypeStr - The right operand type
   * @param handler - The operator implementation
   * @param returnTypeStr - Optional return type
   */
  binaryOverload(
    leftTypeStr: string,
    op: string,
    rightTypeStr: string,
    handler: OperatorHandler,
    returnTypeStr?: string,
    async?: boolean,
  ): void {
    if (this.#locked) {
      throw new Error('Cannot modify frozen registry');
    }

    returnTypeStr ??= isRelational.has(op) ? 'bool' : leftTypeStr;

    const sig = `${leftTypeStr} ${op} ${rightTypeStr}: ${returnTypeStr}`;
    let leftType = this.assertType(leftTypeStr, 'left type', sig);
    let rightType = this.assertType(rightTypeStr, 'right type', sig);
    const returnType = this.assertType(returnTypeStr, 'return type', sig);

    // Register both types as wrapped with dyn<> if one of them is wrapped
    if (leftType.kind === 'dyn' && leftType.valueType) {
      rightType = rightType.wrappedType;
    } else if (rightType.kind === 'dyn' && rightType.valueType) {
      leftType = leftType.wrappedType;
    }

    if (isRelational.has(op) && returnType.type !== 'bool') {
      throw new Error(
        `Comparison operator '${op}' must return 'bool', got '${returnType.type}'`,
      );
    }

    const fn = toCallable(handler);
    const dec = new OperatorDeclaration({
      op,
      leftType,
      rightType,
      returnType,
      handler: fn,
      async,
    });
    if (
      dec.hasPlaceholderType &&
      !(rightType.hasPlaceholderType && leftType.hasPlaceholderType)
    ) {
      throw new Error(
        `Operator overload with placeholders must use them in both left and right types: ${sig}`,
      );
    }

    this.#assertOverload(dec);
    if (op === '==') {
      const declarations = [
        new OperatorDeclaration({
          op: '!=',
          leftType,
          rightType,
          handler(a, b, ast, ev) {
            return !truthy(fn(a, b, ast, ev));
          },
          returnType,
          async,
        }),
      ];

      if (leftType !== rightType) {
        declarations.push(
          new OperatorDeclaration({
            op: '==',
            leftType: rightType,
            rightType: leftType,
            handler(a, b, ast, ev) {
              return fn(b, a, ast, ev);
            },
            returnType,
            async,
          }),
          new OperatorDeclaration({
            op: '!=',
            leftType: rightType,
            rightType: leftType,
            handler(a, b, ast, ev) {
              return !truthy(fn(b, a, ast, ev));
            },
            returnType,
            async,
          }),
        );
      }

      for (const decl of declarations) {
        this.#assertOverload(decl);
      }

      for (const decl of declarations) {
        this.#pushOperator(decl);
      }
    }

    this.#pushOperator(dec);
  }
}

type ConvertibleType = RegisteredType & { convert: ValueConverter };

/** Matches upstream's `typeof type === 'object' && !(type instanceof TypeDeclaration)`, which includes null. */
function isVariableInput(
  type: RegisteredVariableType | VariableInput | undefined,
): type is VariableInput {
  return typeof type === 'object' && !(type instanceof TypeDeclaration);
}

function hasConvert(decl: RegisteredType): decl is ConvertibleType {
  return truthy(decl.convert);
}

function hasConstructor<T extends { ctor?: TypeConstructor | undefined }>(
  draft: T,
): draft is T & { ctor: TypeConstructor } {
  return typeof draft.ctor === 'function';
}

const isRelational: ReadonlySet<string> = new Set([
  '<',
  '<=',
  '>',
  '>=',
  '==',
  '!=',
  'in',
]);

/**
 * Create a new registry instance.
 * @param opts - Optional initial configuration
 * @returns A new registry instance
 */
export function createRegistry(opts?: RegistryOptions): Registry {
  return new Registry(opts);
}

export type ContextObject = Record<string, unknown>;

/**
 * Root context wiring together registered variable types and fallback values.
 */
export class RootContext {
  #vars: VariableMap;
  #contextObj: ContextObject | undefined;
  #contextMap: Map<string, unknown> | undefined;
  #convertCache: Map<string, unknown> | undefined;
  constructor(
    registry: Registry,
    context?: Map<string, unknown> | ContextObject | null,
  ) {
    this.#vars = registry.variables;
    if (context === undefined || context === null) {
      return;
    }

    if (typeof context !== 'object') {
      throw evaluationError('invalid_context', 'EvalContext must be an object');
    }

    if (context instanceof Map) {
      this.#contextMap = context;
    } else {
      this.#contextObj = context;
    }
  }

  /** Look up the fallback value (built-ins) for a name. */
  getValue(key: string): unknown {
    const converted = this.#convertCache?.get(key);
    if (truthy(converted)) {
      return converted;
    }

    return this.#contextObj
      ? this.#contextObj[key]
      : this.#contextMap?.get(key);
  }

  getVariable(name: string): VariableDeclaration | undefined {
    return (
      this.#vars.get(name) ??
      (this.#vars.dyn === true && !RESERVED.has(name)
        ? new VariableDeclaration(name, dynType)
        : undefined)
    );
  }

  getCheckedValue(ev: Base, ast: IdNode): unknown {
    const v = this.getValue(ast.args);
    if (v === undefined) {
      throw ev.createError(
        'unknown_variable',
        `Unknown variable: ${ast.args}`,
        ast,
      );
    }

    const type = expectDefined(ast.checkedType, 'checked type');
    if (matchesValue(type, v, ev)) {
      return v;
    }

    const valueType = ev.debugType(v);
    // Convert plain objects to typed instances when a convert function is registered
    if (type.kind === 'message' && valueType.kind === 'map') {
      const c = ev.objectTypes.get(type.name)?.convert?.(v);
      if (truthy(c)) {
        (this.#convertCache ??= new Map()).set(ast.args, c);

        return c;
      }
    }

    throw ev.createError(
      'variable_type_mismatch',
      `Variable '${ast.args}' is not of type '${type.name}', got '${valueType.name}'`,
      ast,
    );
  }

  /** Fork with a placeholder variable binding (used for comprehensions). */
  forkWithVariable(iterVar: string, iterType: TypeDeclaration): OverlayContext {
    return new OverlayContext(this, iterVar, iterType);
  }
}

/**
 * Overlay context layered on top of the root context for evaluation/type-checking.
 */
class OverlayContext {
  #parent: EvalContext;
  accuType: TypeDeclaration | undefined;
  accuValue: unknown;
  iterValue: unknown;
  declare readonly iterVar: string;
  declare readonly iterType: TypeDeclaration;
  /** Set once evaluation through this context has gone async; later runs then fork instead of reusing it. */
  declare async?: boolean;
  constructor(parent: EvalContext, iterVar: string, iterType: TypeDeclaration) {
    this.#parent = parent;
    this.iterVar = iterVar;
    this.iterType = iterType;
  }

  /** Fork with a placeholder variable binding (used for comprehensions). */
  forkWithVariable(iterVar: string, iterType: TypeDeclaration): OverlayContext {
    return new OverlayContext(this, iterVar, iterType);
  }

  reuse(parent: EvalContext): OverlayContext {
    if (this.async !== true) {
      return ((this.#parent = parent), this);
    }

    const ctx = new OverlayContext(parent, this.iterVar, this.iterType);
    ctx.accuType = this.accuType;

    return ctx;
  }

  /** Set the iteration variable value */
  setIterValue(v: unknown, ev: Base): this {
    if (matchesValue(this.iterType, v, ev)) {
      return ((this.iterValue = v), this);
    }

    const type = this.iterType;
    const valueType = ev.debugType(v);
    // Convert plain objects to typed instances when a convert function is registered
    if (type.kind === 'message' && valueType.kind === 'map') {
      const c = ev.objectTypes.get(type.name)?.convert?.(v);
      if (truthy(c)) {
        return ((this.iterValue = c), this);
      }
    }

    throw ev.createError(
      'variable_type_mismatch',
      `Variable '${this.iterVar}' is not of type '${type.name}', got '${valueType.name}'`,
    );
  }

  /** Set a accumulator variable type */
  setAccuType(type: TypeDeclaration): this {
    return ((this.accuType = type), this);
  }

  /** Set a accumulator variable value */
  setAccuValue(v: unknown): this {
    return ((this.accuValue = v), this);
  }

  /** Resolve a value by name, falling back to parent scopes. */
  getValue(key: string): unknown {
    return this.iterVar === key ? this.iterValue : this.#parent.getValue(key);
  }

  getCheckedValue(ev: Base, ast: IdNode): unknown {
    if (this.iterVar === ast.args) {
      return this.iterValue;
    }

    return this.#parent.getCheckedValue(ev, ast);
  }

  getVariable(name: string): VariableDeclaration | undefined {
    if (this.iterVar === name) {
      return new VariableDeclaration(name, this.iterType);
    }

    return this.#parent.getVariable(name);
  }
}

export type { OverlayContext };

/** Evaluation and type-checking scope: the root context or a comprehension overlay. */
export type EvalContext = RootContext | OverlayContext;

/**
 * Map a protobufjs field to a CEL field declaration.
 */
function protobufjsFieldToCelType(field: ProtobufField): ProtobufField {
  let fieldType: string;
  if (truthy(field.map)) {
    const keyType = protobufjsTypeToCelType(
      field.keyType,
      field.resolvedKeyType,
    );
    const valueType = protobufjsTypeToCelType(field.type, field.resolvedType);
    fieldType = `map<${keyType}, ${valueType}>`;
  } else {
    fieldType = protobufjsTypeToCelType(field.type, field.resolvedType);
  }

  return { type: truthy(field.repeated) ? `list<${fieldType}>` : fieldType };
}

/**
 * Map protobuf type names to CEL type names.
 * @param protoType - The protobuf type name
 * @param resolvedType - The resolved type for message/enum fields
 * @returns The CEL type name
 */
function protobufjsTypeToCelType(
  protoType: string | undefined,
  resolvedType: ProtobufResolvedType | null | undefined,
): string {
  switch (protoType) {
    case 'string':
      return 'string';
    case 'bytes':
      return 'bytes';
    case 'bool':
      return 'bool';
    // protobufjs uses JavaScript numbers for all numeric types
    case 'double':
    case 'float':
    case 'int32':
    case 'int64':
    case 'sint32':
    case 'sint64':
    case 'sfixed32':
    case 'sfixed64':
    case 'uint32':
    case 'uint64':
    case 'fixed32':
    case 'fixed64':
      return 'double';
    case undefined:
    default:
      if (resolvedType) {
        switch (resolvedType.constructor.name) {
          case 'Type':
            return resolvedType.fullName.slice(1);
          case 'Enum':
            return 'int';
        }
      }

      if (protoType?.includes('.') === true) {
        return protoType;
      }

      // Unknown type, treat as dyn
      return 'dyn';
  }
}
