import { expect, test } from 'bun:test';
import { canonicalJson } from '../src/canonical-json';

test('object keys sort by UTF-16 code units, as in the RFC 8785 example', () => {
  const keys = [
    '\u20ac',
    '\r',
    '\ufb33',
    '1',
    '\ud83d\ude00',
    '\u0080',
    '\u00f6',
  ];
  const value = Object.fromEntries(keys.map((key, index) => [key, index]));

  expect(canonicalJson(value)).toBe(
    '{"\\r":1,"1":3,"\u0080":5,"\u00f6":6,"\u20ac":0,"\ud83d\ude00":4,"\ufb33":2}',
  );
});

test('nested values serialize without whitespace and keep array order', () => {
  expect(
    canonicalJson({ b: [3, { d: null, c: true }], a: 'x', e: 1e21, f: 0.5 }),
  ).toBe('{"a":"x","b":[3,{"c":true,"d":null}],"e":1e+21,"f":0.5}');
});

test('values with no JSON form are refused, not dropped', () => {
  for (const value of [
    { a: undefined },
    [Number.NaN],
    { a: Number.POSITIVE_INFINITY },
    { a: new Date(0) },
    '\ud800',
    { '\udc00': 1 },
  ]) {
    expect(() => canonicalJson(value)).toThrow();
  }
});
