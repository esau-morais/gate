import { describe, expect, test } from 'bun:test';
import { readYaml } from '../src/yaml';

function value(text: string): unknown {
  const read = readYaml(text);
  if (read.kind !== 'read') {
    throw new Error(read.error);
  }

  return read.value;
}

describe('what the pnpm lockfile emitter writes', () => {
  test('plain, quoted and literal scalars and one-line flow collections read', () => {
    expect(
      value(
        [
          'plain: ^1.0.0 || >=2',
          "single: '@scope/name@1.0.0(peer@1.0.0)'",
          "quote: 'it''s'",
          'double: "tab\\there \\u00e9 \\x41"',
          'literal: |-',
          '  line one',
          '',
          '  line three',
          'kept: |+',
          '  a',
          '',
          'resolution: {integrity: sha512-x, tarball: https://h/a.tgz}',
          'os: [darwin, linux]',
          'empty: {}',
          'flag: true',
          'revision: 3',
          'list:',
          '  - a',
          '  - b',
          '',
        ].join('\n'),
      ),
    ).toEqual({
      plain: '^1.0.0 || >=2',
      single: '@scope/name@1.0.0(peer@1.0.0)',
      quote: "it's",
      double: 'tab\there é A',
      literal: 'line one\n\nline three',
      kept: 'a\n\n',
      resolution: { integrity: 'sha512-x', tarball: 'https://h/a.tgz' },
      os: ['darwin', 'linux'],
      empty: {},
      flag: true,
      revision: 3,
      list: ['a', 'b'],
    });
  });

  test('line breaks inside a flow collection change nothing', () => {
    expect(value('a:\n  {\n    b: 1,\n    c: [d,\n      e],\n  }\n')).toEqual({
      a: { b: 1, c: ['d', 'e'] },
    });
  });

  test('quoted scalars that look like numbers or dates stay strings', () => {
    expect(value("a: '0b1'\nb: '2001-12-14'\nc: 1.0.0\n")).toEqual({
      a: '0b1',
      b: '2001-12-14',
      c: '1.0.0',
    });
  });

  test('comments change nothing', () => {
    expect(value('# lockfile\na: 1 # one\n')).toEqual({ a: 1 });
  });
});

describe('YAML that can change what a node means, or is broken, is unreadable', () => {
  const refused: Record<string, string> = {
    'an anchor and alias': 'a: &x {b: 1}\nc: *x\n',
    'an anchor alone': 'a: &x {b: 1}\n',
    'a core tag': 'a: !!str 1\n',
    'a custom tag': 'a: !pnpm bar\n',
    'a merge key': 'a:\n  <<: {b: 1}\n  c: 2\n',
    'a duplicate key': 'a: 1\na: 2\n',
    'a %YAML directive': '%YAML 1.1\n---\na: yes\n',
    'a second document': 'a: 1\n---\nb: 2\n',
    'a document start marker': '---\na: 1\n',
    'a folded scalar': 'a: >\n  x\n  y\n',
    'a plain scalar over two lines': 'a: foo\n  bar\n',
    'a quoted scalar over two lines': "a: 'foo\n  bar'\n",
    'a number key': '1: a\n',
    'a boolean key': 'true: a\n',
    'a null key': '~: a\n',
    'a collection key': '? [a]\n: b\n',
    'a binary number js-yaml reads': 'a: 0b1\n',
    'an underscored number js-yaml reads': 'a: 1_0\n',
    'a date js-yaml reads': 'a: 2001-12-14\n',
    'a key js-yaml reads as a number': '1_0: a\n',
    'tab indentation': 'a:\n\tb: 1\n',
    'an unterminated flow collection': 'a: {b: 1\n',
    'an empty document': '',
  };
  for (const [name, text] of Object.entries(refused)) {
    test(name, () => {
      expect(readYaml(text).kind).toBe('unreadable');
    });
  }
});
