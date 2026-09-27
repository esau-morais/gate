import { readSync, writeSync } from 'node:fs';

const chunk = new Uint8Array(65_536);
let read = readSync(0, chunk);
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
while (read > 0) {
  writeSync(1, chunk, 0, read);
  read = readSync(0, chunk);
}
