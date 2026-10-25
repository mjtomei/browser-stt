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
