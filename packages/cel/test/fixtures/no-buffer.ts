export {};

Reflect.deleteProperty(globalThis, 'Buffer');
const { Environment } = await import('../../src/index');
const env = new Environment();

let rejectsInvalidUtf8 = false;
try {
  env.evaluate("string(b'\\xff')");
} catch (e) {
  rejectsInvalidUtf8 = e instanceof Error && /invalid UTF-8/i.test(e.message);
}

console.log(
  JSON.stringify({
    hasBuffer: typeof Buffer !== 'undefined',
    json: env.evaluate('bytes(\'{"a":1}\').json()'),
    rejectsInvalidUtf8,
  }),
);
