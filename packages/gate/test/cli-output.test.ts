import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { largeReportArgs, slowPipeMismatch } from './support/slow-pipe';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const printStderr = fileURLToPath(
  new URL('support/print-stderr.ts', import.meta.url),
);

describe('CLI output to a pipe whose reader is slow', () => {
  test.each([
    ['--json', [...largeReportArgs, '--json']],
    ['the report', largeReportArgs],
  ])('carries every byte of %s', (_name, args) => {
    expect(slowPipeMismatch(['bun', cli, ...args])).toBeUndefined();
  });

  test('carries every byte of stderr', () => {
    expect(slowPipeMismatch(['bun', printStderr], 'stderr')).toBeUndefined();
  });
});
