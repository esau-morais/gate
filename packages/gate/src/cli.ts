import { readFileSync } from 'node:fs';
import { BunRuntime, BunServices } from '@effect/platform-bun';
import { Clock, Console, Effect, Option, Result, Schema } from 'effect';
import { Command, Flag } from 'effect/unstable/cli';
import { DecisionContext, noContext } from './context';
import { appendToLog, LogError, readLog } from './log/log';
import {
  NoteError,
  parseSignerKey,
  parseVerifierKey,
  type NoteSigner,
} from './log/note';
import {
  EvidenceDirectoryError,
  isFileSystemError,
  readEvidenceDirectory,
} from './npm/evidence-directory';
import { readPackageLock } from './npm/lockfile';
import { decisionRecords, verifyExitCode, verifyNodes } from './npm/verify';
import { canonicalPolicy, pinnedPolicies } from './pinned-policies';
import { PolicyLoadError } from './policy';
import { encodeRecord, lockfileDigest } from './record';
import { replayEntry, replayExitCode } from './replay';
import { UtcTimestamp } from './time';

const decodeAt = Schema.decodeUnknownOption(UtcTimestamp);
const decodeContext = Schema.decodeUnknownSync(
  Schema.fromJsonString(DecisionContext),
);

class InputError extends Error {
  override readonly name = 'InputError';
}

const fail = (command: string, message: string) =>
  Effect.gen(function* () {
    yield* Console.error(`gate ${command}: ${message}`);
    process.exitCode = 1;
  });

function isInputError(error: unknown): error is Error {
  return (
    error instanceof InputError ||
    error instanceof EvidenceDirectoryError ||
    error instanceof PolicyLoadError ||
    error instanceof NoteError ||
    error instanceof LogError ||
    isFileSystemError(error)
  );
}

const attempt = <A>(run: () => A): Effect.Effect<A, string> =>
  Effect.suspend(() => {
    try {
      return Effect.succeed(run());
    } catch (error) {
      return isInputError(error)
        ? Effect.fail(error.message)
        : Effect.die(error);
    }
  });

function readContext(path: string): DecisionContext {
  const text = readFileSync(path, 'utf8');
  try {
    return decodeContext(text, { onExcessProperty: 'error' });
  } catch (error) {
    throw new InputError(`context ${path}: ${String(error)}`);
  }
}

function readKeyFile<A>(path: string, parse: (text: string) => A): A {
  try {
    return parse(readFileSync(path, 'utf8').trimEnd());
  } catch (error) {
    if (error instanceof NoteError) {
      throw new InputError(`key ${path}: ${error.message}`);
    }

    throw error;
  }
}

type VerifyConfig = {
  readonly lockfile: string;
  readonly evidence: string;
  readonly context: Option.Option<string>;
  readonly log: Option.Option<string>;
  readonly logKey: Option.Option<string>;
};

function logTarget(
  config: VerifyConfig,
): { dir: string; signer: NoteSigner } | undefined {
  if (Option.isNone(config.log) && Option.isNone(config.logKey)) {
    return undefined;
  }

  if (Option.isNone(config.log) || Option.isNone(config.logKey)) {
    throw new InputError('--log and --log-key go together');
  }

  return {
    dir: config.log.value,
    signer: readKeyFile(config.logKey.value, parseSignerKey),
  };
}

const readInputs = (config: VerifyConfig) =>
  attempt(() => {
    const bytes = readFileSync(config.lockfile);

    return {
      lock: readPackageLock(new TextDecoder().decode(bytes)),
      lockfile: lockfileDigest(bytes),
      store: readEvidenceDirectory(config.evidence),
      policy: canonicalPolicy(),
      context: Option.isSome(config.context)
        ? readContext(config.context.value)
        : noContext,
      log: logTarget(config),
    };
  });

const verify = Command.make(
  'verify',
  {
    lockfile: Flag.String('lockfile').pipe(
      Flag.withDescription('package-lock.json (v2 or v3) to verify'),
    ),
    evidence: Flag.String('evidence').pipe(
      Flag.withDescription(
        'directory of recorded packuments, attestations, OSV records and trusted_root.json',
      ),
    ),
    at: Flag.String('at').pipe(
      Flag.withDescription(
        'evaluation time as a UTC timestamp; defaults to now',
      ),
      Flag.optional,
    ),
    context: Flag.String('context').pipe(
      Flag.withDescription(
        'JSON file with the allowedSources and waivers the decisions use',
      ),
      Flag.optional,
    ),
    log: Flag.String('log').pipe(
      Flag.withDescription(
        'decision log directory to append every decision to',
      ),
      Flag.optional,
    ),
    logKey: Flag.String('log-key').pipe(
      Flag.withDescription(
        'file holding the log signer key (PRIVATE+KEY+<name>+<id>+<key>); the name is the log origin',
      ),
      Flag.optional,
    ),
  },
  (config) =>
    Effect.gen(function* () {
      const at = Option.isSome(config.at)
        ? decodeAt(config.at.value)
        : Option.some(new Date(yield* Clock.currentTimeMillis));
      if (Option.isNone(at)) {
        return yield* fail('verify', '--at must be a UTC timestamp');
      }

      const inputs = yield* readInputs(config).pipe(Effect.result);
      if (Result.isFailure(inputs)) {
        return yield* fail('verify', inputs.failure);
      }

      const { lock, lockfile, store, policy, context, log } = inputs.success;
      const records =
        lock.kind === 'read'
          ? verifyNodes({
              nodes: lock.nodes,
              store,
              at: at.value,
              policy,
              context,
            })
          : [{ kind: 'unreadable' as const, path: '', error: lock.error }];
      if (log !== undefined) {
        const entries = decisionRecords({ records, context, lockfile }).map(
          encodeRecord,
        );
        const appended = yield* attempt(() =>
          appendToLog({ ...log, entries }),
        ).pipe(Effect.result);
        if (Result.isFailure(appended)) {
          return yield* fail('verify', appended.failure);
        }
      }

      for (const record of records) {
        yield* Console.log(JSON.stringify(record));
      }

      process.exitCode = verifyExitCode(records);
    }),
).pipe(
  Command.withDescription(
    'Decide every package-lock.json node against SupplyChainPolicy/v2 from recorded evidence',
  ),
);

const replay = Command.make(
  'replay',
  {
    log: Flag.String('log').pipe(
      Flag.withDescription('decision log directory to replay'),
    ),
    publicKey: Flag.String('public-key').pipe(
      Flag.withDescription(
        'file holding the log verifier key (<name>+<id>+<key>)',
      ),
    ),
  },
  (config) =>
    Effect.gen(function* () {
      const opened = yield* attempt(() => {
        const verifier = readKeyFile(config.publicKey, parseVerifierKey);
        const read = readLog({ dir: config.log, verifier });
        if (read.kind === 'unreadable') {
          throw new InputError(read.error);
        }

        return { entries: read.entries(), policies: pinnedPolicies() };
      }).pipe(Effect.result);
      if (Result.isFailure(opened)) {
        return yield* fail('replay', opened.failure);
      }

      const { entries, policies } = opened.success;
      const results = entries.map((entry) => replayEntry(entry, policies));
      for (const result of results) {
        yield* Console.log(JSON.stringify(result));
      }

      process.exitCode = replayExitCode(results);
    }),
).pipe(
  Command.withDescription(
    'Verify a decision log against its public key and re-decide every entry offline with its pinned policy',
  ),
);

const gate = Command.make('gate').pipe(
  Command.withSubcommands([verify, replay]),
);

Command.run(gate, { version: '0.0.0' }).pipe(
  Effect.provide(BunServices.layer),
  BunRuntime.runMain,
);
