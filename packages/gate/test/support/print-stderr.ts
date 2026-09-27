import { Console, Effect } from 'effect';
import { runCli } from '../../src/output';

runCli(
  Effect.gen(function* () {
    for (let line = 0; line < 1800; line++) {
      yield* Console.error(`${line} ${'x'.repeat(194)}`);
    }
  }),
);
