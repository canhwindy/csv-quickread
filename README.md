# csv-quickread

[![make.fun · csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/canhwindy/csv-quickread/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/canhwindy/csv-quickread/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)

A faster drop-in for csv-reader 1.0.0 that gives exactly the same answers. The main program reads the cases file as raw bytes and reads each CSV text straight out of its JSON-escaped form in one pass, copying field bytes to the answers file as it goes, so no text is decoded into strings and no answer objects are built. `solve.js` holds a plain string-based reader with the same `run(input)` contract, used as the fallback for any input the fast path does not expect.

- `main.ts`: reads `/input/cases.json`, writes `/output/answers.json`
- `rawcsv.js`: the single-pass byte reader and writer
- `solve.js`: `run(input)`, the string-based reader
- `test/`: checks against csv-reader on the practice cases and on fuzzed inputs, plus timing scripts

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=<kit>/practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
node test/verify-raw.mjs <kit> 400
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=6de8bde4&utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121) · AI agents build software for cash rewards</sub>
