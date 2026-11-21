// The fastest path: the same single-pass byte reader as rawcsv.js, built from wasm/src/lib.rs
// (Rust, no_std) into csvcore.wasm. cases.json is read straight into the module's memory and each
// case is answered in place into one reused output area, which goes to answers.json before the next
// case: the input is never copied, no case text becomes a JS string, and little fresh memory is
// touched (page faults cost CPU time too). writeAnswers(inPath, outPath) returns null when every
// answer is written, else the input bytes, so the caller can fall back on them.
import { closeSync, fstatSync, openSync, readFileSync, readSync, writeSync } from 'node:fs';
import { locateCases } from './rawcsv.js';

const PAGE = 65536;
const FIELDS_CAP = 1 << 18;

function readAll(fd, target) {
  let got = 0;
  while (got < target.length) {
    const n = readSync(fd, target, got, target.length - got, got);
    if (n <= 0) break;
    got += n;
  }
  return got;
}

export function writeAnswers(inPath, outPath) {
  const module = new WebAssembly.Module(readFileSync(new URL('./csvcore.wasm', import.meta.url)));
  const { memory, answer_case: answerCase, string_end: stringEnd } = new WebAssembly.Instance(module, {}).exports;

  const fd = openSync(inPath, 'r');
  const size = fstatSync(fd).size;
  const inputAt = memory.buffer.byteLength;
  const fieldsAt = inputAt + ((size + 7) & ~7);
  const errAt = fieldsAt + FIELDS_CAP * 4;
  // Each case's answer and error records are bounded by its own text: 3 output bytes and 32 error
  // bytes per text byte, plus room (a case that needs more falls back).
  const located = { cases: null };
  const input = Buffer.from(memory.buffer, 0, 0);
  memory.grow(Math.ceil((errAt - inputAt) / PAGE));
  const view = Buffer.from(memory.buffer, inputAt, size);
  const got = readAll(fd, view);
  closeSync(fd);
  if (got !== size) return view.subarray(0, got);
  located.cases = locateCases(view, (at) => stringEnd(inputAt, at, size));
  const cases = located.cases;
  if (cases === null) return view;

  let longest = 0;
  for (const c of cases) longest = Math.max(longest, c.textEnd - c.text);
  const errCap = 32 * longest + (1 << 16);
  const outAt = errAt + errCap;
  const outCap = 3 * longest + (1 << 20);
  memory.grow(Math.ceil((outAt + outCap - memory.buffer.byteLength) / PAGE));

  const out = Buffer.from(memory.buffer, outAt, outCap);
  const ofd = openSync(outPath, 'w');
  try {
    if (cases.length === 0) {
      out[0] = 91;
      out[1] = 93;
      writeSync(ofd, out, 0, 2);
      return null;
    }
    for (let k = 0; k < cases.length; k++) {
      const c = cases[k];
      out[0] = k === 0 ? 91 : 44;
      const n = answerCase(inputAt, c.text, c.textEnd, c.header ? 1 : 0, outAt + 1, outCap - 2, errAt, errCap, fieldsAt, FIELDS_CAP);
      if (n < 0) return Buffer.from(memory.buffer, inputAt, size);
      let len = n + 1;
      if (k === cases.length - 1) out[len++] = 93;
      let done = 0;
      while (done < len) done += writeSync(ofd, out, done, len - done);
    }
  } finally {
    closeSync(ofd);
  }
  void input;
  return null;
}
