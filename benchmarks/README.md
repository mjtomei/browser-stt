# Speech-engine evaluations

The [main report](../README.md#engineering-and-evaluations) distinguishes browser
inference, native comparison experiments and physical-device observations.
Recorded summaries are historical evidence, not newly measured release results.

**Current recommendation: Fluid Speech Mini alone.** On 421 public clips and
6,362 reference words without hints, Mini made 306 errors (4.81% WER), versus
547 (8.60%) for the original three-model ensemble: 44.1% fewer errors. Combining
that ensemble with Mini made 379 errors (5.96%). Existing models ran in
Chromium/WASM; Fluid accuracy used native CPU ONNX. Later browser integration
checks are separate from that accuracy corpus. These are not physical-phone
or outdoor-glasses results. See the [comparison](fluidvoice-2026-11-19.json)
and [current integration validation](../VALIDATION.md#fluid-speech-mini-browser-integration--2026-11-19).

- `mini-cpu-threads-2026-11-23.json`: one-versus-four-thread desktop Mini throughput probe; not phone or battery evidence.
- `dictation-2026-10-19.json`: first-word latency and bounded vocabulary weighting.
- `punctuation-2026-10-20.json`: rejected standalone punctuation model trial.
- `fluidvoice-2026-11-19.json`: actual Fluid Speech Mini/Pro versus production
  models, standalone and ensembles; native/browser boundaries and unlabelled
  private-recording limitations are explicit. This frozen report predates
  deployment; Mini was subsequently integrated in 0.1.20 and selected by Pageborne.
- `ensemble-*.json`: model selection, provenance, lexical alignment and streaming studies.
- `window-study*.json`: fixed input manifests and window-size studies.
- `baselines/`: exact earlier implementation files used by comparative harnesses.

See [reproduction instructions](../docs/REPRODUCING.md) for prerequisites and commands.
LibriSpeech excerpts retain CC BY 4.0 attribution in `vendor/stt/librispeech-LICENSE.txt`.
Nine bundled clips plus synthetic noise are diagnostic smoke tests, not a broad
accuracy benchmark. Do not give scoring references to recognizers as hints.

Unrelated audio/LLM correction research and HyPoradise evaluation tooling are on
`research/audio-llm-evaluations`, outside the production snapshot.

## Inworld isolation pilot — 2026-11-19

[Recorded pilot](voice-isolation-2026-11-19.json) compares Mini alone with Inworld Voice Isolator's streaming model before Mini. Three distinct LibriSpeech speakers (46 unique reference words) each have clean, recorded-wind and engine-noise variants at +10/0 dB SNR: 15 variants and 230 scored words per pipeline. Mini makes 0 errors; isolation introduces 1. This has a ceiling effect and cannot establish improvement on difficult outdoor dictation. Noise is mixed into speech, not captured on glasses; there is no wind-on-microphone/clipping or competing-voice test. Isolation's CPU reference took a median 4.17 times the audio duration and peaked near 1.91 GiB RSS under a 180% CPU quota. No phone/WebView timing claim. Isolation remains disabled in Pageborne. The JSON retains conditions, pinned model, sources and all public-case outputs; audio is not redistributed.
