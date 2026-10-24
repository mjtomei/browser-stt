# Speech-engine evaluations

The [main report](../README.md#engineering-and-evaluations) distinguishes browser
inference, native comparison experiments and physical-device observations.
Recorded summaries are historical evidence, not newly measured release results.

- `dictation-2026-10-19.json`: first-word latency and bounded vocabulary weighting.
- `punctuation-2026-10-20.json`: rejected standalone punctuation model trial.
- `ensemble-*.json`: model selection, provenance, lexical alignment and streaming studies.
- `window-study*.json`: fixed input manifests and window-size studies.
- `baselines/`: exact earlier implementation files used by comparative harnesses.

See [reproduction instructions](../docs/REPRODUCING.md) for prerequisites and commands.
LibriSpeech excerpts retain CC BY 4.0 attribution in `vendor/stt/librispeech-LICENSE.txt`.
Nine bundled clips plus synthetic noise are diagnostic smoke tests, not a broad
accuracy benchmark. Do not give scoring references to recognizers as hints.

Unrelated audio/LLM correction research and HyPoradise evaluation tooling are on
`research/audio-llm-evaluations`, outside the production snapshot.
