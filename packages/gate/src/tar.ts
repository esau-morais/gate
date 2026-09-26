import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';

const block = 512;

export class TarError extends Error {
  override readonly name = 'TarError';
}

export type TarEntry = { readonly path: string; readonly body: Buffer };

function field(header: Buffer, start: number, length: number): string {
  const raw = header.subarray(start, start + length);
  const end = raw.indexOf(0);

  return raw.subarray(0, end === -1 ? length : end).toString('utf8');
}

function octal(header: Buffer, start: number, length: number): number {
  const text = field(header, start, length).trim();
  if (!/^[0-7]+$/.test(text)) {
    throw new TarError(`unreadable octal field ${JSON.stringify(text)}`);
  }

  return Number.parseInt(text, 8);
}

function checksumMatches(header: Buffer): boolean {
  let sum = 0;
  for (const [index, byte] of header.entries()) {
    sum += index >= 148 && index < 156 ? 0x20 : byte;
  }

  return sum === octal(header, 148, 8);
}

function paxRecords(body: Buffer): Map<string, string> {
  const records = new Map<string, string>();
  let offset = 0;
  while (offset < body.length) {
    const space = body.indexOf(0x20, offset);
    const length = Number(body.subarray(offset, space).toString('latin1'));
    if (space === -1 || !Number.isSafeInteger(length) || length <= 0) {
      throw new TarError('unreadable pax header');
    }

    const record = body.subarray(space + 1, offset + length - 1).toString();
    const equals = record.indexOf('=');
    if (equals === -1 || body[offset + length - 1] !== 0x0a) {
      throw new TarError('unreadable pax record');
    }

    records.set(record.slice(0, equals), record.slice(equals + 1));
    offset += length;
  }

  return records;
}

type Pending = {
  readonly type: string;
  readonly path: string;
  readonly size: number;
};

export async function readTarGz(
  path: string,
  onFile: (entry: TarEntry) => void,
): Promise<{ readonly comment: string | undefined }> {
  let buffered: Buffer = Buffer.alloc(0);
  let pending: Pending | undefined;
  let nextPath: string | undefined;
  let comment: string | undefined;
  let ended = false;

  for await (const chunk of createReadStream(path).pipe(createGunzip())) {
    if (!Buffer.isBuffer(chunk)) {
      throw new TarError('gunzip produced a non-buffer chunk');
    }

    buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);
    let offset = 0;
    while (!ended) {
      if (pending !== undefined) {
        const padded = Math.ceil(pending.size / block) * block;
        if (buffered.length - offset < padded) {
          break;
        }

        const body = buffered.subarray(offset, offset + pending.size);
        offset += padded;
        const entry = pending;
        pending = undefined;
        if (entry.type === 'g') {
          comment = paxRecords(body).get('comment') ?? comment;
        } else if (entry.type === 'x') {
          nextPath = paxRecords(body).get('path');
        } else {
          if (entry.type === '0' || entry.type === '\0') {
            onFile({ path: entry.path, body: Buffer.from(body) });
          }

          nextPath = undefined;
        }

        continue;
      }

      if (buffered.length - offset < block) {
        break;
      }

      const header = buffered.subarray(offset, offset + block);
      offset += block;
      if (header.every((byte) => byte === 0)) {
        ended = true;
        break;
      }

      if (!checksumMatches(header)) {
        throw new TarError('tar header checksum mismatch');
      }

      const name = field(header, 0, 100);
      const prefix = field(header, 345, 155);
      pending = {
        type: String.fromCharCode(header[156] ?? 0),
        path: nextPath ?? (prefix === '' ? name : `${prefix}/${name}`),
        size: octal(header, 124, 12),
      };
    }

    buffered = buffered.subarray(offset);
  }

  if (!ended) {
    throw new TarError('tar archive ends without an end-of-archive block');
  }

  return { comment };
}
