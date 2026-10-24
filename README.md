# Browser STT

**Local speech recognition for browsers and embedded WebViews.** Browser STT combines Conformer CTC Small, Zipformer 20M and Moonshine Base into a streaming transcript with vocabulary hints, word confidence and persistent model caching. It is the speech engine used by [Pageborne](https://github.com/mjtomei/pageborne), and has no glasses SDK, chat provider or agent dependency.

Our contribution is the browser inference integration, streaming, hypothesis alignment, bounded vocabulary weighting, punctuation preservation and storage/memory work around pretrained models we did not train. Transcription stays on the device. A consuming app decides whether to send the resulting text elsewhere.

Version **0.1.17** retains the production recognizer configuration and model identities. The bundled WASM was rebuilt with compiler paths remapped to remove local checkout information. This publication preparation changes packaging, documentation and reproducibility, not decoding behavior. The engineering report and recorded evaluations formerly maintained in Pageborne now live in this README and [`benchmarks/`](benchmarks/).

## Install and build

Use Node **22.13+**, npm and Git:

```sh
git clone https://github.com/mjtomei/browser-stt.git
cd browser-stt
npm ci                 # prepare builds the browser workers from source
npm test
npm run test:types
```

No acoustic model weights are downloaded by package installation or the worker build. The default build produces full and CPU-only workers. The checked-in Sherpa WASM runtime is a compiled dependency with its C++ source/build recipe and licenses included; consumers do not need Emscripten. See [reproduction](docs/REPRODUCING.md) to rebuild it.

Consumers can install a specific source revision instead of copying release tarballs:

```sh
npm install 'git+https://github.com/mjtomei/browser-stt.git#COMMIT_SHA'
```

Replace `COMMIT_SHA` with the reviewed full commit ID and commit the consumer's lockfile. npm installs this repository's build dependencies and runs `prepare`, compiling workers before installing the dependency. Standard installs must allow lifecycle scripts; an install using `--ignore-scripts` needs an explicit build before consuming assets. Updating requires selecting a new revision, not silently following the latest branch. Pageborne uses this Git dependency flow.

## Use the ensemble

Configure Vite:

```js
import { defineConfig } from 'vite';
import { speechAssets } from '@pageborne/browser-stt/vite';

export default defineConfig({
  define: { __STT_CPU_ONLY__: 'true' },
  plugins: [speechAssets({ ensemble: true, refinement: false, benchmarks: false })],
});
```

Capture mono 16 kHz PCM, stream it to all three recognizers, and display replacement transcripts:

```js
import { EnsembleSpeech, EnsembleStream, BrowserMicrophone } from '@pageborne/browser-stt';

const models = new EnsembleSpeech();
const prepared = await models.open(); // downloads/checks missing models, then retains them
if (prepared.some(result => result.status === 'rejected')) {
  console.warn('Some models are unavailable; inspect models.entries.');
}
const stream = new EnsembleStream({
  models,
  result: result => { document.querySelector('textarea').value = result.text; },
  failure: error => console.error(error),
});
const mic = new BrowserMicrophone(() => {}, bytes => stream.receive(bytes));

// Call from a user gesture (HTTPS or localhost microphone permission required).
async function start() {
  stream.start(['Pageborne', 'Kantorowicz']);
  try { await mic.start({ retainAudio: false }); }
  catch (error) { stream.cancel(); throw error; }
}
async function stop() {
  const receipt = await mic.stop(); // flush the final PCM before finishing
  return stream.finish(receipt);
}
// On edit/cancel: stream.cancel(). On disposal: stop capture, then models.close().
```

The ensemble initially downloads about **249 MB**, checked against pinned revisions, lengths and SHA-256 hashes. All three models run on CPU/WASM SIMD in workers. Downloads/setup are serial; recognition can run independently. Models remain resident until the consumer closes them. Browser storage is origin-scoped and can be evicted; the native key/value adapter allows hosts such as Even to retain weights across changing installed-app origins.

The library exposes confidence evidence, not calibrated correctness probabilities. Read [API and integration notes](docs/API.md) for streaming/backlog behavior, storage adapters, verification receipts, cancellation, model hints, the Tiny/optional-Whisper API and asset hosting. The older `npm run dev` demo exercises Tiny and optional Whisper; it is not the three-model evaluation UI.

## Checks and recorded evidence

```sh
npm test
npm run test:types
npm run release:audit
npm run test:ensemble -- --remote  # optional actual models; downloads missing weights
```

The real-model check requires an installed Chromium or WebKit and exercises each recognizer plus streaming. Use `CHROME_PATH` or `WEBKIT_PATH` to select a browser. Without `--remote`, supply local weight fixtures beneath `.state/ensemble/models/`. [Reproduction notes](docs/REPRODUCING.md) distinguish browser inference, native experiments and consumer/device observations.

The following results are recorded evaluations, not newly measured performance from preparing this release. Audio/LLM correction research is preserved separately on `research/audio-llm-evaluations` in the original development repository; it is not in the production source snapshot. The unsuccessful punctuation-restoration trial below remains documented because it explains the choice to preserve Moonshine output.

## Engineering and evaluations

Browser STT’s production ensemble combines Conformer CTC Small, Zipformer 20M and Moonshine Base in browser workers with WASM inference. Microphone PCM arrives incrementally. Bounded windows and overlap reconciliation maintain a growing transcript, while cancellation, review and edits prevent late decoder output from replacing user changes. The final Ask question is submitted only by the user.

Consumers such as Pageborne rank document vocabulary near the reading position. Browser STT accepts those terms through different mechanisms: Conformer CTC beam vocabulary, Zipformer hotwords and Moonshine token bias. The ensemble aligns competing lexical hypotheses, chooses each word by measured acoustic confidence and vote, and keeps Moonshine's sentence punctuation when another recognizer wins the word (see Punctuation below). Complete dictionary words/phrases receive a **25% voting-weight bonus only at acoustic confidence ≥0.35**. Raw confidence is unchanged. An absent word or partial phrase gets no bonus, and strong conflicting evidence can still win.

Opening probes use **250 ms of new audio and no coalescing delay** until a recognizer has visible text; later updates use **500/100 ms**. Cold preparation finishes before the decoder takes its audio snapshot, so it sees current speech rather than decoding an obsolete opening window while the rest waits. These scheduling numbers are not end-to-end latency promises.

Models are hash-verified and stored through a consumer-supplied native storage adapter or browser cache. Verification receipts are keyed to inference/model identity and available device hints, not each app release, installed-app origin or localhost port. Workers load lazily and can be released to make room for PDF processing; the app does not reload every model for every audio chunk. Debug timing distinguishes audio delivery from first recognized text without logging spoken content.

On the glasses, provisional text appears as recognition proceeds, and the most recent low-confidence words are dimmed within the native display budget so the reader can see which words may still change. The user can edit the transcript or send it as the final question. Transcription never leaves the device; choosing Ask sends the reviewed text and document context to the selected provider.

## First-word timing: October 19

Actual production WASM inference received PCM in paced 50 ms chunks on one shared desktop. Three warm clips and one cold clip were compared once per browser/condition. Cold means saved files and checks, but unloaded workers. Timing begins at the synthetic recording start and excludes physical microphone, Bluetooth and glasses display delay. Early text can be revised.

| First visible text | Chromium before → after | Desktop WebKit before → after |
| --- | ---: | ---: |
| Warm check clip | 1,247 → 789 ms | 1,223 → 800 ms |
| Warm clip 6930-81414-0004 | 627 → 527 ms | 628 → 558 ms |
| Warm clip 260-123288-0008 | 628 → 788 ms | 1,198 → 798 ms |
| Cold check clip | 3,481 → 3,340 ms | 2,553 → 2,488 ms |

Final transcripts were unchanged. The first **correct** opening word improved in two warm clips and regressed by about 0.16–0.21 seconds in the third; faster provisional text is not always earlier correct text. Cold loading remains a substantial cost. Release/finalization delays varied. This small paired run does not establish a universal speedup or physical iPhone latency.

[Recorded timings and protocol](benchmarks/dictation-2026-10-19.json) include first-correct-word and release measurements, not just the favorable first-text results.

## Dictionary and ensemble voting: October 19

The term-rich test used short LibriSpeech clips (CC BY 4.0, sourced from public-domain audiobooks) from **15 speakers**, with **277 reference words and 37 hinted-word occurrences**. Hints came from disjoint excerpts in the same chapter. A clip of at most 12 seconds with many hint occurrences was selected per speaker. This is a deliberately term-rich diagnostic set, not a held-out biomedical or broad speech benchmark.

| Recognizer/condition | Correct hinted-word occurrences | Total word errors |
| --- | ---: | ---: |
| Conformer without hints | 30/37 | 14 |
| Conformer with hints | 31/37 | 13 |
| Zipformer without hints | 25/37 | 56 |
| Zipformer with hints | 30/37 | 48 |
| Moonshine without hints | 32/37 | 12 |
| Moonshine with hints | 32/37 | 12 |
| Ensemble without hints | 32/37 | 10 |
| Hinted ensemble, previous voting | 32/37 | 11 |
| Hinted ensemble, bounded dictionary bonus | 33/37 | 10 |

One changed lexical vote fixed “Fafnir's.” A separate initial 15-clip, 245-word, 17-term set had no changes from the bonus. Hints helped some recognizers on this sample and did not improve Moonshine; the ensemble is not guaranteed to beat every member on every input. Word error counts and dictionary recall measure different things.

The [machine-readable summary](benchmarks/dictation-2026-10-19.json) records conditions and punctuation regressions. The harness is [`scripts/ensemble-dictation-benchmark.mjs`](scripts/ensemble-dictation-benchmark.mjs). Recorded results used implementation revision `3dc65cdf56e598baf47a3bd555b04bb96a187003`; baseline source is retained under `benchmarks/baselines/`. Model/audio fixtures must be prepared separately; see [reproduction](docs/REPRODUCING.md).

## Punctuation: preservation versus prediction

Moonshine supplies sentence punctuation in this ensemble. The inspected Conformer/Zipformer token vocabularies do not supply comparable sentence punctuation. A lexical vote can choose a Conformer or Zipformer word and accidentally drop the punctuation attached to Moonshine's competing word.

We fixed two loss paths: anchored word substitutions now preserve qualifying Moonshine sentence marks, and overlapping windows can retain a later trailing mark on the same lexical word without changing its confidence. Later guards prevent borrowing interior abbreviation periods onto expanded words, avoiding results such as “saint. Clair.” This preserves detected punctuation; it does not infer a missing clause boundary from silence.

### Additional punctuation model: October 20, not shipped

We tried Edge-Punct-Casing through Sherpa CPU/WASM in a separate worker, with int8 and FP32 weights. Each browser/precision processed 89 inputs three times: 38 authored cases, 25 saved Moonshine transcripts, 25 saved ensemble transcripts, and one sanity example. References were withheld from inference. Six authored cases targeted independent clauses joined by “and,” with seven expected commas, plus four negative controls.

| Measurement | Chromium int8 | WebKit int8 | Chromium FP32 | WebKit FP32 |
| --- | ---: | ---: | ---: | ---: |
| Warm median inference | 28.4 ms | 28.0 ms | 17.5 ms | 17.0 ms |
| Warm p95 | 36.1 ms | 33.0 ms | 20.3 ms | 21.0 ms |
| Maximum WASM linear heap | 32 MiB | 32 MiB | 55.4 MiB | 55.4 MiB |
| Targeted before-“and” commas recovered | 6/7 | 6/7 | 5/7 | 5/7 |
| False before-“and” commas in controls | 0/4 | 0/4 | 0/4 | 0/4 |
| Saved Moonshine transcripts losing a terminal mark | 16/25 | 16/25 | 15/25 | 15/25 |

For 32 authored cases in supported categories, punctuation F1 against the chosen references was **0.642 int8 / 0.630 FP32**. Stylistic alternatives count as mismatches; these are diagnostic scores, not general accuracy estimates. All lexical sequences were preserved ignoring case, but sentence structure was sometimes damaged: “could a confounding variable? explain it?” and “First isolate, the cells then measure their activity.”

A conservative offline merge that only adds commas still incorrectly split “eighteen seventy three.” On 25 saved Moonshine transcripts it added five commas with int8 and four with FP32; that sample did not establish reliable recovery of spoken independent clauses. **We retained Moonshine and did not ship the extra model.**

Warm timing excludes the first call; no ASR ran concurrently. WASM heap is not total process memory. There were no physical-phone resource measurements. See the [recorded summary](benchmarks/punctuation-2026-10-20.json). Candidate model archive SHA-256: `9f5e5a72c7d2829635bd074fce92b6bbd5b78da8a52e7ad8ed1be933f366b99d`; Sherpa source revision: `11afbd009a7f8c08f4bcf2fc1b265d0df4670fbf`.

## Moonshine loading and device observations

Repeated iPhone interruptions occurred while loading Moonshine's large encoder from saved native storage. The working change transferred verified native-cache bytes directly into a worker-owned preallocated buffer, avoiding the previous Response/stream staging path. Model weights, precision and decoding behavior did not change. The test phone was useful for validating the result, but the exact original WebView termination cause was not proven.

The physical iPhone 14 Pro passed five uninstrumented starts across Pageborne 0.8.74–0.8.75, including a full Even force-quit/relaunch. The user subsequently confirmed the 17 Pro Max worked. Those are startup observations, not controlled phone memory or latency measurements. Earlier desktop memory experiments addressed transient allocation and did not establish the physical crash cause.

Later actual-model Chromium/WebKit tests verified three checks on first preparation, zero repeated checks/downloads on a matching reopen, and real transcription afterward. Separate native-storage fixtures cover fresh localhost ports, changed device hints, interrupted setup, explicit retry and preserving reading/chat state. Device hints cannot perfectly distinguish backup transfers between identical hardware; missing or changed receipts require rechecking, and model bytes are still hash-verified when loaded.


[Third-party components and source availability](docs/THIRD-PARTY.md).
