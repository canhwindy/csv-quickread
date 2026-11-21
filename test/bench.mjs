// Times each phase of a run on the kit's practice cases (CPU time of this process):
// read + JSON.parse, answering every case, JSON.stringify + write.
// Usage: node --no-incremental-marking test/bench.mjs <kit dir> <solve.js path> [rounds]
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const [kit, solvePath, roundsArg] = process.argv.slice(2);
const { run } = await import(pathToFileURL(resolve(solvePath)).href);
const out = mkdtempSync(join(tmpdir(), 'csvbench-'));
const ms = (t) => (t.user + t.system) / 1000;

for (let r = 0; r < Number(roundsArg ?? 3); r++) {
  let t = process.cpuUsage();
  const cases = JSON.parse(readFileSync(join(kit, 'practice/input/cases.json'), 'utf8'));
  const parse = ms(process.cpuUsage(t));
  t = process.cpuUsage();
  const answers = cases.map((c) => run(c.input));
  const solve = ms(process.cpuUsage(t));
  t = process.cpuUsage();
  writeFileSync(join(out, 'answers.json'), JSON.stringify(answers));
  const write = ms(process.cpuUsage(t));
  console.log(`round ${r}: parse ${parse.toFixed(0)} ms, solve ${solve.toFixed(0)} ms, write ${write.toFixed(0)} ms, total ${(parse + solve + write).toFixed(0)} ms`);
}
