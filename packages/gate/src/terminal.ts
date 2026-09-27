import type { Outcome } from './policy';

export type Style = {
  readonly outcome: (outcome: Outcome | 'UNREADABLE', text: string) => string;
  readonly strong: (text: string) => string;
  readonly dim: (text: string) => string;
};

export const plain: Style = {
  outcome: (_outcome, text) => text,
  strong: (text) => text,
  dim: (text) => text,
};

const sgr = (open: string, close: string) => (text: string) =>
  `\u001b[${open}m${text}\u001b[${close}m`;
const bold = sgr('1', '22');
const colors = {
  ACCEPT: sgr('32', '39'),
  QUARANTINE: sgr('33', '39'),
  REJECT: sgr('31', '39'),
  UNREADABLE: sgr('35', '39'),
};

export const ansi: Style = {
  outcome: (outcome, text) => bold(colors[outcome](text)),
  strong: bold,
  dim: sgr('2', '22'),
};

const unprintable = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu;
const named: Readonly<Record<string, string>> = {
  '\t': '\\t',
  '\n': '\\n',
  '\r': '\\r',
};

function hex(char: string): string {
  const code = char.codePointAt(0) ?? 0;

  if (code < 0x100) {
    return `\\x${code.toString(16).padStart(2, '0')}`;
  }

  return code > 0xffff
    ? `\\u{${code.toString(16)}}`
    : `\\u${code.toString(16).padStart(4, '0')}`;
}

export function inert(text: string): string {
  return text
    .replaceAll('\\', '\\\\')
    .replaceAll(unprintable, (char) => named[char] ?? hex(char));
}

export function inertJson(value: unknown): string {
  return JSON.stringify(value).replaceAll(unprintable, (char) =>
    char
      .split('')
      .map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`)
      .join(''),
  );
}

const forcing = new Set(['', '1', 'true', '2', '3']);

export function colorEnabled(input: {
  isTTY: boolean | undefined;
  env: Readonly<Record<string, string | undefined>>;
}): boolean {
  const { FORCE_COLOR: force, NO_COLOR: no, TERM: term } = input.env;
  if (force !== undefined) {
    return forcing.has(force);
  }

  if (no !== undefined && no !== '') {
    return false;
  }

  return term !== 'dumb' && input.isTTY === true;
}
