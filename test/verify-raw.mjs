// Checks the byte-level fast paths (rawcsv.js, and wasmcsv.js with IMPL=wasm) against csv-reader 1.0.0: the practice cases, then
// fuzz batches written both as JSON.stringify writes them and with random \uXXXX escapes, odd key
// order and whitespace, so the reader cannot lean on one serializer's habits.
// Usage: node test/verify-raw.mjs <kit dir> [batches]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { transformCases as rawTransform } from '../rawcsv.js';
import { writeFileSync, mkdtempSync, readFileSync as readBack } from 'node:fs';
import { tmpdir } from 'node:os';
import { writeAnswers } from '../wasmcsv.js';

const scratch = mkdtempSync(join(tmpdir(), 'csvq-'));

const useWasm = process.env.IMPL === 'wasm';
const transformCases = useWasm
  ? (bytes) => {
      writeFileSync(join(scratch, 'cases.json'), bytes);
      const left = writeAnswers(join(scratch, 'cases.json'), join(scratch, 'answers.json'));
      return left === null ? readBack(join(scratch, 'answers.json')) : null;
    }
  : rawTransform;

const kit = process.argv[2];
const batches = Number(process.argv[3] ?? 200);
const { readCsv } = await import(pathToFileURL(join(kit, 'baselines/csv-reader/vendor/csv-reader/index.js')).href);

let bad = 0;
function compare(label, cases, bytes) {
  const got = transformCases(bytes);
  if (got === null) {
    bad++;
    console.log(label, 'fell back (null)');
    return;
  }
  let answers;
  try {
    answers = JSON.parse(got.toString('utf8'));
  } catch (e) {
    bad++;
    console.log(label, 'wrote invalid JSON', e.message);
    return;
  }
  cases.forEach((c, i) => {
    const want = JSON.stringify(readCsv(c.input));
    const have = JSON.stringify(answers[i]);
    if (want !== have) {
      bad++;
      if (bad < 6) console.log(label, 'mismatch', JSON.stringify(c.input), '\n want', want, '\n got ', have);
    }
  });
}

const practice = readFileSync(join(kit, 'practice/input/cases.json'));
compare('practice', JSON.parse(practice.toString('utf8')), practice);

let seed = 987654321;
const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
const alphabet = ['a', 'b', ',', '"', '""', '\r', '\n', '\r\n', ' ', '﻿', 'é', '\t', '\\', '/', ' ', '😀', '\uD800'];

function oddString(s) {
  let r = '"';
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (code > 0xffff) {
      r += rand() < 0.5 ? ch : JSON.stringify(ch).slice(1, -1);
      continue;
    }
    if (rand() < 0.3) r += '\\u' + code.toString(16).padStart(4, '0')[rand() < 0.5 ? 'toUpperCase' : 'toLowerCase']();
    else r += JSON.stringify(ch).slice(1, -1);
  }
  return r + '"';
}

for (let b = 0; b < batches; b++) {
  const cases = [];
  for (let k = 0; k < 50; k++) {
    let text = rand() < 0.1 ? '﻿' : '';
    const len = Math.floor(rand() * 40);
    for (let i = 0; i < len; i++) text += alphabet[Math.floor(rand() * alphabet.length)];
    cases.push({ id: `f-${k}`, input: { text, header: rand() < 0.5 } });
  }
  compare(`batch ${b} plain`, cases, Buffer.from(JSON.stringify(cases)));
  const odd = '[ ' + cases.map((c) => (rand() < 0.5
    ? `{"input" : { "header" : ${c.input.header}, "text":${oddString(c.input.text)} } , "id":"${c.id}"}`
    : `{"id":"${c.id}","input":{"text":${oddString(c.input.text)},"header":${c.input.header},"x":[1,{"y":"]"}]}}`)).join(' ,\n') + ' ]';
  compare(`batch ${b} odd`, cases, Buffer.from(odd));
}
console.log(bad ? `FAILED: ${bad} problems` : `all good [${useWasm ? 'wasm' : 'js'}] (practice + ${batches * 50} fuzz cases, two encodings each)`);
process.exit(bad ? 1 : 0);
