import { Writable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { format } from 'node:util';
import { BunRuntime, BunServices } from '@effect/platform-bun';
import { Cause, Console, Effect, Runtime } from 'effect';

type Forwarded = {
  readonly stream: Writable;
  readonly failure: () => Error | undefined;
};

function forwardTo(target: NodeJS.WriteStream): Forwarded {
  let closed = false;
  let failure: Error | undefined;
  const stop = (error: Error) => {
    closed = true;
    if (!('code' in error && error.code === 'EPIPE')) {
      failure ??= error;
    }
  };

  target.on('error', stop);

  const stream = new Writable({
    write(chunk: Uint8Array, _encoding, callback) {
      if (closed) {
        callback();

        return;
      }

      target.write(chunk, (error) => {
        if (error !== undefined && error !== null) {
          stop(error);
        }

        callback();
      });
    },
  });

  return { stream, failure: () => failure };
}

const printTo =
  (stream: Writable) =>
  (...data: ReadonlyArray<unknown>) => {
    stream.write(`${format(...data)}\n`);
  };

export function runCli<A, E>(
  program: Effect.Effect<A, E, BunServices.BunServices>,
) {
  const stdout = forwardTo(process.stdout);
  const stderr = forwardTo(process.stderr);
  const flush = async () => {
    stdout.stream.end();
    stderr.stream.end();
    await Promise.all([finished(stdout.stream), finished(stderr.stream)]);
    const failure = stdout.failure() ?? stderr.failure();
    if (failure !== undefined) {
      throw failure;
    }
  };

  program.pipe(
    Effect.tapCause((cause) =>
      Cause.hasInterruptsOnly(cause) ||
      !Runtime.getErrorReported(Cause.squash(cause))
        ? Effect.void
        : Effect.logError(cause),
    ),
    Effect.provideService(Console.Console, {
      ...globalThis.console,
      log: printTo(stdout.stream),
      info: printTo(stdout.stream),
      debug: printTo(stdout.stream),
      error: printTo(stderr.stream),
      warn: printTo(stderr.stream),
    }),
    Effect.provide(BunServices.layer),
    BunRuntime.runMain({
      disableErrorReporting: true,
      teardown: (exit, onExit) => {
        flush().then(
          () => {
            Runtime.defaultTeardown(exit, onExit);
          },
          (error: unknown) => {
            process.stderr.write(
              `gate: writing output failed: ${String(error)}\n`,
            );
            onExit(1);
          },
        );
      },
    }),
  );
}
