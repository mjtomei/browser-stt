## 2026-11-23 — Mini CPU threads, 0.1.22

User chose to keep CPU execution after comparing a four-thread CPU probe with a GPU experiment. Mini now uses up to four WASM threads only when cross-origin isolation and SharedArrayBuffer are available, bounded by reported cores; otherwise it retains one thread. SIMD was already enabled. Model readiness, transcription and single-model stream results report the runtime's actual thread count. Mini verification identity advances to fluid-mini-2 and includes the thread configuration; cached weight files and legacy model verification remain unchanged. Weights, graph options, decoding and rolling windows are unchanged. No GPU model adaptation or accelerator path is included.

154 unit tests, strict types, full/CPU builds and source/package audits pass. The actual four-thread Chromium worker passes six public native-transcript comparisons, paced streaming, a 34.832-second overlapping stream, cancellation/retry, silence and offline verified reload. The browser harness now supports FLUID_ISOLATED=1 and asserts both the document's isolation and the actual worker count. Desktop WebKit also passes both the one-thread fallback and isolated four-thread path, including actual inference, streaming, cancellation/retry, silence and offline verified reload through the native string-cache/wrong-MIME fixtures. Prototype warm timing on one 12.895-second LibriSpeech clip is about 12.50s with one thread vs 4.18s with four (identical transcript, precomputed mel features). This is throughput evidence, not a physical iPhone, first-word, release-delay or battery claim. The Mac/iPhone was unavailable for physical validation. App prewarming already exists and remains enabled; Pageborne supplies isolation headers on its private web server, while Even controls its own host headers.

## 2026-11-20 — Earlier Mini partial words, 0.1.21

User requested less delay before words appear on the glasses. Mini now publishes partial text when 150 ms has elapsed, checking each new text token rather than every sixteen decoder decisions. The first completed word is eligible immediately; trailing token fragments are withheld until a word boundary or the final result. Cancellation yields, greedy decisions, confidence calculation, weights, inference options and saved verification identity are unchanged. A graph-optimization trial was reverted; the memory-conscious session options remain intact. App preloading/display scheduling changes live in Pageborne.

152 unit tests, strict types, full/CPU builds and source audit pass. Actual Mini inference, paced streaming, cancellation/retry, silence and offline reload pass in desktop Chromium and WebKit; WebKit includes native string-cache fixtures and incorrect module MIME. The six-second check clip now emits completed-word prefixes about 200 ms before its final result, while the earlier browser run's only nonempty prefix arrived at completion. End-to-end streaming times vary; this is not an iPhone or BLE latency measurement. No new accuracy claim. See VALIDATION.md; the browser test records partial timings and supports FLUID_REPORT for comparison artifacts.

Six fixed public read/conversational clips also match normalized native Mini output in Chromium. A 34.832-second concatenation drains across overlapping windows and retains its final words. Package dry-run and whitespace checks pass. Saved verification remains valid because only partial publication timing/text changes; the final inference implementation/configuration is unchanged.

## 2026-11-19 — Recommend Mini and explain retained library value

README now leads with the recorded 421-clip result: Mini alone 4.81% WER / 306 errors versus the original ensemble's 8.60% / 547, a 44.1% relative error reduction. Adding the original models to Mini gives 5.96% / 379. Main quickstart selects Mini explicitly; default constructor behavior remains unchanged for compatibility. Browser integration, streaming, confidence, filename formatting, cache recovery and evaluation remain useful; legacy acoustic bias/voting are not part of Mini's recommended configuration. Historical sections and the benchmark index distinguish the original comparison from later integration. Native-versus-browser, held-out-corpus and physical-phone limitations remain explicit.

Documentation-only checks passed: all 27 local links/anchors in the five edited documents, headline figures against the frozen report, source audit (208 files) and diff whitespace. No inference, model/verification identity, runtime defaults, weights or version changed; no benchmark rerun was needed.

## 2026-11-19 — Fluid Speech Mini browser runtime, 0.1.20

User selected Mini after the recorded 421-clip comparison. Mini is opt-in (`modelIds: ['fluid-mini']`) in the standalone API; Pageborne selects only Mini. Legacy default models, Tiny API and old verification identities are preserved. Mini has its own verification identity and pinned unchanged ONNX files. Runtime uses upstream mel filters and Parakeet preprocessing, bounded greedy TDT, word confidence, existing rolling windows, serial low-retention ONNX loading, and a JavaScript-typed local loader Blob for Even's .mjs MIME behavior. No Core ML bridge is present in the host; use ONNX/WASM. Upstream attribution/license are in README/NOTICE and shipped assets. Native cache deletion retains its descriptor until chunks are removed so app migration can resume.

Validation: 151 unit tests, strict API types, full/CPU builds, source audit and package dry run pass. Real desktop Chromium and WebKit pass actual PCM inference, paced streaming, cancellation/retry, silence and offline verified reload. WebKit additionally passes native string-cache storage and deliberately incorrect .mjs MIME. Six read/conversational clips match normalized native Mini transcripts; a 46.375-second concatenated public recording drains overlapping windows and retains final words. These are integration checks, not a new accuracy benchmark or physical iPhone performance measurement. `scripts/fluid-mini-browser-test.mjs` reproduces these; FLUID_MODEL_DIR points at the pinned model, optional FLUID_INPUTS is an array of public `{id,audio,nativeText}` cases under 15 seconds each. Reports stay under test-results.

User also asked about Inworld Voice Isolator for outdoor speech. Source review confirms traffic/wind/crowd training and a Python/PyTorch runtime; it is not enabled in Pageborne. Its listening/noise-removal benchmark does not establish Mini WER improvements. A 15-variant / three-utterance controlled pilot is now in benchmarks/voice-isolation-2026-11-19.json: Mini 0 errors, isolation+Mini 1 error over 230 scored words. Ceiling effect; no demonstrated gain and no physical outdoor evidence. Isolation remains off. Preserved Ask audio has no verified gold yet.

# Historical evaluation: Fluid Speech, 2026-11-19 — before integration

The requested comparison of Fluid Speech Mini and Pro is complete. See
`benchmarks/fluidvoice-2026-11-19.json` and VALIDATION.md. On 421 public clips
(6,362 normalized words), current three-model voting made 547 errors, Mini
306, Pro 302, and the best exploratory combination (Moonshine + Mini + Pro)
300. At evaluation time Mini was the next candidate for integration; the small
differences among Fluid variants/ensembles are not established advantages.
Mini's measured ONNX download is 300 MB versus Pro's 801 MB. The subsequent
Mini browser integration is recorded above; Pro remains an evaluation candidate.

Existing models used actual production Chromium/WASM; Fluid accuracy used
native CPU ONNX, with separate successful browser inference smoke probes.
No physical-phone or paced-streaming measurement was made in that comparison.
Subsequent browser streaming checks are recorded above. The 67 private Ask
recordings also replayed locally, but have no verified reference transcripts;
do not treat agreement with their captured text as accuracy. Private artifacts
and evaluation harnesses remain outside this publication repository. The JSON
contains aggregate results, source/model revisions and protocol limitations.

# Current work: native cache recovery, 0.1.19

Native cache recover(key) clears only journaled uncommitted chunks, including after quota errors. Committed weights are preserved when the journal points at the live manifest. Recovery is resumable and does not require nonempty writes. Rejected put attempts cleanup; bridge-timeout leaves recovery for reopening to avoid queuing behind an uncancellable native call. Model/runtime/verification identities are unchanged. 146 unit tests, strict API types, full/CPU builds, source audit and package dry-run passed. No inference benchmark or physical phone measurement; Pageborne exercises the adapter through a mocked-quota browser integration.

# Current work: spoken filenames, 0.1.18

Optional filename context/formatting is shared with Pageborne. It normalizes explicit spoken dots and suffix letter names, restores unique context spellings, and runs before ensemble alignment. Joined internal punctuation is preserved even without the opt-in formatter. Weights, WASM and verification/cache keys are unchanged. `scripts/filename-browser-test.mjs` is a synthetic eSpeak diagnostic, not an accuracy benchmark; its poor acoustic results did not establish a recognition gain. See VALIDATION.md for measured checks and limitations.

# Browser STT release handoff

The production ensemble and version 0.1.17 source are published as a standalone repository. Pageborne imports this source through a pinned Git dependency; npm prepare builds full/CPU workers. The engineering report moved from Pageborne into README.md, with recorded data under benchmarks/. Runtime/model/cache identities are unchanged.

In the original development repository, the separate audio/LLM research has been saved on research/audio-llm-evaluations, including its previously uncommitted experiments and reports. It is excluded from this publication snapshot. Preserve that branch; do not resume those experiments without a user request. The rejected punctuation trial remains historical evidence, not part of inference.

README.md is the product and evaluation entry point. docs/API.md documents both ensemble and legacy APIs. docs/REPRODUCING.md covers build prerequisites and benchmark commands. VALIDATION.md records the publication checks and the limits of historical results. The public repository starts with a separate source snapshot, without the private development history. The bundled Sherpa runtime was rebuilt with compiler-path remapping and checked with actual models in Chromium and WebKit; recognizer configuration and model/cache identity remain unchanged.
