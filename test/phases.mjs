// Times the steps of the WebAssembly path in one fresh process: boot, loading the modules,
// reading and answering every case (answersFromFile), and writing the answers.
// Usage: node [v8 flags] test/phases.mjs <cases.json> <out dir>
const t0 = process.cpuUsage();
const ms = (t) => (t.user + t.system) / 1000;
const marks = [['boot', t0]];
const mark = (name) => marks.push([name, process.cpuUsage()]);
const [casesPath, outDir] = process.argv.slice(2);
const { writeAnswers } = await import('../wasmcsv.js');
mark('import');
if (writeAnswers(casesPath, `${outDir}/answers.json`) !== null) throw new Error('fell back');
mark('answer+write');
let line = '';
for (let i = 0; i < marks.length; i++) {
  const d = i === 0 ? ms(marks[0][1]) : ms(marks[i][1]) - ms(marks[i - 1][1]);
  line += `${marks[i][0]} ${d.toFixed(0)}  `;
}
console.log(`${line}total ${ms(process.cpuUsage()).toFixed(0)}`);
