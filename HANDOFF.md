## 2026-11-19 — Fluid Speech Mini browser runtime, 0.1.20

User selected Mini after the recorded 421-clip comparison. Mini is opt-in (`modelIds: ['fluid-mini']`) in the standalone API; Pageborne selects only Mini. Legacy default models, Tiny API and old verification identities are preserved. Mini has its own verification identity and pinned unchanged ONNX files. Runtime uses upstream mel filters and Parakeet preprocessing, bounded greedy TDT, word confidence, existing rolling windows, serial low-retention ONNX loading, and a JavaScript-typed local loader Blob for Even's .mjs MIME behavior. No Core ML bridge is present in the host; use ONNX/WASM. Upstream attribution/license are in README/NOTICE and shipped assets. Native cache deletion retains its descriptor until chunks are removed so app migration can resume.

Validation: 151 unit tests, strict API types, full/CPU builds, source audit and package dry run pass. Real desktop Chromium and WebKit pass actual PCM inference, paced streaming, cancellation/retry, silence and offline verified reload. WebKit additionally passes native string-cache storage and deliberately incorrect .mjs MIME. Six read/conversational clips match normalized native Mini transcripts; a 46.375-second concatenated public recording drains overlapping windows and retains final words. These are integration checks, not a new accuracy benchmark or physical iPhone performance measurement. `scripts/fluid-mini-browser-test.mjs` reproduces these; FLUID_MODEL_DIR points at the pinned model, optional FLUID_INPUTS is an array of public `{id,audio,nativeText}` cases under 15 seconds each. Reports stay under test-results.

User also asked about Inworld Voice Isolator for outdoor speech. Source review confirms traffic/wind/crowd training and a Python/PyTorch runtime; it is not enabled in Pageborne. Its listening/noise-removal benchmark does not establish Mini WER improvements. Need paired noisy/clean ASR evaluation before adding it; preserved Ask audio has no verified gold yet.

# Latest evaluation: Fluid Speech, 2026-11-19 — no production change

The requested comparison of Fluid Speech Mini and Pro is complete. See
`benchmarks/fluidvoice-2026-11-19.json` and VALIDATION.md. On 421 public clips
(6,362 normalized words), current three-model voting made 547 errors, Mini
306, Pro 302, and the best exploratory combination (Moonshine + Mini + Pro)
300. Mini is the next candidate for a physical-phone experiment; the small
differences among Fluid variants/ensembles are not established advantages.
Mini's measured ONNX download is 300 MB versus Pro's 801 MB. Neither is shipped.

Existing models used actual production Chromium/WASM; Fluid accuracy used
native CPU ONNX, with separate successful browser inference smoke probes.
No physical-phone or paced-streaming measurement was made. The 67 private Ask
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
