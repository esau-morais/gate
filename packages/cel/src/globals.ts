// Method signatures let these accept any key: the runtime applies ToPropertyKey, as `o[key]` does.
interface PropertyAccess {
  hasOwn(o: NonNullable<unknown>, key: unknown): boolean;
  get(o: NonNullable<unknown>, key: unknown): unknown;
  set(o: object, key: unknown, value: unknown): void;
  has(o: object, key: unknown): boolean;
}

function hasProperty(o: object, key: PropertyKey): boolean {
  return key in o;
}

function readProperty(
  o: Record<PropertyKey, unknown>,
  key: PropertyKey,
): unknown {
  return o[key];
}

function writeProperty(
  o: Record<PropertyKey, unknown>,
  key: PropertyKey,
  value: unknown,
): void {
  o[key] = value;
}

/** `Object.hasOwn`, typed for the coercions it performs: ToObject on `o` and ToPropertyKey on `key`. */
export const hasOwn: PropertyAccess['hasOwn'] = Object.hasOwn;
export const getProp: PropertyAccess['get'] = readProperty;
export const setProp: PropertyAccess['set'] = writeProperty;
export const hasProp: PropertyAccess['has'] = hasProperty;

export function isPromise(value: unknown): value is Promise<unknown> {
  return value instanceof Promise;
}

export function isUnknownMap(value: unknown): value is Map<unknown, unknown> {
  return value instanceof Map;
}

export function isMutableArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/**
 * Reads the constructor from the prototype chain, never from an own property,
 * so input data such as `{"constructor": "1.0.0"}` can't change the detected type.
 */
export function constructorOf(value: unknown): unknown {
  if (value === null || value === undefined) {
    return undefined;
  }

  const proto: unknown = Object.getPrototypeOf(value);

  return typeof proto === 'object' && proto !== null
    ? Reflect.get(proto, 'constructor')
    : undefined;
}

export const objKeys = Object.keys;
export const objFreeze = Object.freeze;
export const objEntries = Object.entries;
export const isArray = Array.isArray;
export const arrayFrom = Array.from;

export const MIN_UINT = 0n;
export const MAX_UINT = 18446744073709551615n;

export const MAX_INT = 9223372036854775807n;
export const MIN_INT = -9223372036854775808n;

export function isAsync(fn: unknown, fallback?: unknown): boolean {
  if (
    ((typeof fn === 'object' && fn !== null) || typeof fn === 'function') &&
    Reflect.get(fn, Symbol.toStringTag) === 'AsyncFunction'
  ) {
    return true;
  }

  return typeof fallback === 'boolean' ? fallback : true;
}

export const RESERVED: ReadonlySet<string> = new Set([
  'as',
  'break',
  'const',
  'continue',
  'else',
  'for',
  'function',
  'if',
  'import',
  'let',
  'loop',
  'package',
  'namespace',
  'return',
  'var',
  'void',
  'while',
  '__proto__',
  'prototype',
]);

export function nullObject<T>(): Record<string, T> {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Object.create(null) is typed any; a fresh null-prototype object has no keys, so it satisfies any string-keyed record
  return Object.create(null) as Record<string, T>;
}

/** JavaScript truthiness, as `if (value)` evaluates it. */
export function truthy(value: unknown): value is NonNullable<unknown> {
  return Boolean(value);
}

/** Reads a value the surrounding code guarantees is present. Upstream would have thrown a TypeError here. */
export function expectDefined<T>(value: T | null | undefined, what: string): T {
  if (value === undefined || value === null) {
    throw new TypeError(`Internal invariant violated: missing ${what}`);
  }

  return value;
}

export function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}
