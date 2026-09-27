import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { BunRuntime, BunServices } from '@effect/platform-bun';
import { Clock, Console, Effect, Option, Result, Schema } from 'effect';
import { Command, Flag } from 'effect/unstable/cli';
import { DecisionContext, noContext } from './context';
import {
  defaultCacheDir,
  defaultLockfile,
  evidenceSource,
  lockfileFormat,
  lockfileNames,
} from './verify-defaults';
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
  readFetchGaps,
} from './npm/evidence-directory';
import { collectEvidence } from './npm/collect';
import { readPackageLock, type LockfileRead } from './npm/lockfile';
import { readPnpmLock } from './npm/pnpm-lock';
import { humanReport } from './npm/report';
import { sigstoreTrustedRoot } from './npm/trusted-root';
import { decisionRecords, verifyExitCode, verifyNodes } from './npm/verify';
import { canonicalPolicy, pinnedPolicies } from './pinned-policies';
import { PolicyLoadError } from './policy';
import { encodeRecord, lockfileDigest } from './record';
import { replayEntry, replayExitCode } from './replay';
import { ansi, colorEnabled, inert, plain } from './terminal';
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
    yield* Console.error(
      `gate ${command}: ${message.split('\n').map(inert).join('\n')}`,
    );
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
  readonly lockfile: Option.Option<string>;
  readonly evidence: Option.Option<string>;
  readonly fetch: Option.Option<string>;
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

function lockfilePath(config: VerifyConfig): string {
  if (Option.isSome(config.lockfile)) {
    return config.lockfile.value;
  }

  const choice = defaultLockfile(existsSync);
  if (choice.kind === 'found') {
    return choice.path;
  }

  const [npm, pnpm] = lockfileNames;

  throw new InputError(
    choice.kind === 'none'
      ? `no ${npm} or ${pnpm} in ${process.cwd()}; pass --lockfile`
      : `both ${npm} and ${pnpm} in ${process.cwd()}; pass --lockfile`,
  );
}

function readLockfile(path: string, text: string): LockfileRead {
  return lockfileFormat(path, text) === 'pnpm-lock'
    ? readPnpmLock(text)
    : readPackageLock(text);
}

const readInputs = (config: VerifyConfig) =>
  attempt(() => {
    const source = evidenceSource(
      {
        evidence: Option.getOrUndefined(config.evidence),
        fetch: Option.getOrUndefined(config.fetch),
      },
      () =>
        defaultCacheDir({
          platform: process.platform,
          env: process.env,
          home: homedir(),
        }),
    );
    if (source.kind === 'conflict') {
      throw new InputError('pass --evidence or --fetch, not both');
    }

    const path = lockfilePath(config);
    const bytes = readFileSync(path);

    return {
      source,
      lock: readLockfile(path, new TextDecoder().decode(bytes)),
      lockfile: lockfileDigest(bytes),
      policy: canonicalPolicy(),
      context: Option.isSome(config.context)
        ? readContext(config.context.value)
        : noContext,
      log: logTarget(config),
    };
  });

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const collect = (cacheDir: string, lock: LockfileRead) =>
  Effect.tryPromise({
    try: () =>
      collectEvidence({
        nodes: lock.kind === 'read' ? lock.nodes : [],
        cacheDir,
        sources: {
          http: { fetch, now: () => new Date(), sleep },
          trustedRoot: () => sigstoreTrustedRoot(resolve(cacheDir, 'tuf')),
        },
      }),
    catch: (error) =>
      isInputError(error)
        ? error.message
        : `collecting evidence failed: ${String(error)}`,
  });

const verify = Command.make(
  'verify',
  {
    lockfile: Flag.String('lockfile').pipe(
      Flag.withDescription(
        'package-lock.json (v2 or v3) or pnpm-lock.yaml (9.0) to verify; defaults to whichever of the two is in the current directory',
      ),
      Flag.optional,
    ),
    evidence: Flag.String('evidence').pipe(
      Flag.withDescription(
        'directory of recorded packuments, attestations, OSV records and trusted_root.json',
      ),
      Flag.optional,
    ),
    fetch: Flag.String('fetch').pipe(
      Flag.withDescription(
        'cache directory; fetch live evidence into <dir>/evidence, then verify against it; defaults to the per-user cache when --evidence is absent',
      ),
      Flag.optional,
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
    json: Flag.Boolean('json').pipe(
      Flag.withDescription(
        'print one JSON decision record per line instead of the report',
      ),
      Flag.withDefault(false),
    ),
  },
  (config) =>
    Effect.gen(function* () {
      const requestedAt = Option.flatMap(config.at, decodeAt);
      if (Option.isSome(config.at) && Option.isNone(requestedAt)) {
        return yield* fail('verify', '--at must be a UTC timestamp');
      }

      const inputs = yield* readInputs(config).pipe(Effect.result);
      if (Result.isFailure(inputs)) {
        return yield* fail('verify', inputs.failure);
      }

      const { source, lock, lockfile, policy, context, log } = inputs.success;
      let evidenceDir: string;
      if (source.kind === 'fetch') {
        const collected = yield* collect(source.cacheDir, lock).pipe(
          Effect.result,
        );
        if (Result.isFailure(collected)) {
          return yield* fail('verify', collected.failure);
        }

        const { dir, gaps } = collected.success;
        if (gaps.length > 0) {
          yield* Console.error(
            `gate verify: ${gaps.length} evidence fetches failed; see ${inert(join(dir, 'SOURCES.json'))}`,
          );
        }

        evidenceDir = dir;
      } else {
        evidenceDir = source.dir;
      }

      const store = yield* attempt(() =>
        readEvidenceDirectory(evidenceDir),
      ).pipe(Effect.result);
      if (Result.isFailure(store)) {
        return yield* fail('verify', store.failure);
      }

      const at = Option.isSome(requestedAt)
        ? requestedAt.value
        : new Date(yield* Clock.currentTimeMillis);

      const records =
        lock.kind === 'read'
          ? verifyNodes({
              nodes: lock.nodes,
              store: store.success,
              at,
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

      if (config.json) {
        for (const record of records) {
          yield* Console.log(JSON.stringify(record));
        }
      } else {
        const report = humanReport({
          records,
          nodes: lock.kind === 'read' ? lock.nodes : [],
          policy,
          context,
          gaps: readFetchGaps(evidenceDir),
          style: colorEnabled({
            isTTY: process.stdout.isTTY,
            env: process.env,
          })
            ? ansi
            : plain,
        });
        yield* Console.log(report.trimEnd());
      }

      process.exitCode = verifyExitCode(records);
    }),
).pipe(
  Command.withDescription(
    'Decide every package-lock.json or pnpm-lock.yaml node against SupplyChainPolicy/v2 from recorded or freshly fetched evidence',
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
