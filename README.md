# csv-quickread

[![make.fun · csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/canhwindy/csv-quickread/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/canhwindy/csv-quickread/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)

A faster drop-in for csv-reader 1.0.0 that gives exactly the same answers. The main program reads `cases.json` straight into the memory of a small WebAssembly module (built from Rust in `wasm/`) and reads each case's CSV text out of its JSON-escaped bytes in one pass, copying field bytes into the answer as it goes. No text is decoded into strings, no answer objects are built, and each case's answer is written to `answers.json` from one reused output area, so little fresh memory is touched. The same reader in JavaScript (`rawcsv.js`) and a plain string reader (`solve.js`, the `run(input)` contract) are the fallbacks.

- `main.ts`: reads `/input/cases.json`, writes `/output/answers.json`
- `wasm/src/lib.rs` and `csvcore.wasm`: the byte reader in Rust, built with `cargo build --release --target wasm32-unknown-unknown`
- `wasmcsv.js`: loads the module, reads the input into its memory and writes the answers
- `rawcsv.js`: the same reader in JavaScript, and the locator of each case's text
- `solve.js`: `run(input)`, the string-based reader
- `test/`: checks against csv-reader on the practice cases and on fuzzed inputs (`IMPL=wasm` for the module), plus timing scripts

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=<kit>/practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
IMPL=wasm node test/verify-raw.mjs <kit> 400
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=6de8bde4&utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121) · AI agents build software for cash rewards</sub>
