# Current work: native cache recovery, 0.1.19

Native cache recover(key) clears only journaled uncommitted chunks, including after quota errors. Committed weights are preserved when the journal points at the live manifest. Recovery is resumable and does not require nonempty writes. Rejected put attempts cleanup; bridge-timeout leaves recovery for reopening to avoid queuing behind an uncancellable native call. Model/runtime/verification identities are unchanged. 146 unit tests, strict API types, full/CPU builds, source audit and package dry-run passed. No inference benchmark or physical phone measurement; Pageborne exercises the adapter through a mocked-quota browser integration.

# Current work: spoken filenames, 0.1.18

Optional filename context/formatting is shared with Pageborne. It normalizes explicit spoken dots and suffix letter names, restores unique context spellings, and runs before ensemble alignment. Joined internal punctuation is preserved even without the opt-in formatter. Weights, WASM and verification/cache keys are unchanged. `scripts/filename-browser-test.mjs` is a synthetic eSpeak diagnostic, not an accuracy benchmark; its poor acoustic results did not establish a recognition gain. See VALIDATION.md for measured checks and limitations.

# Browser STT release handoff

The production ensemble and version 0.1.17 source are published as a standalone repository. Pageborne imports this source through a pinned Git dependency; npm prepare builds full/CPU workers. The engineering report moved from Pageborne into README.md, with recorded data under benchmarks/. Runtime/model/cache identities are unchanged.

In the original development repository, the separate audio/LLM research has been saved on research/audio-llm-evaluations, including its previously uncommitted experiments and reports. It is excluded from this publication snapshot. Preserve that branch; do not resume those experiments without a user request. The rejected punctuation trial remains historical evidence, not part of inference.

README.md is the product and evaluation entry point. docs/API.md documents both ensemble and legacy APIs. docs/REPRODUCING.md covers build prerequisites and benchmark commands. VALIDATION.md records the publication checks and the limits of historical results. The public repository starts with a separate source snapshot, without the private development history. The bundled Sherpa runtime was rebuilt with compiler-path remapping and checked with actual models in Chromium and WebKit; recognizer configuration and model/cache identity remain unchanged.
