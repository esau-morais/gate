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

  return node.type !== undefined &&
    oneLineStyles.has(node.type) &&
    spansLines(text, node.range)
    ? 'a scalar over several lines'
    : undefined;
}

// Reads one YAML document and refuses every feature that can change what a
// node means (anchors, aliases, tags, merge keys, directives, folded lines), so
// that none can give a node a meaning pnpm's own reader wouldn't.
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
