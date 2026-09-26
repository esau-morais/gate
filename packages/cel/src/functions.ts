import { evaluationError } from './errors';
import { TYPES, Type } from './registry';
import type { Registry, RegisteredFunctionHandler } from './registry';
import { register as registerOptional } from './optional';
import {
  objKeys,
  arrayFrom,
  MIN_UINT,
  MAX_UINT,
  MIN_INT,
  MAX_INT,
  expectDefined,
} from './globals';

declare global {
  // Undocumented Buffer methods that upstream calls to avoid copying plain Uint8Arrays.
  interface Buffer {
    hexSlice(start: number, end: number): string;
    base64Slice(start: number, end: number): string;
  }

  interface BufferConstructor {
    readonly prototype: Buffer;
  }
}

/**
 * Represents an unsigned integer value in CEL.
 * Used for uint type values.
 */
export class UnsignedInt {
  #value = MIN_UINT;
  /**
   * Create a new UnsignedInt.
   * @param value - The unsigned integer value (as bigint, number or integer string)
   * @throws Error if value is negative or exceeds uint64 max
   */
  constructor(value: bigint | number | string) {
    this.verify(typeof value === 'bigint' ? value : BigInt(value));
  }

  /** Get the bigint value. */
  get value(): bigint {
    return this.#value;
  }

  /** Convert to primitive bigint for operations. */
  valueOf(): bigint {
    return this.#value;
  }

  /** Convert to string representation. */
  toString(): string {
    return `${this.#value}`;
  }

  /** Validate and store an unsigned integer value. */
  verify(v: bigint): void {
    if (v < MIN_UINT || v > MAX_UINT) {
      throw evaluationError('numeric_overflow', 'Unsigned integer overflow');
    }

    this.#value = v;
  }

  get [Symbol.toStringTag](): string {
    return `value = ${this.#value}`;
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `UnsignedInteger { value: ${this.#value} }`;
  }
}

const billion = 1_000_000_000;
const billionBigInt = 1_000_000_000n;

// 0001-01-01T00:00:00Z and 9999-12-31T23:59:59.999Z, the spec's timestamp range at millisecond precision.
const MIN_TIMESTAMP_MS = -62135596800000;
const MAX_TIMESTAMP_MS = 253402300799999;

function verifyTimestamp(ts: Date): Date {
  const ms = ts.getTime();
  if (ms >= MIN_TIMESTAMP_MS && ms <= MAX_TIMESTAMP_MS) {
    return ts;
  }

  throw evaluationError('timestamp_out_of_range', 'Timestamp out of range');
}

const UNIT_NANOSECONDS: Readonly<Record<string, bigint>> = {
  h: 3_600_000_000_000n,
  m: 60_000_000_000n,
  s: billionBigInt,
  ms: 1_000_000n,
  us: 1_000n,
  µs: 1_000n,
  ns: 1n,
};

/**
 * Represents a duration value in CEL.
 * Used for google.protobuf.Duration type.
 */
export class Duration {
  #seconds: bigint;
  #nanos: number;

  /**
   * Create a new Duration.
   * @param seconds - The number of seconds
   * @param nanos - The number of nanoseconds (0-999999999)
   */
  constructor(seconds: bigint | number, nanos = 0) {
    this.#seconds = BigInt(seconds);
    this.#nanos = nanos;

    // The spec limits durations to an int64 count of nanoseconds.
    const total = this.#seconds * billionBigInt + BigInt(Math.trunc(nanos));
    if (total > MAX_INT || total < MIN_INT) {
      throw evaluationError('duration_out_of_range', 'Duration out of range');
    }
  }

  /** Get the seconds component. */
  get seconds(): bigint {
    return this.#seconds;
  }

  /** Get the nanoseconds component. */
  get nanos(): number {
    return this.#nanos;
  }

  /** Convert to primitive milliseconds for operations. */
  valueOf(): number {
    return Number(this.#seconds) * 1000 + this.#nanos / 1_000_000;
  }

  /** Construct a duration from a millisecond value. */
  static fromMilliseconds(ms: number): Duration {
    const totalNanos = BigInt(Math.trunc(ms * 1_000_000));
    const seconds = totalNanos / billionBigInt;
    const nanos = Number(totalNanos % billionBigInt);

    return new Duration(seconds, nanos);
  }

  /** Add another duration. */
  addDuration(other: Duration): Duration {
    const nanos = this.#nanos + other.nanos;

    return new Duration(
      this.#seconds + other.seconds + BigInt(Math.floor(nanos / billion)),
      nanos % billion,
    );
  }

  /** Subtract another duration. */
  subtractDuration(other: Duration): Duration {
    const nanos = this.#nanos - other.nanos;

    return new Duration(
      this.#seconds - other.seconds + BigInt(Math.floor(nanos / billion)),
      (nanos + billion) % billion,
    );
  }

  /** Add this duration to a timestamp. */
  extendTimestamp(ts: Date): Date {
    return verifyTimestamp(
      new Date(
        ts.getTime() +
          Number(this.#seconds) * 1000 +
          Math.floor(this.#nanos / 1_000_000),
      ),
    );
  }

  /** Subtract this duration from a timestamp. */
  subtractTimestamp(ts: Date): Date {
    return verifyTimestamp(
      new Date(
        ts.getTime() -
          Number(this.#seconds) * 1000 -
          Math.floor(this.#nanos / 1_000_000),
      ),
    );
  }

  /** Convert to string representation in format like "5s", "1h30m", etc. */
  toString(): string {
    const nanos =
      this.#nanos !== 0 && !Number.isNaN(this.#nanos)
        ? (this.#nanos / billion)
            .toLocaleString('en-US', {
              useGrouping: false,
              maximumFractionDigits: 9,
            })
            .slice(1)
        : '';

    return `${this.#seconds}${nanos}s`;
  }

  /** Whole hours represented by this duration. */
  getHours(): bigint {
    return this.#seconds / 3600n;
  }

  /** Whole minutes represented by this duration. */
  getMinutes(): bigint {
    return this.#seconds / 60n;
  }

  /** Whole seconds represented by this duration. */
  getSeconds(): bigint {
    return this.#seconds;
  }

  /** Total milliseconds represented by this duration. */
  getMilliseconds(): bigint {
    return this.#seconds * 1000n + BigInt(Math.floor(this.#nanos / 1000000));
  }

  get [Symbol.toStringTag](): string {
    return 'google.protobuf.Duration';
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `google.protobuf.Duration { seconds: ${this.#seconds}, nanos: ${this.#nanos} }`;
  }
}

type ListValue = unknown[] | Set<unknown>;
type MapValue = Map<unknown, unknown> | Record<string, unknown>;

function listSize(v: ListValue): bigint {
  return BigInt(v instanceof Set ? v.size : v.length);
}

function mapSize(v: MapValue): bigint {
  return BigInt(v instanceof Map ? v.size : objKeys(v).length);
}

interface ByteOperations {
  textEncoder?: TextEncoder;
  byteLength: (v: string) => number;
  fromString: (str: string) => Uint8Array;
  toHex: (b: Uint8Array) => string;
  toBase64: (b: Uint8Array) => string;
  toUtf8: (b: Uint8Array) => string;
}

/**
 * Register all built-in CEL functions on the provided registry instance.
 */
export function registerFunctions(registry: Registry): void {
  const sync = { async: false };
  const functionOverload = (
    sig: string,
    handler: RegisteredFunctionHandler,
  ): void => registry.registerFunctionOverload(sig, handler, sync);
  const identity = (v: unknown): unknown => v;

  functionOverload('dyn(dyn): dyn', identity);

  for (const type of Object.values(TYPES)) {
    if (!(type instanceof Type)) {
      continue;
    }

    functionOverload(`type(${type.name}): type`, () => type);
  }

  functionOverload('bool(bool): bool', identity);
  functionOverload('bool(string): bool', (v: string) => {
    switch (v) {
      case '1':
      case 't':
      case 'true':
      case 'TRUE':
      case 'True':
        return true;
      case '0':
      case 'f':
      case 'false':
      case 'FALSE':
      case 'False':
        return false;
      default:
        throw evaluationError(
          'bool_conversion_error',
          `bool() conversion error: invalid string value "${v}"`,
        );
    }
  });

  functionOverload('size(string): int', (v: string) => BigInt(stringSize(v)));
  functionOverload('size(bytes): int', (v: Uint8Array) => BigInt(v.length));
  functionOverload('size(list): int', listSize);
  functionOverload('size(map): int', mapSize);
  functionOverload('string.size(): int', (v: string) => BigInt(stringSize(v)));
  functionOverload('bytes.size(): int', (v: Uint8Array) => BigInt(v.length));
  functionOverload('list.size(): int', listSize);
  functionOverload('map.size(): int', mapSize);

  functionOverload('bytes(string): bytes', (v: string) =>
    ByteOpts.fromString(v),
  );
  functionOverload('bytes(bytes): bytes', identity);

  functionOverload('double(double): double', identity);
  functionOverload('double(int): double', (v: bigint) => Number(v));
  functionOverload('double(uint): double', (v: UnsignedInt) => Number(v));
  functionOverload('double(string): double', (v: string) => {
    if (v === '' || v !== v.trim()) {
      throw evaluationError(
        'double_conversion_error',
        'double() type error: cannot convert to double',
      );
    }

    const s = v.toLowerCase();
    switch (s) {
      case 'inf':
      case '+inf':
      case 'infinity':
      case '+infinity':
        return Number.POSITIVE_INFINITY;
      case '-inf':
      case '-infinity':
        return Number.NEGATIVE_INFINITY;
      case 'nan':
        return Number.NaN;
      default: {
        const parsed = Number(v);
        if (!Number.isNaN(parsed)) {
          return parsed;
        }

        throw evaluationError(
          'double_conversion_error',
          'double() type error: cannot convert to double',
        );
      }
    }
  });

  functionOverload('int(int): int', identity);
  // The spec limits double to int conversion to (minInt, maxInt), exclusive.
  const minIntDouble = Number(MIN_INT);
  const maxIntDouble = Number(MAX_INT);
  functionOverload('int(double): int', (v: number) => {
    if (v > minIntDouble && v < maxIntDouble) {
      return BigInt(Math.trunc(v));
    }

    throw evaluationError(
      'numeric_overflow',
      'int() type error: integer overflow',
    );
  });

  functionOverload('int(string): int', (v: string) => {
    if (v !== v.trim() || v.length > 20 || v.includes('0x')) {
      throw evaluationError(
        'int_conversion_error',
        'int() type error: cannot convert to int',
      );
    }

    try {
      const num = BigInt(v);
      if (num <= MAX_INT && num >= MIN_INT) {
        return num;
      }
    } catch {
      // fall through to the conversion error below
    }

    throw evaluationError(
      'int_conversion_error',
      'int() type error: cannot convert to int',
    );
  });

  functionOverload('uint(uint): uint', identity);
  functionOverload('uint(int): uint', (v: bigint) => {
    try {
      return new UnsignedInt(v);
    } catch {
      throw evaluationError(
        'uint_conversion_error',
        'uint() type error: cannot convert to uint',
      );
    }
  });
  functionOverload('uint(double): uint', (v: number) => {
    try {
      return new UnsignedInt(Math.trunc(v));
    } catch {
      throw evaluationError(
        'numeric_overflow',
        'uint() type error: unsigned integer overflow',
      );
    }
  });

  functionOverload('uint(string): uint', (v: string) => {
    if (v !== v.trim() || v.length > 20 || v.includes('0x')) {
      throw evaluationError(
        'uint_conversion_error',
        'uint() type error: cannot convert to uint',
      );
    }

    try {
      return new UnsignedInt(v);
    } catch {
      throw evaluationError(
        'uint_conversion_error',
        'uint() type error: cannot convert to uint',
      );
    }
  });

  functionOverload('string(string): string', identity);
  functionOverload('string(bool): string', (v: boolean) => `${v}`);
  functionOverload('string(int): string', (v: bigint) => `${v}`);
  functionOverload('string(uint): string', (v: UnsignedInt) => String(v));
  functionOverload('string(bytes): string', (v: Uint8Array) =>
    ByteOpts.toUtf8(v),
  );
  functionOverload('string(double): string', (v: number) => {
    if (v === Infinity) {
      return '+Inf';
    }

    if (v === -Infinity) {
      return '-Inf';
    }

    return `${v}`;
  });

  functionOverload('string.startsWith(string): bool', (a: string, b: string) =>
    a.startsWith(b),
  );
  functionOverload('string.endsWith(string): bool', (a: string, b: string) =>
    a.endsWith(b),
  );
  functionOverload('string.contains(string): bool', (a: string, b: string) =>
    a.includes(b),
  );
  functionOverload('string.lowerAscii(): string', (a: string) =>
    a.toLowerCase(),
  );
  functionOverload('string.upperAscii(): string', (a: string) =>
    a.toUpperCase(),
  );
  functionOverload('string.trim(): string', (a: string) => a.trim());

  functionOverload(
    'string.indexOf(string): int',
    (string: string, search: string) => BigInt(string.indexOf(search)),
  );
  functionOverload(
    'string.indexOf(string, int): int',
    (string: string, search: string, fromIndex: bigint) => {
      if (search === '') {
        return fromIndex;
      }

      const from = Number(fromIndex);
      if (from < 0 || from >= string.length) {
        throw evaluationError(
          'index_out_of_range',
          'string.indexOf(search, fromIndex): fromIndex out of range',
        );
      }

      return BigInt(string.indexOf(search, from));
    },
  );

  functionOverload(
    'string.lastIndexOf(string): int',
    (string: string, search: string) => BigInt(string.lastIndexOf(search)),
  );

  functionOverload(
    'string.lastIndexOf(string, int): int',
    (string: string, search: string, fromIndex: bigint) => {
      if (search === '') {
        return fromIndex;
      }

      const from = Number(fromIndex);
      if (from < 0 || from >= string.length) {
        throw evaluationError(
          'index_out_of_range',
          'string.lastIndexOf(search, fromIndex): fromIndex out of range',
        );
      }

      return BigInt(string.lastIndexOf(search, from));
    },
  );

  functionOverload(
    'string.substring(int): string',
    (string: string, startIndex: bigint) => {
      const start = Number(startIndex);
      if (start < 0 || start > string.length) {
        throw evaluationError(
          'index_out_of_range',
          'string.substring(start, end): start index out of range',
        );
      }

      return string.substring(start);
    },
  );

  functionOverload(
    'string.substring(int, int): string',
    (string: string, startIndex: bigint, endIndex: bigint) => {
      const start = Number(startIndex);
      if (start < 0 || start > string.length) {
        throw evaluationError(
          'index_out_of_range',
          'string.substring(start, end): start index out of range',
        );
      }

      const end = Number(endIndex);
      if (end < start || end > string.length) {
        throw evaluationError(
          'index_out_of_range',
          'string.substring(start, end): end index out of range',
        );
      }

      return string.substring(start, end);
    },
  );

  functionOverload('string.matches(string): bool', (a: string, b: string) => {
    try {
      return new RegExp(b).test(a);
    } catch {
      throw evaluationError(
        'invalid_regular_expression',
        `Invalid regular expression: ${b}`,
      );
    }
  });

  functionOverload(
    'string.split(string): list<string>',
    (s: string, sep: string) => s.split(sep),
  );
  functionOverload(
    'string.split(string, int): list<string>',
    (s: string, sep: string, limit: bigint) => {
      const l = Number(limit);
      if (l === 0) {
        return [];
      }

      const parts = s.split(sep);
      if (l < 0 || parts.length <= l) {
        return parts;
      }

      const limited = parts.slice(0, l - 1);
      limited.push(parts.slice(l - 1).join(sep));

      return limited;
    },
  );

  function joinStrings(v: ListValue, sep: string, message: string): string {
    const items = v instanceof Set ? [...v] : v;
    for (let i = 0; i < items.length; i++) {
      if (typeof items[i] !== 'string') {
        throw evaluationError('invalid_list_element_type', message);
      }
    }

    return items.join(sep);
  }

  functionOverload('list<string>.join(): string', (v: ListValue) =>
    joinStrings(v, '', 'string.join(): list must contain only strings'),
  );

  functionOverload(
    'list<string>.join(string): string',
    (v: ListValue, sep: string) =>
      joinStrings(
        v,
        sep,
        'string.join(separator): list must contain only strings',
      ),
  );

  const textEncoder = new TextEncoder();
  const utf8Decoder = new TextDecoder('utf-8', {
    fatal: true,
    ignoreBOM: true,
  });
  const toUtf8 = (b: Uint8Array): string => {
    try {
      return utf8Decoder.decode(b);
    } catch {
      throw evaluationError('invalid_utf8', 'Invalid UTF-8 in bytes');
    }
  };

  const ByteOpts: ByteOperations =
    typeof Buffer !== 'undefined'
      ? {
          byteLength: (v) => Buffer.byteLength(v),
          fromString: (str) => Buffer.from(str, 'utf8'),
          toHex: (b) => Buffer.prototype.hexSlice.call(b, 0, b.length),
          toBase64: (b) => Buffer.prototype.base64Slice.call(b, 0, b.length),
          toUtf8,
        }
      : {
          textEncoder: new TextEncoder(),
          byteLength: (v) => textEncoder.encode(v).length,
          fromString: (str) => textEncoder.encode(str),
          toHex:
            Uint8Array.prototype.toHex === undefined
              ? (b) =>
                  arrayFrom(b, (i) => i.toString(16).padStart(2, '0')).join('')
              : (b) => b.toHex(),
          toBase64:
            Uint8Array.prototype.toBase64 === undefined
              ? (b) =>
                  btoa(arrayFrom(b, (i) => String.fromCodePoint(i)).join(''))
              : (b) => b.toBase64(),
          toUtf8,
        };

  functionOverload('bytes.json(): map', (b: Uint8Array): unknown =>
    JSON.parse(toUtf8(b)),
  );
  functionOverload('bytes.hex(): string', ByteOpts.toHex);
  functionOverload('bytes.string(): string', ByteOpts.toUtf8);
  functionOverload('bytes.base64(): string', ByteOpts.toBase64);
  functionOverload('bytes.at(int): int', (b: Uint8Array, index: bigint) => {
    if (index < 0 || index >= b.length) {
      throw evaluationError('index_out_of_range', 'Bytes index out of range');
    }

    return BigInt(expectDefined(b[Number(index)], 'byte'));
  });

  const TS = 'google.protobuf.Timestamp';
  const GPD = 'google.protobuf.Duration';
  const TimestampType = registry.registerType(TS, Date).typeType;
  const DurationType = registry.registerType(GPD, Duration).typeType;
  registry.registerConstant('google', 'map<string, map<string, type>>', {
    protobuf: { Duration: DurationType, Timestamp: TimestampType },
  });

  function tzDate(d: Date, timeZone: string): Date {
    return new Date(d.toLocaleString('en-US', { timeZone }));
  }

  function getDayOfYear(d: Date, tz?: string): bigint {
    const workingDate =
      tz !== undefined && tz !== ''
        ? tzDate(d, tz)
        : new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());

    const start = new Date(workingDate.getFullYear(), 0, 0);

    return BigInt(
      Math.floor((workingDate.getTime() - start.getTime()) / 86_400_000) - 1,
    );
  }

  functionOverload(`timestamp(string): ${TS}`, (v: string) => {
    if (v.length < 20 || v.length > 30) {
      throw evaluationError(
        'invalid_timestamp',
        'timestamp() requires a string in ISO 8601 format',
      );
    }

    const d = new Date(v);
    if (d.getTime() <= MAX_TIMESTAMP_MS && d.getTime() >= MIN_TIMESTAMP_MS) {
      return d;
    }

    throw evaluationError(
      'invalid_timestamp',
      'timestamp() requires a string in ISO 8601 format',
    );
  });

  functionOverload(`timestamp(int): ${TS}`, (seconds: bigint) => {
    const i = Number(seconds) * 1000;
    if (i <= MAX_TIMESTAMP_MS && i >= MIN_TIMESTAMP_MS) {
      return new Date(i);
    }

    throw evaluationError(
      'invalid_timestamp',
      'timestamp() requires a valid integer unix timestamp',
    );
  });

  functionOverload(`${TS}.getDate(): int`, (d: Date) => BigInt(d.getUTCDate()));
  functionOverload(`${TS}.getDate(string): int`, (d: Date, tz: string) =>
    BigInt(tzDate(d, tz).getDate()),
  );
  functionOverload(`${TS}.getDayOfMonth(): int`, (d: Date) =>
    BigInt(d.getUTCDate() - 1),
  );
  functionOverload(`${TS}.getDayOfMonth(string): int`, (d: Date, tz: string) =>
    BigInt(tzDate(d, tz).getDate() - 1),
  );
  functionOverload(`${TS}.getDayOfWeek(): int`, (d: Date) =>
    BigInt(d.getUTCDay()),
  );
  functionOverload(`${TS}.getDayOfWeek(string): int`, (d: Date, tz: string) =>
    BigInt(tzDate(d, tz).getDay()),
  );
  functionOverload(`${TS}.getDayOfYear(): int`, getDayOfYear);
  functionOverload(`${TS}.getDayOfYear(string): int`, getDayOfYear);
  functionOverload(`${TS}.getFullYear(): int`, (d: Date) =>
    BigInt(d.getUTCFullYear()),
  );
  functionOverload(`${TS}.getFullYear(string): int`, (d: Date, tz: string) =>
    BigInt(tzDate(d, tz).getFullYear()),
  );
  functionOverload(`${TS}.getHours(): int`, (d: Date) =>
    BigInt(d.getUTCHours()),
  );
  functionOverload(`${TS}.getHours(string): int`, (d: Date, tz: string) =>
    BigInt(tzDate(d, tz).getHours()),
  );
  functionOverload(`${TS}.getMilliseconds(): int`, (d: Date) =>
    BigInt(d.getUTCMilliseconds()),
  );
  functionOverload(`${TS}.getMilliseconds(string): int`, (d: Date) =>
    BigInt(d.getUTCMilliseconds()),
  );
  functionOverload(`${TS}.getMinutes(): int`, (d: Date) =>
    BigInt(d.getUTCMinutes()),
  );
  functionOverload(`${TS}.getMinutes(string): int`, (d: Date, tz: string) =>
    BigInt(tzDate(d, tz).getMinutes()),
  );
  functionOverload(`${TS}.getMonth(): int`, (d: Date) =>
    BigInt(d.getUTCMonth()),
  );
  functionOverload(`${TS}.getMonth(string): int`, (d: Date, tz: string) =>
    BigInt(tzDate(d, tz).getMonth()),
  );
  functionOverload(`${TS}.getSeconds(): int`, (d: Date) =>
    BigInt(d.getUTCSeconds()),
  );
  functionOverload(`${TS}.getSeconds(string): int`, (d: Date, tz: string) =>
    BigInt(tzDate(d, tz).getSeconds()),
  );

  const parseDurationPattern = /(\d*\.?\d*)(ns|us|µs|ms|s|m|h)/;

  // parseDuration parses a golang-style duration string.
  // A duration string is a possibly signed sequence of decimal numbers,
  // each with optional fraction and a unit suffix,
  // such as "300ms", "-1.5h" or "2h45m". Valid time units are "ns", "us" (or "µs"), "ms", "s", "m", "h".
  // https://pkg.go.dev/time#ParseDuration
  function parseDuration(input: string): Duration {
    if (input === '') {
      throw evaluationError('invalid_duration', `Invalid duration string: ''`);
    }

    let string = input;
    const isNegative = string[0] === '-';
    if (string[0] === '-' || string[0] === '+') {
      string = string.slice(1);
    }

    let nanoseconds = BigInt(0);
    while (true) {
      const match = parseDurationPattern.exec(string);
      if (!match) {
        throw evaluationError(
          'invalid_duration',
          `Invalid duration string: ${string}`,
        );
      }

      if (match.index !== 0) {
        throw evaluationError(
          'invalid_duration',
          `Invalid duration string: ${string}`,
        );
      }

      string = string.slice(match[0].length);

      const unitNanos = expectDefined(
        UNIT_NANOSECONDS[expectDefined(match[2], 'duration unit')],
        'duration unit size',
      );
      const [intPart = '0', fracPart = ''] = expectDefined(
        match[1],
        'duration amount',
      ).split('.');
      const intVal = BigInt(intPart) * unitNanos;
      const fracNanos =
        fracPart !== ''
          ? (BigInt(fracPart.slice(0, 13).padEnd(13, '0')) * unitNanos) /
            10_000_000_000_000n
          : 0n;

      nanoseconds += intVal + fracNanos;
      if (string === '') {
        break;
      }
    }

    const seconds =
      nanoseconds >= billionBigInt ? nanoseconds / billionBigInt : 0n;
    const nanos = Number(nanoseconds % billionBigInt);

    if (isNegative) {
      return new Duration(-seconds, -nanos);
    }

    return new Duration(seconds, nanos);
  }

  functionOverload(`duration(string): google.protobuf.Duration`, (s: string) =>
    parseDuration(s),
  );
  functionOverload(`google.protobuf.Duration.getHours(): int`, (d: Duration) =>
    d.getHours(),
  );
  functionOverload(
    `google.protobuf.Duration.getMinutes(): int`,
    (d: Duration) => d.getMinutes(),
  );
  functionOverload(
    `google.protobuf.Duration.getSeconds(): int`,
    (d: Duration) => d.getSeconds(),
  );
  functionOverload(
    `google.protobuf.Duration.getMilliseconds(): int`,
    (d: Duration) => d.getMilliseconds(),
  );
  registerOptional(registry);
}

function stringSize(str: string): number {
  let count = 0;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- counts code points; the loop variable is not needed
  for (const _ of str) {
    count++;
  }

  return count;
}
