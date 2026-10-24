# Builds and reproduction

Use Node 22.13 or newer, npm, and Git. From a fresh clone, `npm ci` runs
`prepare`, which builds the JavaScript workers from this source twice: full
and CPU-only. It downloads npm dependencies, not acoustic model weights.

```sh
npm ci
npm test
npm run test:types
npm run release:audit
npm pack --dry-run
```

A Git dependency pinned to a full commit runs the same `prepare` step before
npm installs the package. Keep `src`, `dist`, `scripts/assets.mjs`,
`scripts/serial-speech-sessions.mjs`, `vendor` and `types` together. The demo and
benchmark harnesses are available in a source clone; they are not required by
an application importing the package. `speechAssets({ ensemble: true,
refinement: false, benchmarks: false })` emits the CPU workers/runtime and notices
without bundling model weights.

## Real-model browser smoke check

```sh
npx playwright install chromium webkit
export CHROME_PATH="$(node --input-type=module -e 'import { chromium } from "@playwright/test"; process.stdout.write(chromium.executablePath())')"
npm run test:ensemble -- --remote
npm run test:ensemble -- --remote --webkit
```

This downloads the exact ensemble files in `vendor/stt/ensemble-models.json`,
prepares all three real recognizers, checks text and finite word confidences,
and feeds a short recording at microphone pace through the ensemble. Outputs
go into ignored `test-results/`. It is a desktop browser smoke test, not an
iPhone latency or accuracy claim. WebKit may need system libraries installed
with Playwright's documented OS dependency setup.

Without `--remote`, the harness reads files from
`.state/ensemble/models/<model.directory>/<file.file>` using the same manifest.
Use only files matching its recorded lengths and SHA-256 hashes. Browser
downloads are hash-checked by the store before inference.

## Historical engineering evaluations

The README records the original environments, dates, outcomes and limitations.
To reconstruct the longer LibriSpeech passages, install Python 3 and FFmpeg,
then run `python3 scripts/prepare-expanded-window-study.py`. This uses the frozen
15-speaker manifest and verifies downloaded/converted audio checksums. Model
fixtures for the three production recognizers must also be populated as above.

```sh
node scripts/ensemble-dictation-benchmark.mjs --label=current --terms
node scripts/ensemble-dictation-benchmark.mjs --label=baseline --legacy-stream --terms
# Add --webkit for the second engine, or --vocabulary-only to omit timing.
```

The harness uses disjoint same-chapter hints recorded in `ensemble-inputs.json`.
References are used for fixture selection/scoring only. Baseline files under
`benchmarks/baselines/` are frozen copies, so the comparisons do not require
private Git history. Results describe the selected corpus and hardware, not
general clinical dictation accuracy. Broader native experiments in
`scripts/ensemble/` require their separately pinned models/Python runtimes;
they are not prerequisites for the browser engine.

The rejected punctuation trial can be reproduced after the WASM source setup
below with `bash scripts/build-punctuation-trial.sh` and
`node scripts/punctuation-browser-trial.mjs`. See that harness's `--webkit`
and `--fp32` options. Experimental weights/runtime stay under ignored `.state/`;
the production workers never load them.

## Rebuilding the bundled Sherpa dependency

Application installs build the workers; they do not rebuild this dependency.
The production binary was built with Emscripten 4.0.23, CMake, a C++ toolchain
and the pinned Sherpa source. On a machine with those build prerequisites:

```sh
mkdir -p .state/ensemble
git clone https://github.com/k2-fsa/sherpa-onnx.git .state/ensemble/sherpa-source
git -C .state/ensemble/sherpa-source checkout 11afbd009a7f8c08f4bcf2fc1b265d0df4670fbf
git clone https://github.com/emscripten-core/emsdk.git .state/ensemble/emsdk
.state/ensemble/emsdk/emsdk install 4.0.23
.state/ensemble/emsdk/emsdk activate 4.0.23
bash scripts/build-ensemble-wasm.sh
npm run build
```

The script copies the adapter into upstream and adds its CMake target. Upstream
CMake pins dependency archives and hashes. Preserve the runtime notices and
[Eigen source-availability information](../vendor/ensemble-runtime/SOURCES.md).
The script maps local compiler paths to `/src/browser-stt` before compilation.
Build environments can still produce different binaries; do not claim byte-for-byte
reproducibility without comparing output. Run actual-model
checks after changing the binary and update verification identity if required.
