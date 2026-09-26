function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype: unknown = Object.getPrototypeOf(value);

  return prototype === Object.prototype || prototype === null;
}

function canonicalString(text: string): string {
  if (/\p{Surrogate}/u.test(text)) {
    throw new TypeError('canonical JSON refuses lone surrogates');
  }

  return JSON.stringify(text);
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean') {
    return JSON.stringify(value);
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('canonical JSON refuses non-finite numbers');
    }

    return JSON.stringify(value);
  }

  if (typeof value === 'string') {
    return canonicalString(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }

  if (typeof value === 'object' && isPlainObject(value)) {
    const members = Object.keys(value)
      .toSorted()
      .map((key) => `${canonicalString(key)}:${canonicalJson(value[key])}`);

    return `{${members.join(',')}}`;
  }

  throw new TypeError(`canonical JSON refuses ${typeof value}`);
}
