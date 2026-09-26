import { objFreeze, objKeys } from './globals';

export interface Limits {
  /** Maximum number of AST nodes that can be produced while parsing */
  maxAstNodes: number;
  /** Maximum nesting depth for recursive grammar elements (calls, selects, indexes, aggregates) */
  maxDepth: number;
  /** Maximum number of list literal elements */
  maxListElements: number;
  /** Maximum number of map literal entries */
  maxMapEntries: number;
  /** Maximum number of function or method call arguments */
  maxCallArguments: number;
}

export interface EnvironmentOptions {
  /**
   * When true, unlisted variables are treated as dynamic (dyn) type.
   * When false, all variables must be explicitly registered.
   */
  unlistedVariablesAreDyn?: boolean;
  /**
   * When true (default), list and map literals must have homogeneous element/key/value types.
   * When false, mixed literals are inferred as list<dyn> or map with dyn components.
   */
  homogeneousAggregateLiterals?: boolean;
  /**
   * Enable experimental optional types (.?/.[]? chaining and optional.* helpers). Disabled by default.
   */
  enableOptionalTypes?: boolean;
  /** Optional overrides for parser/evaluator structural limits */
  limits?: Partial<Limits>;
}

export type ResolvedEnvironmentOptions = Omit<
  Required<EnvironmentOptions>,
  'limits'
> & {
  limits: Limits;
};

type LimitKey = keyof Limits;

const DEFAULT_LIMITS: Readonly<Limits> = objFreeze({
  maxAstNodes: 100000,
  maxDepth: 250,
  maxListElements: 1000,
  maxMapEntries: 1000,
  maxCallArguments: 32,
});

const LIMIT_KEYS: ReadonlySet<string> = new Set(objKeys(DEFAULT_LIMITS));

function isLimitKey(key: string): key is LimitKey {
  return LIMIT_KEYS.has(key);
}

function createLimits(
  overrides: Partial<Limits> | undefined,
  base: Readonly<Limits> = DEFAULT_LIMITS,
): Readonly<Limits> {
  const keys = overrides ? objKeys(overrides) : undefined;
  if (keys === undefined || keys.length === 0) {
    return base;
  }

  const merged = { ...base };
  for (const key of keys) {
    if (!isLimitKey(key)) {
      throw new TypeError(`Unknown limits option: ${key}`);
    }

    const value = overrides?.[key];
    if (typeof value !== 'number') {
      continue;
    }

    merged[key] = value;
  }

  return objFreeze(merged);
}

const DEFAULT_OPTIONS: Readonly<ResolvedEnvironmentOptions> = objFreeze({
  unlistedVariablesAreDyn: false,
  homogeneousAggregateLiterals: true,
  enableOptionalTypes: false,
  limits: DEFAULT_LIMITS,
});

type BooleanOptionKey =
  | 'unlistedVariablesAreDyn'
  | 'homogeneousAggregateLiterals'
  | 'enableOptionalTypes';

function bool(
  a: EnvironmentOptions | undefined,
  b: EnvironmentOptions | undefined,
  key: BooleanOptionKey,
): boolean {
  const value = a?.[key] ?? b?.[key];
  if (typeof value !== 'boolean') {
    throw new TypeError(`Invalid option: ${key}`);
  }

  return value;
}

export function createOptions(
  opts: EnvironmentOptions | undefined,
  base: Readonly<ResolvedEnvironmentOptions> = DEFAULT_OPTIONS,
): Readonly<ResolvedEnvironmentOptions> {
  if (!opts) {
    return base;
  }

  return objFreeze({
    unlistedVariablesAreDyn: bool(opts, base, 'unlistedVariablesAreDyn'),
    homogeneousAggregateLiterals: bool(
      opts,
      base,
      'homogeneousAggregateLiterals',
    ),
    enableOptionalTypes: bool(opts, base, 'enableOptionalTypes'),
    limits: createLimits(opts.limits, base.limits),
  });
}
