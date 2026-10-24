# Rolling speech context: 15, 30 and 60 seconds

**Follow-up:** the [15-passage expanded study](window-study-expanded.md) tests 95–108-second recordings with repeats. It finds essentially equal 15/30-second accuracy and persistent final repetition in all 15 primary 60-second trials. Use that larger study for current conclusions; this page preserves the initial smoke test.

Measured 2026-10-13. Longer context gave a small accuracy improvement and fewer visible revisions at 30 seconds, at the cost of slower updates. A 60-second window was unreliable with this Tiny model: it repeated unspoken phrases and fell far behind. Pageborne's installed engine/defaults were not changed.

## Paced results

Real Moonshine Tiny CPU/WASM SIMD, warm model, headless Chrome 154.0.8037.57 on a shared Linux ARM workstation. Each configuration receives identical audio in 100 ms increments. The model starts after 500 ms plus a 100 ms coalescing delay, regardless of the maximum window. Windows overlap by half their length, and **pause commitment is disabled** in this table to measure genuine retained context.

| Recording | Window / overlap | Word errors | Visible revisions | First text | P95 audio backlog | Finish after release |
|---|---:|---:|---:|---:|---:|---:|
| Prose, 109.76 s / 254 words | 15 / 7.5 s | 23 (9.1%) | 54 | 1.27 s | 2.5 s | 1.02 s |
| Prose | 30 / 15 s | 22 (8.7%) | 31 | 1.68 s | 5.6 s | 3.07 s |
| Prose | 60 / 30 s | 345 (135.8%) | 27 | 1.27 s | 30.1 s | 33.35 s |
| Mixed speakers, 71.18 s / 180 words | 15 / 7.5 s | 10 (5.6%) | 29 | 1.27 s | 3.1 s | 1.38 s |
| Mixed speakers | 30 / 15 s | 8 (4.4%) | 20 | 1.27 s | 6.5 s | 4.63 s |
| Mixed speakers | 60 / 30 s | 315 (175.0%) | 16 | 1.18 s | 19.4 s | 41.77 s |

The pooled 15/30-second comparison is 33 versus 30 errors in 434 reference words (7.6% versus 6.9%). This is a small descriptive difference, not a statistically established accuracy gain. Errors break down as 24 substitutions + 3 deletions + 6 insertions at 15 seconds, versus 27 substitutions + 3 deletions + 0 insertions at 30 seconds. More context did not consistently improve recognizing names or individual words; fewer inserted words account for the net improvement.

Visible revision events fell from 83 to 51. Cumulative already-visible words replaced/deleted fell from 170 to 127, though this worsened on the mixed recording alone (35 → 50). A lower revision count by itself is not success: the 60-second output contains hundreds of invented/repeated words. WER can exceed 100% because insertions count as errors.

## Comparison with the current pause policy

On the same prose recording, the current 15-second maximum with pause commitment enabled used actual model windows no larger than 10.5 seconds. It produced 27 errors (10.6%), 89 visible revisions, a 1.3-second P95 audio backlog, and a 1.03-second release tail. Total inference time was 62.8 seconds, versus 97.1 seconds for continuous 15-second context and 103.8 seconds for continuous 30-second context. This is inference wall time, not a battery measurement.

Keeping context across pauses helped this example, but costs work and latency. The current pause commitment also protects against a previously reproduced loss of repeated sentences; do not remove it from production solely on these two recordings. A 30-second / 15-second-overlap setting is a reasonable **next phone experiment**, with repeated-sentence retention and actual device lag checked before promotion. The current app remains unchanged.

## Actual word arrival and churn

P95 backlog measures audio received minus the end of the last completed decode. It is not a word-aligned latency measure. The 60-second model can emit nonsense quickly while failing to recognize newer audio, so the number/frequency of visible updates is misleading.

As a second check, match the last three reference words of each prose clip against visible updates. Their median first-visible delay relative to the original clip endpoint was 1.01 s at 15 seconds (10/10 anchors ever seen), 2.72 s at 30 seconds (9/10), and 8.23 s at 60 seconds (9/10; maximum 51.64 s). Only 8/10, 9/10 and 8/10 respectively survived in the final transcript. Clip endpoints include trailing silence; these are sentence-tail checks, not precise word timestamps. See the JSON for each anchor and its survival.

A revision is a normalized-word sequence that no longer starts with the previously visible sequence. Case/punctuation-only changes and pure appended words are excluded. Changed-word counts cumulatively sum substitutions/deletions from old to new text; they are not counts of distinct corrected words or measures of correctness. All sizes occasionally produced poor partial drafts; the major 60-second repetitions persisted into final results.

## Implementation and experimental controls

The existing recognizer had two independent 15-second limits: the rolling stream and the worker's internal segmentation. Both are now configurable for experiments. `SpeechStream.windowSeconds` is forwarded as `chunkSeconds` through ResidentSpeech and LocalSpeech to the worker. Each benchmark verifies that every requested WAV was processed as **one** actual model segment. A large outer buffer with an unchanged inner limit would not test the proposed context benefit.

The token allowance remains eight tokens per audio second, extended to 480 tokens for 60-second inputs instead of a 180-token ceiling. Several 60-second passes ran to this larger limit while repeating phrases such as “the most of the most…”; this was not merely truncation at the old cap. Smaller-window partials occasionally hit their limits too. Tiny's pinned configuration lists `max_position_embeddings: 512`. These are experimental limits, not a claim that 60-second input is a reliable supported use case.

Defaults remain 15 seconds, pause commitment on, overlap off in the general package (Pageborne opts into 7.5 seconds). The optional Small model retains its existing default and rejects experimental larger chunks. No model weights or vocabulary behavior changed. Stream PCM allocation peaked at 0.96, 1.92 and 3.84 MB for 15/30/60 seconds respectively; these figures exclude model/runtime memory.

## Data, limits and reproduction

The prose fixture concatenates the first ten consecutive clips of one chapter from [the published LibriSpeech dummy dataset](https://huggingface.co/datasets/hf-internal-testing/librispeech_asr_dummy), without added silence, repetition or noise. The mixed fixture uses the existing nine known-reference clips from four speakers in `vendor/stt/benchmark-samples.json`. The first three clips occur in both recordings, so these are not two independent accuracy samples. This is read speech with source clip boundaries, not spontaneous glasses microphone audio.

One paced run per configuration; prose order 15 → 30 → 60, mixed order reversed. Warm-up is excluded. No vocabulary hints or reference text enter inference. Audio delivery lateness stayed below 14 ms (500 ms would invalidate timing). No physical iPhone, BLE, cold-start/download or power measurement. Desktop WebKit passes the existing default-window regression; the new timing table is Chrome only.

Model: `onnx-community/moonshine-tiny-ONNX`, revision `a6da1241cd305dcd64eab1edbd615f2bb9aabb95`, existing FP32 encoder / q4 decoder. The retained [summary JSON](../benchmarks/window-study-2026-10-13.json) includes references, audio checksums, final transcripts, metrics and sentence-tail checks. Raw calls, every visible update, and backlog samples remain in `test-results/window-study-chromium-*.json`; the `prose-60-sanity` run uses batch delivery and is **not** a latency measurement.

```sh
# Use Node 22.13+ from PATH
export BROWSER_STT_CACHE=/path/to/model-cache
export CHOKIDAR_USEPOLLING=true
FFMPEG=/path/to/ffmpeg python3 scripts/prepare-window-study.py
npm run build
node scripts/window-study.mjs --policies=context --label=prose-context-paced
node scripts/window-study.mjs --scenario=mixed --windows=60,30,15 --label=mixed-context-paced
node scripts/window-study.mjs --policies=pause --windows=15 --label=prose-current-policy
node scripts/window-study.mjs --windows=60 --batch --label=prose-60-sanity
node scripts/summarize-window-study.mjs
npm test
npm run test:types
WEBKIT_PATH=/path/to/webkit-launcher node scripts/rolling-stream-browser-test.mjs --webkit --quick
```

Run timed comparisons sequentially. Do not edit/rebuild watched source during a browser run. Polling avoids this shared workstation's exhausted inotify instances. The preparation script verifies downloaded/cached audio and references against the retained study checksums; new source data must be reviewed as a new study.
