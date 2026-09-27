import {
  isScalar,
  parseDocument,
  visit,
  type Node as YamlNode,
  type Range,
} from 'yaml';

export type YamlRead =
  | { readonly kind: 'read'; readonly value: unknown }
  | { readonly kind: 'unreadable'; readonly error: string };

const oneLineStyles = new Set(['PLAIN', 'QUOTE_SINGLE', 'QUOTE_DOUBLE']);
const jsYamlNotString = [
  /^[-+]?(?:0b[01_]+|0x[0-9a-fA-F_]+|0o[0-7_]+|[0-9][0-9_]*)$/,
  /^(?:[-+]?[0-9][0-9_]*(?:\.[0-9_]*)?(?:[eE][-+]?[0-9]+)?|\.[0-9_]+(?:[eE][-+]?[0-9]+)?|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$/,
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/,
  /^[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}(?:[Tt]|[ \t]+)[0-9]{1,2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]*)?(?:[ \t]*(?:Z|[-+][0-9]{1,2}(?::[0-9]{2})?))?$/,
];

function spansLines(text: string, range: Range | null | undefined): boolean {
  return range !== null && range !== undefined
    ? text.slice(range[0], range[1]).includes('\n')
    : true;
}

function refusal(text: string, node: YamlNode): string | undefined {
  if (node.anchor !== undefined) {
    return 'an anchor';
  }

  if (node.tag !== undefined) {
    return `the tag ${node.tag}`;
  }

  if (!isScalar(node)) {
    return undefined;
  }

  if (node.type === 'BLOCK_FOLDED') {
    return 'a folded scalar';
  }

  const { value } = node;
  if (
    node.type === 'PLAIN' &&
    typeof value === 'string' &&
    jsYamlNotString.some((pattern) => pattern.test(value))
  ) {
    return 'a plain scalar js-yaml reads as a number or date';
  }

  return node.type !== undefined &&
    oneLineStyles.has(node.type) &&
    spansLines(text, node.range)
    ? 'a scalar over several lines'
    : undefined;
}

export function readYaml(text: string): YamlRead {
  const doc = parseDocument(text, {
    version: '1.2',
    schema: 'core',
    merge: false,
    uniqueKeys: true,
    strict: true,
    prettyErrors: false,
  });
  const problem = doc.errors[0] ?? doc.warnings[0];
  if (problem !== undefined) {
    return { kind: 'unreadable', error: problem.message };
  }

  if (
    doc.directives.docStart !== null ||
    doc.directives.yaml.explicit === true
  ) {
    return { kind: 'unreadable', error: 'a directive or document marker' };
  }

  if (doc.contents === null) {
    return { kind: 'unreadable', error: 'an empty document' };
  }

  let refused: string | undefined;
  const refuse = (reason: string | undefined) => {
    refused = reason;

    return reason === undefined ? undefined : visit.BREAK;
  };

  visit(doc, {
    Alias: () => refuse('an alias'),
    Scalar: (_, node) => refuse(refusal(text, node)),
    Map: (_, node) => refuse(refusal(text, node)),
    Seq: (_, node) => refuse(refusal(text, node)),
    Pair: (_, pair) => {
      const { key } = pair;
      if (!isScalar(key) || typeof key.value !== 'string') {
        return refuse('a key that is not a string');
      }

      return refuse(key.value === '<<' ? 'a merge key' : undefined);
    },
  });

  return refused === undefined
    ? { kind: 'read', value: doc.toJS() }
    : { kind: 'unreadable', error: `YAML with ${refused}` };
}
