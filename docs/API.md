# Browser STT API and integration notes

EnsembleSpeech/EnsembleStream are the Pageborne production integration. ResidentSpeech retains the earlier Tiny/optional-Small API for other consumers; its defaults are not changed by this release.

## Audio and streaming

`transcribe` takes mono 16 kHz PCM16 WAV, from 0.1 to 60 seconds. Use `normalizeRecording` for browser-decodable formats, `samplesWave` for Float32 samples, or `pcmWave` for PCM16 byte chunks. `BrowserMicrophone` captures and resamples via AudioWorklet. `PcmMicrophone(control, onLimit, onChunk)` accepts host-provided incremental PCM without a browser microphone permission prompt.

`SpeechStream` accepts PCM chunks via `receive()` and delivers provisional replacement text (not deltas). It starts after 500 ms of new audio plus a 100 ms coalescing delay. Only one inference runs at once; decoder word updates remain available through `onPartial`. Full passes can revise provisional words. It commits completed phrases at quiet pauses (400 ms, conservative relative energy floor) and bounds uninterrupted recognition windows to 15 seconds. This is repeated growing-window inference, not an incremental acoustic decoder.

For long local dictation, call `microphone.start({ retainAudio: false })`, feed every `onChunk` to `stream.receive`, then `await stream.finish(await microphone.stop())`. Stop flushes final AudioWorklet PCM before returning a `{ kind: 'pcm-stream', bytes, seconds, checksum }` receipt. Finish verifies that every byte reached this stream, including the final flush, and drains pending inference. The checksum is a consistency check, not cryptographic authentication. No full-recording WAV is retained and there is no total-duration cap. Default microphone capture still retains a WAV and stops at 60 seconds for existing one-shot consumers; `finish` accepts that WAV too.

Audio storage rolls only after the current phrase/window has received a complete recognition pass. Absolute audio positions, transcript prefixes and word-confidence character offsets survive compaction. The initial storage is 30 seconds of PCM (960,000 bytes), with a hard 120-second pending-audio bound. An optional `backlog` callback fires once when recognition falls 60 seconds behind; Pageborne stops capture and drains for review. An overrun is an explicit error, never silent truncation. This protects slow/model-loading cases without limiting ordinary recording duration.

Set `overlapSeconds: 7.5` to retain half of a forced 15-second window (the package default remains 0 for existing consumers). Pageborne enables this. Clean phrase pauses need no overlap. Only neighbouring acoustic windows are candidates for matching: unique three-word anchors align the old suffix with the new prefix. A clipped/misrecognised opening in the newer pass can be discarded before a later strong anchor. Confidence helps choose anchored disagreements, with a conservative preference for the older reading and reduced weight for its last two cut-edge words when the newer pass has following context. Scores are not calibrated correctness probabilities. Unmatched old words are retained; ambiguous/repeated or missing anchors trigger a new-audio-only fallback before any samples are discarded. This extra inference can increase work and is not a guarantee of improved accuracy on every recording.

Release reuses completed/in-flight results, preserving committed phrases; only unfinished audio needs processing. A short question with a new tail can still require another pass over its current window. Show the draft for immediate review while finishing and cancel the stream on edit/send/cancel. `SpeechRefinement` remains a separate optional layer; Pageborne uses the three-model ensemble described below.

Unreleased experiment controls: `SpeechStream({ windowSeconds: 30, overlapSeconds: 15, commitOnPause: false, ... })` retains acoustic context across pauses. `windowSeconds` accepts 2–60 seconds (default 15); overlap is capped at half the chosen window. `commitOnPause` defaults to true. The stream also passes its window size to Tiny's decoder as `chunkSeconds`, avoiding an additional hidden 15-second split. Direct `LocalSpeech`/`ResidentSpeech` calls accept `chunkSeconds` (default 15); non-default values are Tiny-only. Final worker results expose `segments` with actual duration, non-special token count and token allowance. Defaults and Pageborne's installed package are unchanged. **60 seconds is not recommended:** real-model tests produced repetition and long delays. See the [15/30/60-second comparison](window-study.md) before changing these settings.

## Streaming comparison

`runStreamingSpeechBenchmark({ samples, models, signal, progress, update })` compares resident Tiny CPU and Small GPU using recorded audio paced at capture speed. Each sample supplies `{ id, label, reference, audio: async signal => wavBlob, noisy? }`. Preparation and warm-up are separate from timed runs. `summarizeStreamingSpeech(report.runs)` reports first-word delay, release tail, transcript updates/revisions, accuracy, and audio processing backlog. Reports retain the complete update/backlog timeline and text visible at release. Audio backlog measures completed decode coverage, not exact per-word lag. Delayed feeds are excluded from timing summaries. Cancelling keeps shared model preparation alive; applications may continue Tiny dictation while Small downloads. Keep the page foregrounded when measuring, and label any CPU override or desktop run explicitly.

## Word confidence contract

Each aligned word includes UTF-16 `start`/`end`, `text`, contributing token IDs/probabilities, and `scores.minimum`, `scores.mean`, `scores.geometricMean`. Punctuation-only tokens do not lower neighboring words. Token probabilities are captured before optional vocabulary bias.

`confidence` is the selected aggregate. `confident` and named `flags` are **true at or above** their configured thresholds and false below. Missing/invalid evidence produces `null`, never a fabricated confidence. If incremental tokenizer decoding cannot align with final text, `words` is empty; the transcript remains usable. Default: minimum token probability, threshold **0.9**; consumers may use a different policy. These are display/decision hints, **not calibrated word-correctness probabilities**. `classifyWords` reapplies a policy to saved scores; no inference required.

TypeScript declarations cover the public root API. Lower-level module subpaths remain available for integration and testing.

## Validation and research

`npm run test:browser` exercises actual Tiny inference, confidence controls, WAV export and AudioWorklet capture in Chromium. Add `-- --webkit` with `WEBKIT_PATH` for a locally installed WebKit runner. These are desktop tests, not iPhone performance results.

Audio/LLM research is preserved separately on the local `research/audio-llm-evaluations` branch and is not part of the release. [Benchmark commands](../benchmarks/README.md) describe the retained speech-engine evaluations. Nine included LibriSpeech clips plus deterministic noise are smoke tests, not a published benchmark reproduction.

Third-party licenses are retained under `vendor/` and in built assets.

## Preparation memory and recovery (0.1.5)

The speech worker loads ONNX sessions serially and releases each source weight buffer after the runtime consumes it. Small skips optional startup graph rewrites/prepacking; recognition weights and precision are unchanged. Cache writes reuse a bounded staging buffer. This reduces measured desktop initialization memory but does not prove stability under iPhone WebView limits. Detailed measurements and caveats are in VALIDATION.md.

Consumers can supply `ResidentSpeech({ prepareModel })` to checkpoint optional GPU preparation. The async hook receives the entry and `{ model, retry, progress }`, and normally returns `entry.local.prepare(entry.backend, options)`. If it delays startup for persistent storage, check the captured `entry.generation` before starting the worker; a changed generation means it was closed. Pageborne uses this for an explicit-retry recovery path after interrupted preparation, independently of diagnostic logging.

## Three-model streaming (opt-in)

`EnsembleSpeech` and `EnsembleStream` run Conformer CTC Small, Zipformer 20M,
and Moonshine Base in three independent CPU/SIMD workers. The existing
`ResidentSpeech` API and Tiny/optional-Small baseline are unchanged. Pageborne selects the ensemble explicitly.

```js
import { EnsembleSpeech, EnsembleStream, EnsembleModelStore } from '@pageborne/browser-stt';
const models = new EnsembleSpeech({
  store: new EnsembleModelStore(), // IndexedDB in an ordinary browser
  changed: () => renderModelStatus(models.entries),
});
await models.open();
const stream = new EnsembleStream({ models, result: showTranscript, failure: showError });
stream.start(['Pageborne', 'Kantorowicz']);
// Feed each PCM16/16 kHz mono microphone chunk to stream.receive(bytes).
// After capture flushes, await stream.finish(theMicrophoneReceipt).
// stream.cancel() invalidates late output; models.close() releases the workers.
```

Use `speechAssets({ ensemble: true, refinement: false, benchmarks: false })`
in the consuming Vite build. This ships runtime code and licenses, **no model
weights**, including no Tiny weights. All weights/configuration files are pinned
by revision, size and SHA-256 in `vendor/stt/ensemble-models.json`. Initial network
transfer is 249,132,837 bytes; 12,590 bytes of derived BPE vocabulary are embedded.
The three models download and initialize serially to bound peak allocation, then
run concurrently and remain resident until exit. Ready models can produce drafts
while another is downloading or unavailable. A stream retains pending PCM with
the same backlog limit as `SpeechStream`; prepare voice before long dictation on
a first install. A failed model is identified in status and `unavailableModels`.

The Sherpa JavaScript runtime for Conformer/Zipformer is bundled into the worker
and loaded through a Blob explicitly typed as JavaScript. It does not depend on
the host serving a separate `.mjs` file with the correct MIME type. Its WASM
binary remains a local asset. Runtime setup errors identify the model; saved
weight checksums and cache keys are unchanged.

Moonshine setup reports encoder/decoder initialization separately from saved-file
reads, with filenames, bytes and timestamps in `entry.setup`. Its sessions load
serially and release their staging buffers; CPU arena allocation, prepacking and
graph rewrites are disabled to reduce preparation memory. This trades some speed
for a lower measured desktop peak; it does not establish an iPhone memory budget.
Failed preparation closes the worker before returning the original error and
leaves its recovery marker for explicit retry. Error names/stacks are preserved.

Each model contributes one confidence-weighted word vote. Rolling 15-second
windows with 7.5-second overlap preserve long dictation; there are no additional
shifted-window ensemble votes. Conformer uses a contextual CTC prefix beam,
Zipformer uses modified beam search with hotwords, and Moonshine uses token bias.
From 0.1.17, complete dictionary terms/phrases also receive a 25% vote bonus when
their measured acoustic score is at least 0.35. This only chooses among recognized
alternatives; it cannot invent a term or overturn a winning deletion. The bonus
does not enter reported confidence. Strong contradictory votes can still win.
Exposed per-model probabilities exclude vocabulary boosts. Merged confidence
combines acoustic confidence with the winning share of votes; it is an uncertainty
indicator, **not a calibrated probability of correctness**. `words[].sources`
retains the individual votes/scores. The previous native benchmark rankings do
not establish the accuracy of this browser decoder and stitching implementation.

`EnsembleStream` probes every 250 ms without the initial 100 ms coalescing delay
until each recognizer produces text, then uses the normal 500/100 ms cadence.
Override `firstAudioMs`/`firstIntervalMs` in `streamOptions` if needed. Generic
`SpeechStream` defaults remain 500/100 ms. Its optional `prepare({signal})` hook
waits before choosing the audio window, so a cold start includes audio accumulated
during model loading. Ensemble adapters should expose `models.prepare(id, options)`
to use this path. Cancellation stops the caller's wait without aborting shared
model preparation. Models still initialize serially, Moonshine first.

For a host with durable string storage, pass `new EnsembleModelStore({ kv })`,
where `kv.get(key)` and `kv.set(key, value)` are async. Pageborne passes Even's
SDK storage adapter. It uses checksum keys independent of app version/origin,
32,000-character chunks, streaming verification and atomic completion metadata.
Browser fallback uses chunked IndexedDB. An interrupted initialization is held
for explicit `models.open({ retry: true })`; other models remain usable. Browser
storage may be evicted, and uninstall/clearing app data removes saved weights.
Storage retention still depends on the host; see the device observations in the README.

In 0.1.10, `EnsembleEntry` exposes `downloadBytes`, `totalBytes`, and `setup`
(stage plus loaded/total bytes). Preparation now runs a bundled 5.855-second
LibriSpeech speech sample (CC BY 4.0) through each actual recognizer, requires recognizable
anchor words and finite word-confidence scores, and sets `ready.verified` only
on success. This is an operational smoke check, not an accuracy benchmark. A
silent clip would skip the inference path, so it is not used. The check WAV adds
about 187 KB to ensemble assets, with its LibriSpeech license. A stalled setup
worker times out after 120 seconds without progress. Native cache/hash work yields
to painting, hashes at most 64 KiB at once, and journals a known file extent once
instead of doubling every chunk write. Checksums and existing cache keys remain
unchanged.

From 0.1.16, pass a stable, device-local `verificationDevice` string to opt into
saved checks. `await models.restoreVerification()` returns whether all checks
are still valid, without allocating workers; `entry.verified` does not mean the
model is loaded. `prepare()`/`transcribe()` still initialize and checksum the
weights, but skip the check clip when a matching receipt exists. Results expose
`verification: 'saved' | 'tested'`. Receipts include the inference-runtime revision and model
checksums, are stored with the weights, and cannot bypass a pending preparation
marker or a missing file. Explicit retry reruns checks. The host should include
OS/runtime/hardware identity hints and keep storage local to the device; browser
APIs do not expose a physical phone serial number. Exclude app version, localhost
port and viewport from the device key so ordinary updates and rotation are stable.
Pageborne now opens its library with matching receipts and loads speech when
speaking; only initial/invalidated checks block startup.
Stream/vote-only 0.1.17 retains the 0.1.16 verification revision and its receipts;
advance `verificationRuntime` when changing the inference worker, dependencies,
runtime binaries, or verification exercise.

The bundled Sherpa runtime is reproducible with `scripts/build-ensemble-wasm.sh`.
It expects `.state/ensemble/sherpa-source` at commit
`11afbd009a7f8c08f4bcf2fc1b265d0df4670fbf` (v1.13.8), and Emscripten **4.0.23**
installed/activated in `.state/ensemble/emsdk` (SDK checkout used:
`8f685c26ee9f672081e61e22c6aa60fa972d00a9`). CMake downloads the upstream
checksum-pinned static dependencies. The checked-in runtime lets consumers
build without Emscripten. No Python inference service is needed.

`EnsembleSpeech` accepts an optional async `checkpoint` callback for host-owned setup diagnostics. Major Moonshine phase reports update `changed()` first, then await this callback before allocating a model file buffer or initializing an ONNX session. Keep it small and handle best-effort persistence failures in the callback. No transcript or audio is passed; model loading and the cached weights are otherwise unchanged.
