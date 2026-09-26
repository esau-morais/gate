import { readFileSync } from 'node:fs';
import { BunRuntime, BunServices } from '@effect/platform-bun';
import { Clock, Console, Effect, Option, Result, Schema } from 'effect';
import { Command, Flag } from 'effect/unstable/cli';
import policyText from '../policies/supply-chain-policy-v2.json' with { type: 'text' };
import {
  EvidenceDirectoryError,
  isFileSystemError,
  readEvidenceDirectory,
} from './npm/evidence-directory';
import { readPackageLock, type PackageLockRead } from './npm/lockfile';
import { verifyExitCode, verifyNodes, type EvidenceStore } from './npm/verify';
import { supplyChainPolicyV2Digest } from './policies';
import { loadPolicy, PolicyLoadError, type Policy } from './policy';
import { UtcTimestamp } from './time';

const decodeAt = Schema.decodeUnknownOption(UtcTimestamp);

function canonicalPolicy() {
  const text: unknown = policyText;
  if (typeof text !== 'string') {
    throw new PolicyLoadError('the bundled policy was not embedded as text');
  }

  return loadPolicy(new TextEncoder().encode(text), supplyChainPolicyV2Digest);
}

const fail = (message: string) =>
  Effect.gen(function* () {
    yield* Console.error(`gate verify: ${message}`);
    process.exitCode = 1;
  });

function isInputError(error: unknown): error is Error {
  return (
    error instanceof EvidenceDirectoryError ||
    error instanceof PolicyLoadError ||
    isFileSystemError(error)
  );
}

const readInputs = (paths: { lockfile: string; evidence: string }) =>
  Effect.suspend(
    (): Effect.Effect<
      {
        lock: PackageLockRead;
        store: EvidenceStore;
        policy: Policy;
      },
      string
    > => {
      try {
        return Effect.succeed({
          lock: readPackageLock(readFileSync(paths.lockfile, 'utf8')),
          store: readEvidenceDirectory(paths.evidence),
          policy: canonicalPolicy(),
        });
      } catch (error) {
        return isInputError(error)
          ? Effect.fail(error.message)
          : Effect.die(error);
      }
    },
  );

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
  },
  (config) =>
    Effect.gen(function* () {
      const at = Option.isSome(config.at)
        ? decodeAt(config.at.value)
        : Option.some(new Date(yield* Clock.currentTimeMillis));
      if (Option.isNone(at)) {
        return yield* fail('--at must be a UTC timestamp');
      }

      const inputs = yield* readInputs(config).pipe(Effect.result);
      if (Result.isFailure(inputs)) {
        return yield* fail(inputs.failure);
      }

      const { lock, store, policy } = inputs.success;
      const records =
        lock.kind === 'read'
          ? verifyNodes({ nodes: lock.nodes, store, at: at.value, policy })
          : [{ kind: 'unreadable' as const, path: '', error: lock.error }];
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

const gate = Command.make('gate').pipe(Command.withSubcommands([verify]));

Command.run(gate, { version: '0.0.0' }).pipe(
  Effect.provide(BunServices.layer),
  BunRuntime.runMain,
);
