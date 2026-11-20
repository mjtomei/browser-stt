## Fluid Speech Mini browser integration — 2026-11-19

- 151 unit tests pass, including model selection, pinned assets, greedy TDT decisions, token/confidence alignment, filter shape validation and interrupted native retirement. Strict TypeScript check, full/CPU builds, source audit and package dry run pass.
- Real Chromium and desktop WebKit: complete PCM-to-text inference; the bundled speech check yields recognizable text and finite aligned confidence; paced recording yields multiple drafts and a final transcript; cancellation permits retry; 1/5/15-second silence stays blank; offline reopen reuses saved checks and weights.
- WebKit also exercises the native string-storage adapter with all 300,146,787 actual model bytes and an `application/octet-stream` loader response. The loader is imported through a JavaScript-typed Blob. This is synthetic host storage, not Even hardware.
- Six public clips (three LibriSpeech, three AMI) match the native Mini transcript after case/punctuation normalization. This checks the new browser feature/decoder path; it is not an additional independent benchmark. A 46.375-second concatenation crosses rolling windows and retains the final words (102 output words).
- Initial speech-check clip inference was about 2.3 seconds for 5.855 seconds of audio on this desktop. Paced release tails were about 2.6–3.3 seconds under a CPU-limited test scope. Do not treat these as iPhone latency, RAM, battery or outdoor-noise measurements.
- Reports: `test-results/fluid-mini-{chromium,webkit,webkit-native}.json`. Commands: `FLUID_MODEL_DIR=/path/to/fluid-speech-mini-onnx npm run test:mini`; add `-- --webkit --native` and `WEBKIT_PATH` for the native-cache/MIME case. Optional `FLUID_INPUTS` supplies public native-parity fixtures. Weights and private recordings are not distributed.
- Attribution: Fluid Speech Mini by FluidVoice. Built on NVIDIA Parakeet TDT 0.6B v3 and Moondream Parakeet Ultra. CC BY 4.0; model weights unchanged, browser integration adapted.

# Validation record

Historical engineering evaluations, including their methods, numbers and limitations, are in README.md and the frozen summaries under benchmarks/. Prior private build/upload notes were replaced with portable reproduction instructions. No historical performance results were remeasured merely to prepare publication.

The source revision retains the production 0.1.17 recognizer configuration and model identities. Packaging now uses npm prepare to build workers from source for Git consumers. Publication checks are recorded below after execution. A browser test is not a physical-phone latency measurement.

## Publication preparation — 2026-10-24

- 136 unit tests passed; strict public API type check passed.
- Full and CPU-only worker builds passed. Actual Rollup module inventories
  contain no sharp/libvips native dependency. Third-party notices are emitted
  with the workers and consumer assets.
- Chromium and WebKit real-model smoke checks passed for Conformer, Zipformer
  and Moonshine, including finite word confidences and paced ensemble streaming.
  Local, hash-verified model fixtures were used; no physical phone was tested.
- Package contents and source privacy audit passed. Production `src/`, model
  manifests and public types match production 0.1.17. The bundled WASM/glue
  were subsequently rebuilt with compiler-path remapping; validation of that
  publication binary is recorded below.
- Model/weight identity and inference behavior were not changed for publication.

The first Chromium attempt overlapped an npm pack lifecycle rebuild and lost
a worker file while `dist/` was being replaced. The test passed after builds
finished. WebKit required the existing local OS-library launcher; the default
launch lacked host libraries. These harness/environment failures do not
represent model accuracy measurements. Historical benchmark scores were not rerun.

## Final publication binary — 2026-10-24

The Sherpa dependency was rebuilt from the same pinned source/toolchain and
recognizer configuration with local compiler paths mapped to `/src/browser-stt`.
The 71 changed printable strings are compiler paths; personal checkout paths
are absent. The source audit no longer exempts any runtime binary from this check.
WASM SHA-256: `b8b7a0c1b1bb4854a85c69f6ddcafdcd6138604c897d9f800f5d11e60337491a`.

After this rebuild, all 136 unit tests, strict public API types, full/CPU builds
and actual-model Chromium/WebKit smoke checks passed again. Both browser tests
prepared and transcribed with all three recognizers, streamed paced PCM through
the ensemble, and reloaded cached models with network access disabled. No
physical-phone measurement or historical accuracy benchmark was repeated.

The first GitHub Actions run passed installation, builds, units and types, then
flagged ONNX Runtime's public upstream Actions build path because it starts
with the CI runner's home directory. The audit now normalizes only that known
upstream build root before checking home paths. Private checkout paths and
credentials remain checked; no runtime binary is exempted.

## Spoken filenames — 2026-10-25

Version 0.1.18 adds an opt-in formatter plus ensemble alignment of equivalent spoken/literal filenames. All 144 unit tests and strict public API types passed, including `todo dot txt`, `agents dot md`, spelled letter names, ambiguous names, ordinary prose, joined punctuation, confidence preservation and UTF-16 offsets. Full/CPU worker builds and the source audit passed. Model manifests, runtime binaries and verification identities did not change.

Pageborne integration checks passed in Chromium and WebKit for both phone and glasses capture paths. Those checks use controlled recognizer responses and PCM to exercise actual streaming, voting, live drafts, final review, recent-chat context, typed edits and uncertainty rendering. They are not physical-device or acoustic accuracy tests.

The optional `npm run test:filenames` diagnostic used actual Conformer, Zipformer and Moonshine WASM models in Chromium on nine eSpeak NG en-us synthetic filename phrases plus a dot-product control. **Exact filename recall was 0/9 both without and with the new hints/formatting.** The synthetic voice was often decoded poorly (including “dot” as “not”); this diagnostic establishes no acoustic accuracy gain. The conservative formatter intentionally does not repair those lexical substitutions. The dot-product control was not rewritten. Human dictation on the phone/glasses remains unmeasured; the change addresses context coverage, spelling normalization and cross-model alignment, not every acoustic recognition error. Synthetic audio and generated reports remain untracked local fixtures; eSpeak is an external test prerequisite, not a shipped runtime dependency.

## Native cache quota recovery — 2026-11-05

Version 0.1.19 passes all 146 unit tests, strict API types, full and CPU worker builds, source privacy audit and package dry-run. New tests cover immediate cleanup after rejected writes, zero-headroom recovery, interrupted cleanup/retry, a committed file whose journal remains, preservation of unrelated data, and deferred cleanup after a native bridge timeout. No model weights, inference configuration or verification identities changed. These checks simulate storage failures; they do not establish a host quota or measure a physical phone. No acoustic benchmark was rerun.

## Fluid Speech comparison — 2026-11-19

User-requested actual-model evaluation against production revision
`381fa371d8c4c56a942f0625e78a9b654f04872c`. Aggregate results and the detailed
protocol are in [the evaluation JSON](benchmarks/fluidvoice-2026-11-19.json).
No runtime, dependency, model identity, cache identity or app deployment changed.

- Reused all 221 constituent LibriSpeech clips from the earlier 15-speaker
  study, plus 200 AMI turns sampled evenly across the four earlier benchmark
  meetings. WAV hashes match their frozen manifests. References were withheld
  from inference. Scores pool 6,362 words after English text normalization.
- Actual production Conformer/Zipformer/Moonshine ran in Chromium CPU/WASM.
  Fluid Mini's packed ONNX port and Pro's int8 ONNX port ran native CPU,
  greedy decoding, clean mode off, ONNX Runtime 1.31.0, one inference thread.
  All 31 nonempty model subsets used production voting without confidence
  calibration; uniform voting was also checked. This is exploratory selection
  on a historical development corpus, not an independent confirmation set.
- Combined WER without dictionary hints: Conformer 10.85%, Zipformer 37.39%,
  Moonshine 10.01%, current ensemble 8.60%, Mini 4.81%, Pro 4.75%, current
  ensemble + Mini 5.96%, current ensemble + Pro 5.77%, Mini + Pro 4.73%.
  Best exploratory raw-confidence combination: Moonshine + Mini + Pro 4.72%.
  Uniform voting's best combination, Mini + Pro, was 4.81%.
- Read-speech WER: current ensemble 4.28%, Mini 2.29%, Pro 2.15%.
  Conversation WER: current ensemble 17.74%, Mini 10.14%, Pro 10.24%.
  Giving existing models the earlier disjoint same-chapter hints improved the
  read-speech baseline to 4.05%; Fluid decoding had no acoustic hints.
  Speaker/meeting-cluster bootstrap intervals include zero for Mini versus
  Pro and for Mini + Pro versus either member. There are only four meetings.
- Both Fluid models returned empty text for 1/5/15-second silence controls and
  replayed all 67 private Ask recordings. Those recordings have no verified
  references; captured-text agreement is diagnostic, never a WER claim.
- Both Fluid ONNX variants loaded and decoded a 12.895-second clip in the
  existing desktop browser runtime, matching native text on all three repeats.
  Warm decoder timings were roughly 4.2 seconds Mini / 4.4 seconds Pro, with
  acoustic features precomputed. No physical phone or paced streaming was
  tested. Full native/browser timing tables are separate runtime categories.
- Measured model-download bytes: Mini 300,146,787; Pro 800,847,271. Native
  process peak RSS on the read-speech set was 498 MiB / 1,182 MiB. Long private
  recordings raised peaks to 552 MiB / 1,739 MiB. These are not iPhone memory
  measurements. Accuracy jobs ran independently on a shared ARM64 desktop.

All expected result IDs, unique clip/condition keys, word confidence bounds,
word offsets and browser/native smoke transcript parity were checked. An
instrumentation-only Pro apostrophe-spacing mismatch was repaired and the
stopped case resumed; no transcript was edited or case excluded. Private audio
and transcripts were not copied into the repository or uploaded externally.

## Inworld isolation pilot — 2026-11-19

The separate CPU reference evaluation of Inworld Voice Isolator v1 realtime (20 ms look-ahead) before Mini is recorded in `benchmarks/voice-isolation-2026-11-19.json`. Three human-transcribed utterances, five variants each (clean, wind/engine at +10 and 0 dB SNR), 230 scored words: raw Mini 0 errors, isolated Mini 1 error (shapely → shavely). No aggregate gain established; only 46 unique words and the baseline is already perfect. No change to production audio or inference. Reference implementation median isolation RTF 4.17; peak process RSS 2,047,967,232 bytes, CPU-only under a 180% quota. These figures include PyTorch and are not measurements of an optimized iPhone port. Real outdoor Ask audio still needs reference transcription for meaningful WER.
