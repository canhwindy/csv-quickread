// Times the module's own work with no file I/O and no fresh memory: one instance, the input read
// once, then locate_cases and every answer_case repeated in the same memory.
// Usage: node [v8 flags] test/wasmcore.mjs <cases.json>
import { readFileSync } from 'node:fs';

const bytes = readFileSync(process.argv[2]);
const module = new WebAssembly.Module(readFileSync(new URL('../csvcore.wasm', import.meta.url)));
const { memory, answer_case: answerCase, locate_cases: locateCases } = new WebAssembly.Instance(module, {}).exports;
const inputAt = memory.buffer.byteLength;
const casesAt = inputAt + ((bytes.length + 7) & ~7);
const fieldsAt = casesAt + (1 << 16) * 12;
const errAt = fieldsAt + (1 << 18) * 4;
const errCap = 64 << 20;
const outAt = errAt + errCap;
const outCap = 3 * bytes.length;
memory.grow(Math.ceil((outAt + outCap - inputAt) / 65536));
new Uint8Array(memory.buffer, inputAt, bytes.length).set(bytes);
const ms = (t) => ((t.user + t.system) / 1000).toFixed(1);
for (let r = 0; r < 5; r++) {
  let t = process.cpuUsage();
  const count = locateCases(inputAt, bytes.length, casesAt, 1 << 16);
  const locate = ms(process.cpuUsage(t));
  const cases = new Uint32Array(memory.buffer, casesAt, count * 3);
  t = process.cpuUsage();
  let total = 0;
  for (let k = 0; k < count; k++) {
    total += answerCase(inputAt, cases[k * 3], cases[k * 3 + 1], cases[k * 3 + 2], outAt, outCap, errAt, errCap, fieldsAt, 1 << 18);
  }
  console.log(`round ${r}: locate ${locate} ms, answer ${ms(process.cpuUsage(t))} ms (${total} bytes)`);
}
