import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordedPnpmLockPath } from '../pnpm/locks';
import { evidenceDir } from '../verify/cases';

export const largeReportArgs = [
  'verify',
  '--lockfile',
  recordedPnpmLockPath('rules-js-v110'),
  '--evidence',
  fileURLToPath(evidenceDir),
  '--at',
  '2026-09-23T12:17:15Z',
];

const reader = fileURLToPath(new URL('slow-reader.ts', import.meta.url));
const pipeCapacity = 65_536;

type Stream = 'stdout' | 'stderr';
type Printed = { readonly text: string; readonly exitCode: number };

function inTempDir<A>(run: (dir: string) => A): A {
  const dir = mkdtempSync(join(tmpdir(), 'gate-output-'));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function printToFile(command: readonly string[], stream: Stream): Printed {
  return inTempDir((dir) => {
    const path = join(dir, stream);
    const fd = openSync(path, 'w');
    try {
      const run =
        stream === 'stdout'
          ? Bun.spawnSync([...command], { stdout: fd, stderr: 'inherit' })
          : Bun.spawnSync([...command], { stdout: 'ignore', stderr: fd });

      return { text: readFileSync(path, 'latin1'), exitCode: run.exitCode };
    } finally {
      closeSync(fd);
    }
  });
}

function exitStatus(path: string): number {
  const text = readFileSync(path, 'utf8').trim();
  if (!/^\d+$/.test(text)) {
    throw new Error(`no exit status in ${path}: ${JSON.stringify(text)}`);
  }

  return Number(text);
}

function printToSlowPipe(command: readonly string[], stream: Stream): Printed {
  return inTempDir((dir) => {
    const status = join(dir, 'status');
    const redirect = stream === 'stdout' ? '' : ' 2>&1 >/dev/null';
    const run = Bun.spawnSync(
      [
        'sh',
        '-c',
        `status=$1 runtime=$2 reader=$3; shift 3; { "$@"${redirect}; echo $? > "$status"; } | "$runtime" "$reader"`,
        'sh',
        status,
        process.execPath,
        reader,
        ...command,
      ],
      { stdout: 'pipe', stderr: 'inherit' },
    );

    return {
      text: run.stdout.toString('latin1'),
      exitCode: exitStatus(status),
    };
  });
}

export function slowPipeMismatch(
  command: readonly string[],
  stream: Stream = 'stdout',
): string | undefined {
  const file = printToFile(command, stream);
  if (file.text.length <= pipeCapacity) {
    return `${stream} holds ${file.text.length} bytes, which fit in a pipe`;
  }

  const piped = printToSlowPipe(command, stream);
  if (piped.text !== file.text || piped.exitCode !== file.exitCode) {
    return `${stream} through a slow pipe: ${piped.text.length} of ${file.text.length} bytes, exit ${piped.exitCode}; to a file: exit ${file.exitCode}`;
  }

  return undefined;
}
