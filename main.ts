// Reads every case from /input/cases.json and writes /output/answers.json, one answer per case in
// order, each exactly csv-reader 1.0.0's reading of the case's input. The fast path (rawcsv.js)
// works on the raw JSON bytes; any input it does not expect goes to the plain reader (solve.js).
// Outside a container MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for /input and /output.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

setFlagsFromString('--no-incremental-marking --no-turbo-inlining');

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const bytes = readFileSync(join(inputDir, 'cases.json'));

const { transformCases, warmUp } = (await import(new URL('./rawcsv.js', import.meta.url).href)) as {
  transformCases: (input: Buffer) => Buffer | null;
  warmUp: () => void;
};

let answers: Buffer | string | null = null;
try {
  warmUp();
  answers = transformCases(bytes);
} catch {
  answers = null;
}
if (answers === null) {
  const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as { run: (input: unknown) => unknown };
  const cases = JSON.parse(bytes.toString('utf8')) as { id: string; input: unknown }[];
  answers = JSON.stringify(cases.map((c) => run(c.input)));
}
writeFileSync(join(outputDir, 'answers.json'), answers);
