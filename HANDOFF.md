# Current work: Mini acceleration and overlap batching, 0.1.23

Pageborne173's physical Even log confirms one WASM thread: no cross-origin isolation/shared memory. CPU4 desktop gains were not active there. No concurrent decode backlog: growing windows repeatedly process the same PCM. batchOverlaps opts into waiting for a full overlapping window or natural pause; finish/cancel preserve PCM semantics. It helps long inputs but not the supplied4/9second short inputs by itself. Six-second windows were tested and rejected (44/89 errors vs1/89); retain15/7.5second context. Four-thread desktop37s comparison reduced decode work42.41→31.88s and release6.91→2.06s with identical transcript. Timing simulation using phone decode costs is not physical-device proof.

miniAcceleration:auto keeps multi-thread CPU if available, otherwise tries WebGPU for frontend/encoder, CPU decoder/joint. The optional graph keeps packed external weights and rewrites264float-zero-point MatMulNBits ops with linear corrections; reproduce via scripts/prepare-fluid-webgpu.py, hash pinned in script/verification identity. Default remains CPU; legacy models preserved. Worker bundles disable document-based Vite preload: its document-is-not-defined error was the previous GPU fallback's root cause. GPU checks always run/warm on load, even cached. Fresh-worker fallback replays the same Blob once after GPU inference failure; cancellation never retries. Failed GPU stays disabled for that instance. Ready records actual backend/threads/adapter and failure reason. CPU receipt identity remains unchanged; GPU has a separate graph signature.

161unit tests and types pass; full/CPU builds pass. Real production GPU worker passes six native transcript comparisons, paced/34.8second streams, cancellation/retry, silence and cached reload on Linux NVIDIA and physical Apple M2/Chrome157. M2 12.895s clip1.887s, first stream word645ms and release1159ms on the5.855s clip. These are desktop integration measurements, not iPhone/battery proof. Actual native-cache/WebKit auto fallback passes all functional checks and six transcript comparisons; offline reload reuses the saved CPU check. Source audit (216 files), package dry run and packaged GPU/CPU separation checks pass. Private work .state/mini-device-2026-11-23 in the parent workspace. Mac accessible via Tailscale SSH22 (mac alias defaults to external9002, which fails). Owned headless Chrome profile/tunnel stopped after test. Capture helper runs but Mirroring has no visible debugging window; no phone interactions performed. Do not restart desktop bridge or unrelated services.

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
