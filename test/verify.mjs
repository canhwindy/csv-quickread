// Checks solve.js against the reference: the kit's practice cases, then random fuzz inputs built
// from the characters that matter (commas, quotes, CR, LF, BOM) compared with csv-reader 1.0.0.
// Usage: node test/verify.mjs <kit dir> [fuzz count]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { run } from '../solve.js';

const kit = process.argv[2];
const fuzzCount = Number(process.argv[3] ?? 20000);
const { readCsv } = await import(pathToFileURL(join(kit, 'baselines/csv-reader/vendor/csv-reader/index.js')).href);

const cases = JSON.parse(readFileSync(join(kit, 'practice/input/cases.json'), 'utf8'));
const expected = JSON.parse(readFileSync(join(kit, 'practice/reference/expected.json'), 'utf8'));
let bad = 0;
cases.forEach((c, i) => {
  const same = JSON.stringify(run(c.input)) === JSON.stringify(expected.cases[i].output);
  if (!same) bad++;
  console.log(`${c.id}: ${same ? 'ok' : 'DIFFERENT'} (${c.input.text.length} chars, header ${c.input.header})`);
});

let seed = 12345;
const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
const alphabet = ['a', 'b', ',', '"', '""', '\r', '\n', '\r\n', ' ', '﻿', 'xy'];
for (let k = 0; k < fuzzCount; k++) {
  let text = rand() < 0.1 ? '﻿' : '';
  const len = Math.floor(rand() * 40);
  for (let i = 0; i < len; i++) text += alphabet[Math.floor(rand() * alphabet.length)];
  const input = { text, header: rand() < 0.5 };
  const want = JSON.stringify(readCsv(input));
  const got = JSON.stringify(run(input));
  if (want !== got) {
    bad++;
    if (bad < 6) console.log('fuzz mismatch', JSON.stringify(input), '\n want', want, '\n got ', got);
  }
}
console.log(bad ? `FAILED: ${bad} mismatches` : `all good (${cases.length} practice cases, ${fuzzCount} fuzz inputs)`);
process.exit(bad ? 1 : 0);
