// The fastest path: the same single-pass byte reader as rawcsv.js, built from wasm/src/lib.rs
// (Rust, no_std, SIMD) into csvcore.wasm. cases.json streams through a window in the module's
// memory: the module finds the next whole case in it, answers that case into one reused output
// area, the answer goes to answers.json, and the unread rest of the window moves to its front for
// the next read. The input is never decoded into JS strings, and only a few MB of fresh memory are
// ever touched (a page touched for the first time costs CPU time too).
// writeAnswers(inPath, outPath) returns true when every answer is written; false leaves the job to
// the JavaScript readers (an input shaped otherwise, or a case too big for the buffers).
import { closeSync, openSync, readFileSync, readSync, writeSync } from 'node:fs';

const PAGE = 65536;
const FIELDS_CAP = 1 << 18;
// The first window; CSVQ_WINDOW sets another, which the tests use to make it slide and grow.
const FIRST_WINDOW = Number(process.env.CSVQ_WINDOW) || 4 << 20;

export function writeAnswers(inPath, outPath) {
  const module = new WebAssembly.Module(readFileSync(new URL('./csvcore.wasm', import.meta.url)));
  const { memory, answer_case: answerCase, locate_next: locateNext } = new WebAssembly.Instance(module, {}).exports;

  const scratchAt = memory.buffer.byteLength; // five u32s from locate_next
  const fieldsAt = scratchAt + 64;
  let windowSize = 0;
  let windowAt = 0;
  let errAt = 0;
  let errCap = 0;
  let outAt = 0;
  let outCap = 0;
  // Lays out a window of `size` bytes, with error and answer areas sized for a case that fills it
  // (3 answer bytes and 32 error bytes per text byte, plus room), after everything already there.
  const layout = (size) => {
    const start = Math.max(memory.buffer.byteLength, fieldsAt + FIELDS_CAP * 4);
    windowSize = size;
    windowAt = start;
    errAt = windowAt + size;
    errCap = 32 * size + (1 << 16);
    outAt = errAt + errCap;
    outCap = 3 * size + (1 << 20);
    memory.grow(Math.ceil((outAt + outCap - memory.buffer.byteLength) / PAGE));
  };
  layout(FIRST_WINDOW);

  const ifd = openSync(inPath, 'r');
  const ofd = openSync(outPath, 'w');
  try {
    let filled = 0; // bytes of the window holding input
    let pos = 0; // the next unread byte in the window
    let fileAt = 0; // the file offset of the window's first byte
    let eof = false;
    let first = 1;
    for (;;) {
      const next = locateNext(windowAt, filled, pos, first, scratchAt);
      if (next < 0) {
        if (eof) return false;
        // Not a whole case yet: move the unread rest to the front and read more, in a bigger
        // window when this one is full.
        if (pos > 0) {
          new Uint8Array(memory.buffer).copyWithin(windowAt, windowAt + pos, windowAt + filled);
          fileAt += pos;
          filled -= pos;
          pos = 0;
        }
        if (filled === windowSize) {
          const old = windowAt;
          layout(windowSize * 2);
          new Uint8Array(memory.buffer).copyWithin(windowAt, old, old + filled);
        }
        const view = new Uint8Array(memory.buffer, windowAt + filled, windowSize - filled);
        const n = readSync(ifd, view, 0, view.length, fileAt + filled);
        if (n <= 0) eof = true;
        filled += Math.max(0, n);
        continue;
      }
      const found = new Uint32Array(memory.buffer, scratchAt, 5);
      const out = new Uint8Array(memory.buffer, outAt, outCap);
      if (found[3] === 0) {
        // The array is empty.
        out[0] = 91;
        out[1] = 93;
        writeSync(ofd, out, 0, 2);
        return true;
      }
      out[0] = first ? 91 : 44;
      const n = answerCase(windowAt, found[0], found[1], found[2], outAt + 1, outCap - 2, errAt, errCap, fieldsAt, FIELDS_CAP);
      if (n < 0) return false;
      let len = n + 1;
      const last = found[4] === 1;
      if (last) out[len++] = 93;
      let done = 0;
      while (done < len) done += writeSync(ofd, out, done, len - done);
      first = 0;
      pos = next;
      if (last) return true;
    }
  } finally {
    closeSync(ifd);
    closeSync(ofd);
  }
}
