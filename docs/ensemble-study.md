# Small-model ensemble and audio-window trial

Research only; production defaults and the Pageborne package are unchanged.

## Selected direction: three models, no window variants (2026-10-13)

User selected Conformer CTC Small + Zipformer 20M + Moonshine Base, one transcription stream/vote per independent model, excluding extra shifted/window-size variants for voting. Ordinary rolling capture remains necessary for long dictation. This selects the 168-error / 3.90% single-grid trio rather than the 155-error multi-grid candidate; it is a research decision, not a production integration. Current Pageborne remains Tiny-only.

Measured required model files from the tested adapters: **Conformer 46,431,465 bytes (46.43 MB), Zipformer 45,459,529 (45.46 MB), Moonshine Base 157,499,298 (157.50 MB); total 249,390,292 (249.39 MB)**. Includes tokenizer/vocabulary/config files; excludes unused alternate precision graphs, samples, inference runtimes and app code. Values are uncompressed disk assets, not RAM or final compressed package size. See `benchmarks/ensemble-selection.json` for the exact files. The already-uploaded 0.8.63 debug package is 82,316,590 bytes; no integrated-trio package was built/uploaded, and the current Hub size cap has not been verified. Public packaging documentation did not establish a numerical cap. Do not promise bundle acceptance or concurrent iPhone memory fit. Conformer/Zipformer adapters currently use native CPU; browser integration/confidence parity and all-three resident-phone tests remain required. A first-use download/cache can keep the Hub bundle small, but has not been implemented for this trio.

## Conformer vocabulary support: decoder limitation (2026-10-13)

The user considers document-specific word lists essential. The previous no-hint result describes our greedy CTC adapter, not a fundamental limitation of Conformer. The tested ONNX model already exposes frame/token log probabilities, so a contextual decoder can use those outputs without replacing or retraining the acoustic model.

- [pyctcdecode](https://github.com/kensho-technologies/pyctcdecode) explicitly demonstrates `stt_en_conformer_ctc_small`, the source checkpoint of our ONNX model. It supports BPE, hotword lists and weights, and decoding without an external language model. Its [decoder source](https://github.com/kensho-technologies/pyctcdecode/blob/main/pyctcdecode/decoder.py) applies hotword scoring when no language model is installed. This is a concrete reference decoder for a desktop comparison, not an already-integrated browser dependency.
- NVIDIA's [CTC-based Word Spotter](https://arxiv.org/abs/2406.07096) is another context-biasing approach using CTC probabilities, with a public NeMo implementation. Its acoustic checks are intended to limit false word insertions. It is a candidate to evaluate, not a measured winner for our corpus.
- [Sherpa-ONNX's documented hotword interface](https://k2-fsa.github.io/sherpa/onnx/hotwords/index.html) currently limits hotwords to transducer modified-beam decoding. Switching our Conformer adapter to that API alone would not enable hints.

Recommended next experiment: keep the acoustic weights fixed and compare greedy CTC, unbiased beam search, and hotword-biased decoding on document-specific names/technical terms plus distractor terms. Evaluate word-list recall, false insertions, overall WER and first-word/streaming latency. Keep raw acoustic confidence distinct from the contextual score for ensemble calibration/voting. The Python implementations require JS/WASM integration or a decoder port for Pageborne. No contextual Conformer decode, browser port, additional model download or new accuracy/latency result was produced for this research check; existing benchmark numbers remain unchanged.

<!-- RESULTS START -->
## Measured results (2026-10-13)

All **120 model/passage combinations and 780 supported window/hint configurations** completed. 8,008 successful recognizer calls include 1,170 new-audio seam fallbacks. Every row below uses the same 15 passages and 4,311 reference words. WER includes substitutions, deletions and insertions; lower is better.

| Model | 15 s, no hints | 15 s, hints | 30 s, hints | 60 s, hints |
| --- | ---: | ---: | ---: | ---: |
| Moonshine Tiny (current) | 8.61% | 8.72% | 8.54% | 113.50% |
| Moonshine Base | 7.63% | 7.70% | 8.63% | 66.06% |
| Whisper Tiny English | 10.32% | 40.25% | 49.43% | unsupported |
| Whisper Base English | 6.05% | 39.60% | 39.71% | unsupported |
| Conformer CTC Small | 5.68% | 5.68% | 5.92% | 5.98% |
| Zipformer 20M | 6.80% | 6.61% | 7.42% | 7.05% |
| Vosk Small English | 14.15% | 14.13% | 14.82% | 14.75% |
| Moonshine Tiny Streaming | 11.55% | 11.62% | 11.25% | 11.00% |

These are the unshifted grids. The full results also retain quarter-window shifts. Conformer and Vosk have no soft-hint path in these adapters, so their two 15-second columns are controls with identical settings. Vosk’s one-word difference is run variation, not evidence of hint support. A 60-second input to a streaming architecture can still be internally segmented.

The lowest observed cross-model ensemble is **raw-plain:conformer-small+zipformer-20m+moonshine-base+whisper-base.en**, 165 errors / **3.83%**. Its strongest individual member in the matching setup is conformer-small/15/0/plain, 245 errors / 5.68%. The best single-model configuration across all tested sizes/shifts is conformer-small/60/15/hints, 238 errors / 5.52%.

| Selected ensemble compared with | Fewer-error passages | Ties | More-error passages | Errors fixed | Errors introduced | Relative error reduction |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| moonshine-tiny/15/0/hints | 15 | 0 | 0 | 241 | 30 | 56.1% |
| conformer-small/15/0/plain | 14 | 0 | 1 | 113 | 33 | 32.7% |
| conformer-small/60/15/hints | 14 | 1 | 0 | 113 | 40 | 30.7% |

Confidence calibration holds out each speaker in turn. Selection of the best ensemble/window combination still uses this same small corpus: these are exploratory results, not an independently confirmed winner.

Selected confidence-weighted ensemble results:

| Combination | WER | Errors |
| --- | ---: | ---: |
| raw-plain:conformer-small+zipformer-20m+moonshine-base+whisper-base.en | 3.83% | 165 |
| calibrated:conformer-small+zipformer-20m | 4.71% | 203 |
| calibrated:moonshine-tiny:all-windows | 7.07% | 305 |
| calibrated:conformer-small:15+30 | 5.20% | 224 |
| calibrated:all-models+windows<=30 | 4.78% | 206 |
| calibrated:all-models+windows<=60 | 9.39% | 405 |

### More than three models

Scored every one of the 247 subsets of two through eight models, under both raw/calibrated confidence and hinted/unhinted controls. These use the same unshifted 15-second outputs; no new recognizer runs were required. The table selects the best condition and subset at each size, so it measures the best observed result rather than a controlled causal effect of adding one model.

| Models | Subsets tested | Best observed members | Confidence / hints | WER | Errors |
| ---: | ---: | --- | --- | ---: | ---: |
| 2 | 28 | Conformer CTC Small + Zipformer 20M | calibrated confidence, hints | 4.71% | 203 |
| 3 | 56 | Conformer CTC Small + Zipformer 20M + Moonshine Base | calibrated confidence, hints | 3.90% | 168 |
| 4 | 70 | Conformer CTC Small + Zipformer 20M + Moonshine Base + Whisper Base English | raw confidence, no hints | 3.83% | 165 |
| 5 | 56 | Moonshine Tiny (current) + Conformer CTC Small + Zipformer 20M + Whisper Tiny English + Whisper Base English | raw confidence, no hints | 3.97% | 171 |
| 6 | 28 | Conformer CTC Small + Zipformer 20M + Moonshine Tiny Streaming + Vosk Small English + Moonshine Base + Whisper Base English | calibrated confidence, no hints | 3.99% | 172 |
| 7 | 8 | Conformer CTC Small + Zipformer 20M + Moonshine Tiny Streaming + Whisper Tiny English + Vosk Small English + Moonshine Base + Whisper Base English | calibrated confidence, no hints | 4.15% | 179 |
| 8 | 1 | All eight | raw confidence, no hints | 4.27% | 184 |

All-eight controls:

| Confidence / hints | WER | Errors |
| --- | ---: | ---: |
| raw confidence, hints | 4.52% | 195 |
| calibrated confidence, hints | 4.45% | 192 |
| raw confidence, no hints | 4.27% | 184 |
| calibrated confidence, no hints | 4.29% | 185 |

### Original best trio with multiple windows

Fixed members: Conformer CTC Small + Zipformer 20M + Moonshine Base, selected in the original study. All rows here use vocabulary hints where supported and give each model the same total voting weight, divided equally among its window grids. Original grids start at zero; shifted grids start one quarter-window later. Both use half-window overlap. A grid produces one finalized transcript per model; it is not a single audio window. These are votes over complete saved transcripts, not simultaneous streaming-ensemble timing tests.

| Window grids per model | Hypotheses total | Raw-confidence WER | Calibrated WER | Calibrated errors |
| --- | ---: | ---: | ---: | ---: |
| 15-original | 3 | 3.99% | 3.90% | 168 |
| 15-shifted | 3 | 4.24% | 4.24% | 183 |
| 15-both-grids | 6 | 3.67% | 3.60% | 155 |
| 30-original | 3 | 4.43% | 4.34% | 187 |
| 30-shifted | 3 | 4.06% | 3.92% | 169 |
| 30-both-grids | 6 | 4.36% | 4.27% | 184 |
| 60-original | 3 | 5.01% | 4.89% | 211 |
| 60-shifted | 3 | 4.06% | 3.87% | 167 |
| 60-both-grids | 6 | 4.31% | 4.36% | 188 |
| 15+30 | 12 | 3.80% | 3.97% | 171 |
| 15+60 | 12 | 4.08% | 4.18% | 180 |
| 30+60 | 12 | 4.18% | 4.18% | 180 |
| all-windows | 18 | 4.15% | 4.06% | 175 |

The best observed trio/window result is **calibrated:top-three:15-both-grids**, 155 errors / **3.60%**, versus 168 / 3.90% for the original calibrated 15-second trio. It has fewer errors on 8 passages, ties on 4, and more errors on 3; it fixes 26 reference-aligned errors and introduces 13. Extra grids require extra decoding work; combined runtime, memory, power and streaming churn were not measured.

Expanded scoring contains 1,116 summaries and 16,740 passage/configuration results. Selection across this larger search further increases optimism; all results still need independent confirmation. [Cardinality and window comparisons](../benchmarks/ensemble-cardinality.json) retain every condition winner and paired comparison.

### Proposed display quorum (not yet measured)

The user asked whether displaying only majority-agreed words could reduce wrong intermediate text. Current voting selects the confidence-weighted winner; it does not require a strict majority of independent models. A possible live policy requires two of three models to agree before displaying each aligned word, uses confidence within disagreements, and counts multiple windows from the same model as one model. Buffer unresolved regions rather than silently deleting words or joining separated fragments. At release, resolve the remaining region with weighted voting and mark uncertainty; strict withholding without a fallback can omit correct names and other difficult words.

Agreement is not proof of correctness: models can share errors and revise a former majority. A small stability delay may help but adds latency. The saved paced traces do not contain per-update word confidences for every model, and the models were run independently rather than concurrently. No confidence-weighted live-quorum replay, phone latency measurement, or reduction in intermediate errors has been established in this follow-up. First-word latency, spoken-word lag, revisions, wrong-word exposure and missing words need a separate paced comparison before changing production display behavior.

An eight-word phrase repeated at least four times, with at least three more occurrences than the reference, is flagged as major repetition. Final repetition counts and individual-passage scores are retained in the result JSON; temporary streaming revisions are measured separately.

### Streaming responsiveness

Paced checks use one representative 97.9-second passage, warm models and real-time audio delivery. They are **desktop spot checks**, not 15-speaker latency distributions or iPhone measurements. The full accuracy sweep above uses native runtimes. Only the four Transformers.js models were also exercised in Chrome WASM. Concurrent ensemble latency was not measured.

| Model / window | Hints | Runtime | First visible word | After release | Final errors |
| --- | --- | --- | ---: | ---: | ---: |
| Moonshine Base / 15 | no | Chrome WASM | 1.29 s | 5.34 s | 10 |
| Moonshine Base / 15 | yes | Chrome WASM | 1.26 s | 4.58 s | 10 |
| Moonshine Base / 30 | yes | Chrome WASM | 1.26 s | 5.65 s | 8 |
| Moonshine Base / 60 | yes | Chrome WASM | 1.26 s | 44.99 s | 90 |
| Moonshine Tiny (current) / 15 | no | Chrome WASM | 2.69 s | 2.75 s | 9 |
| Moonshine Tiny (current) / 15 | yes | Chrome WASM | 2.69 s | 1.81 s | 9 |
| Moonshine Tiny (current) / 30 | yes | Chrome WASM | 3.29 s | 2.56 s | 7 |
| Moonshine Tiny (current) / 60 | yes | Chrome WASM | 3.40 s | 21.61 s | 237 |
| Whisper Base English / 15 | no | Chrome WASM | 2.56 s | 7.37 s | 8 |
| Whisper Base English / 15 | yes | Chrome WASM | 2.85 s | 15.85 s | 97 |
| Whisper Base English / 30 | yes | Chrome WASM | 2.84 s | 7.12 s | 21 |
| Whisper Tiny English / 15 | no | Chrome WASM | 1.48 s | 4.38 s | 6 |
| Whisper Tiny English / 15 | yes | Chrome WASM | 1.67 s | 3.89 s | 38 |
| Whisper Tiny English / 30 | yes | Chrome WASM | 1.64 s | 2.47 s | 33 |
| Moonshine Tiny Streaming / incremental | yes | native CPU | 1.20 s | 1.35 s | 17 |
| Vosk Small English / incremental | not supported | native CPU | 1.23 s | 0.03 s | 21 |
| Zipformer 20M / incremental | yes | native CPU | 1.71 s | 0.01 s | 7 |
| Conformer CTC Small / 15 | not supported | native CPU | 0.62 s | 0.49 s | 5 |
| Conformer CTC Small / 30 | not supported | native CPU | 0.62 s | 0.88 s | 4 |
| Conformer CTC Small / 60 | not supported | native CPU | 1.12 s | 1.41 s | 4 |

Maximum capture-delivery lateness was 139.0 ms. Decoder backlog, transcript revisions, recognized sentence-tail delays and missed anchors are retained in the streaming JSON. Incremental decoders' queue backlog is not equivalent to word-display latency. Tail checks use exact three-word anchors relative to source-clip endpoints, including silence; they are not forced-aligned word timestamps.

### Evidence and limitations

- [Accuracy metrics and per-passage scores](../benchmarks/ensemble-results.json), [stream timing/anchor data](../benchmarks/ensemble-streams.json), [completion and confidence audit](../benchmarks/ensemble-audit.json).
- Raw recognizer and ensemble transcripts are retained locally in `test-results/ensemble/`, `test-results/ensemble-merged/` and `test-results/ensemble-analysis.json`. Model/input hashes and pinned revisions are tracked separately.
- The Whisper adapter initially allowed prompt plus generation to exceed its 448-token context, causing an ONNX reshape failure. Generation is now bounded by remaining context; the failed attempt is retained and its missing window retried. Sixty-second Whisper decoding remains unsupported.
- Successful windows survive rescheduling. Checkpointed intermediate runs and interruption records are retained under `test-results/ensemble-attempts/repartition/`; no completed result was excluded because of poor accuracy.
- The exact 15-second native/WASM smoke transcripts match for Moonshine Tiny/Base but differ for Whisper Tiny/Base. Thus native WER rankings are not established browser WER rankings; full browser/phone accuracy still needs confirmation.
- Native runtimes, precision choices, vocabulary interfaces and internal segmentation differ. The new Moonshine runtime uses an isolated greedy-decoder telemetry patch; token probabilities are real, but the instrumentation adds work.
- CPU affinity differs between runs: hinted Chrome checks used cores 15–16, no-hint Chrome controls 5–6, and native paced checks 11–12. Frequencies and other workloads were uncontrolled; timings are descriptive, not an isolated hint-overhead or cross-runtime speed comparison.
- These public read-speech excerpts do not establish conversational dictation accuracy, phone memory/thermal cost, or the best independent-test ensemble. Pageborne and its installed STT package were not changed.

<!-- RESULTS END -->

## Fixed protocol

Eight recognizers: original Moonshine Tiny and Base, Whisper Tiny English and Base English, NVIDIA Conformer CTC Small, streaming Zipformer 20M, Vosk Small English, and Moonshine Tiny Streaming. These are different model families, not eight independent training datasets.

Reuse the fixed 15-speaker corpus from [the expanded window study](window-study-expanded.md): ten LibriSpeech test-clean and five test-other passages, 95.43–108.43 seconds each, 4,311 reference words total. Every candidate gets the same passages. This is read English, not spontaneous phone dictation. Reference text is kept out of model-facing inputs and voting.

For each model: 15-, 30-, and 60-second windows, half-window overlap, and a second grid offset by one quarter window. Prefixes retain the recording's beginning; the final full window ends at the recording's end. Whisper's acoustic limit is 30 seconds, so 60-second single-window decoding is explicitly unsupported. The two streaming architectures may segment internally; a 60-second input is not a claim of 60 seconds of uninterrupted attention context.

The fixed-window sweep decodes each full requested window and a final full window ending at release. Paced checks instead use the production growing-window scheduler and its potentially shorter trailing buffer, with pause-based commitment disabled to isolate window length. These are related experiments, not byte-identical application-session replays. The Transformers.js adapters allow eight generated tokens per audio second, capped at 480; Whisper additionally respects remaining text context.

Use the production overlap matcher, including its new-audio-only fallback if a seam is ambiguous. A matched seam resolves disagreements using word confidence. Compare whole finalized transcripts, not the average of individually scored windows. Capture raw window results so decoder errors can be distinguished from merging errors.

For vocabulary, use the existing Pageborne ranker on nearby same-chapter text, with **every scored sample excluded**, capped at 200 terms. This simulates document context without handing a recognizer its answer. Original Moonshine uses the app's soft logit bias; Whisper uses its bounded previous-text prompt; streaming Moonshine uses official keyterms; Zipformer uses official contextual hotwords. Conformer's chosen greedy CTC adapter lacks soft bias. Vosk's restricted grammar would constrain open dictation, so retain its shipped language model. Also run an unhinted 15-second baseline for every model.

Confidence sources differ: autoregressive token softmax before vocabulary bias; Zipformer token posteriors without contextual scores; Conformer peak-frame posterior per collapsed CTC token; Vosk word posteriors. Word confidence is the geometric mean where multiple tokens form a word. Streaming Moonshine's public alignment confidence was a placeholder, so an isolated research build captures real pre-bias greedy decoder probabilities instead. Do not treat these heterogeneous scores as calibrated probabilities of correctness.

Word-aligned ROVER-style ensembles sum confidence weights. Include every subset of two through eight models (247 subsets) on both the fixed 15-second hinted and unhinted baselines; also same-model ensembles across shifted grids/window sizes and balanced cross-model/window ensembles. Multiple windows from one model share that model's total weight. NULL/insertion votes use a fixed 0.5 proxy, not a fabricated measured confidence. Raw confidence is a control; a monotone decile calibration is fit on the other 14 speakers' 15-second baseline for each model/hint condition and evaluated on the held-out speaker. That mapping is reused at other window sizes, rather than fitting a separate calibration to long-window errors. References enter calibration/scoring only, never alignment, voting or hint generation. Searching many combinations is exploratory; the best combination needs independent confirmation.

## Execution and timing boundaries

The full accuracy sweep uses native CPU runtimes on the shared ARM64 workstation, one inference thread per model. It is not a phone or browser benchmark. Separate Chrome WASM checks and paced streams measure browser behavior; native streaming checks remain labeled native. Measure first visible word, changes in the provisional transcript, trailing audio backlog and release delay. Model loading is reported separately from warm streaming. Do not infer iPhone performance from the workstation.

Local raw outputs: `test-results/ensemble/`; model-facing inputs: `benchmarks/ensemble-inputs.json`; model pins/hashes: `benchmarks/ensemble-models.json` and `benchmarks/ensemble-provenance.json`. Downloaded audio/models, source builds and Python environment live under ignored `.state/ensemble/`. The recognizer outputs retain token-limit, hint-count, confidence, window and timing evidence.

## Reproduction

Use Node 22 and the repository lockfile. Create `.state/ensemble/venv` with Python 3.12 and install `scripts/ensemble/requirements.txt`. Prepare the fixed audio with `scripts/prepare-expanded-window-study.py`, then `scripts/ensemble/prepare.py` and `scripts/ensemble/prepare-js.mjs`. The model manifest records the exact files used, not all precision variants in each repository. `bash scripts/ensemble/prepare-moonshine.sh` rebuilds the pinned native Moonshine telemetry library on ARM64 Linux, including its verified Git LFS data. It installs only into this trial's Python environment.

Run JS models with `node scripts/ensemble/run-js.mjs MODEL`, native models with `.state/ensemble/venv/bin/python scripts/ensemble/native.py MODEL`. These resume persisted windows and fill missing seams. Both accept disjoint zero-based passage ranges, e.g. `--cases=0:8` and `--cases=8:15`, and lock individual passages. Set `OPENBLAS_NUM_THREADS=1`, `MOONSHINE_ORT_SINGLE_THREAD=1`, and the recorded Moonshine ONNX library directory for native runs. Do not pass that older native library path to the JS runtime. Then run `node scripts/ensemble/stitch.mjs` (zero unresolved seams required), `node scripts/ensemble/audit.mjs`, `node scripts/ensemble/analyze.mjs` and `node scripts/ensemble/report.mjs`. The last two commands rescore the saved outputs, including all subset sizes and the original best trio’s 13 window-grid selections; they do not perform new inference.

`node --test test/ensemble-*.test.js` validates voting and joins. `node scripts/ensemble/browser-check.mjs MODEL` checks real WASM inference; `--paced` feeds audio in real time. Full provenance, final counts and timing exclusions must accompany published results.

## Primary references

- [NIST ROVER](https://www.nist.gov/publications/post-processing-system-yield-reduced-word-error-rates-recognizer-output-voting-error)
- [Conformer CTC Small model](https://huggingface.co/nvidia/stt_en_conformer_ctc_small)
- [Sherpa Zipformer models](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/online-transducer/zipformer-transducer-models.html) and [hotwords](https://k2-fsa.github.io/sherpa/onnx/hotwords/index.html)
- [Vosk model catalog](https://alphacephei.com/vosk/models)
- [Whisper models](https://github.com/openai/whisper#available-models-and-languages)
- [Moonshine models](https://moonshine-voice.readthedocs.io/en/latest/models/available-models/) and [keyterms](https://moonshine-voice.readthedocs.io/en/latest/models/domain-customization/)
