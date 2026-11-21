// Reads every case from /input/cases.json and writes /output/answers.json, one answer per case in
// order, each exactly csv-reader 1.0.0's reading of the case's input. The fast path is the
// WebAssembly reader (wasmcsv.js, built from wasm/src/lib.rs); if it cannot take the input, the
// same reader in JavaScript (rawcsv.js) does, and failing that the plain string reader (solve.js).
// Outside a container MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for /input and /output.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// Only V8's incremental marking is turned off, as the house baseline does. Wasm compiler flags must
// not be changed at run time: Node 26 aborts on them.
setFlagsFromString('--no-incremental-marking');

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const casesPath = join(inputDir, 'cases.json');
const answersPath = join(outputDir, 'answers.json');

let pending = true;
try {
  const { writeAnswers } = (await import(new URL('./wasmcsv.js', import.meta.url).href)) as {
    writeAnswers: (inPath: string, outPath: string) => boolean;
  };
  pending = !writeAnswers(casesPath, answersPath);
} catch {
  pending = true;
}
if (pending) {
  // The fallbacks rewrite answers.json whole.
  const bytes = readFileSync(casesPath);
  let answers: Buffer | string | null = null;
  try {
    const raw = (await import(new URL('./rawcsv.js', import.meta.url).href)) as {
      transformCases: (input: Buffer) => Buffer | null;
      warmUp: () => void;
    };
    raw.warmUp();
    answers = raw.transformCases(bytes);
  } catch {
    answers = null;
  }
  if (answers === null) {
    const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as { run: (input: unknown) => unknown };
    const cases = JSON.parse(bytes.toString('utf8')) as { id: string; input: unknown }[];
    answers = JSON.stringify(cases.map((c) => run(c.input)));
  }
  writeFileSync(answersPath, answers);
}
