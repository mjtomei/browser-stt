# Expanded rolling-window study: 15 long passages per configuration

Measured 2026-10-13. **Thirty seconds did not establish an accuracy advantage over 15 seconds; 60 seconds was consistently unreliable with this Tiny model.** This follow-up supersedes the accuracy recommendation from the earlier two-recording smoke study. App defaults and installed packages remain unchanged.

Fifteen distinct passages were tested at each size, each **95–108 seconds long**, plus three preselected repeated passages per size: **54 completed paced trials**. Every retained trial passes the audio-delivery timing check. The primary set contains 4,311 reference words from 15 speakers. Each 60-second trial runs full model windows at **0–60 and 30–90 seconds**, then the remaining tail.

## Results

| Window / overlap | Final word errors | WER | Major repetition remaining at finish | Temporary-only repetition | First text, median | P95 backlog, median | Release delay, median |
|---|---:|---:|---:|---:|---:|---:|---:|
| 15 / 7.5 s | 379 / 4,311 | 8.79% | 1/15 | 2/15 | 1.26 s | 3.3 s | 1.72 s |
| 30 / 15 s | 376 / 4,311 | 8.72% | 0/15 | 2/15 | 1.19 s | 6.2 s | 3.42 s |
| 60 / 30 s | 5,005 / 4,311 | 116.10% | 15/15 | 0/15 | 1.26 s | 39.1 s | 30.02 s |

The 15/30-second difference is only **three errors, or 0.07 percentage points**. Each wins on seven passages, with one tie. An exploratory paired bootstrap, stratified by clean/other, gives a 95% interval of **−1.70 to +1.64 percentage points** for 30-second minus 15-second WER. This does not establish improved accuracy from the longer buffer. Error breakdown is 268 substitutions / 32 deletions / 79 insertions at 15 seconds, versus 280 / 27 / 69 at 30 seconds.

Thirty seconds reduces visible revision events from **573 to 391 (32%)**, but cumulative replaced/deleted visible words only falls from 1,065 to 1,013 (5%). It changes text less often, while making somewhat larger changes, and the median processing backlog roughly doubles. Median first-text times remain similar because decoding starts on the first small amount of audio rather than waiting for a complete maximum-length window.

Sixty seconds produces **3,698 inserted words**, which helps explain WER above 100%. Major loops are present in the raw model outputs before overlap merging and remain after all pending work finishes. For example, one final transcript repeats “to be able” 140 times. The 15-second exception is case 04, whose final output repeats “400” 13 times; it was not one of the three preselected repeat cases. These counts use the conservative major-loop heuristic below, not a claim that all smaller duplications were absent.

**The user's observation about temporary repetition is also supported:** two 15-second passages and two 30-second passages briefly show a major loop that disappears before the final result. Those are counted separately from final repetition. All 15 primary 60-second results retain a major loop, as do their three repeat trials.

All **nine repeated final transcripts are byte-for-byte identical** to their corresponding primary transcripts, including the 60-second loops. The partial-output timing and revision paths vary between runs. Three repeated passages are a stability check, not proof of determinism on every input.

I would keep Pageborne's current 15-second maximum and pause policy. Thirty seconds remains an optional phone experiment for lower revision frequency, with a latency cost; this larger study does not justify it as an accuracy improvement. Sixty seconds should not become the default for this pinned Tiny model. No production behavior, weights, package version, reader dependency or Hub build was changed by this follow-up.

## Do recognized words keep up?

Exact word timestamps are unavailable in this corpus setup, so source-utterance endings provide a supplementary check. Of 219 eligible unique three-word sentence-tail anchors:

| Window | Ever visible | Retained at finish | Median first arrival after clip end | Median stable arrival after clip end |
|---|---:|---:|---:|---:|
| 15 s | 179/219 | 171/219 | 1.28 s | 1.23 s |
| 30 s | 182/219 | 174/219 | 3.15 s | 3.27 s |
| 60 s | 164/219 | 126/219 | 10.53 s | 35.16 s |

Arrival delays only include recognized anchors, and clip endpoints include trailing silence. The first/stable columns have different surviving subsets, so their medians need not be ordered. The 60-second setting both loses more anchors and leaves recognized endings provisional much longer. These are descriptive desktop measurements; host-contention limits are explained below.

## Per-passage final accuracy

Each row is the same audio at all sizes; the repeated trials are excluded here.

| Case / speaker | Split | Duration | Reference words | Errors: 15 s | Errors: 30 s | Errors: 60 s |
|---|---|---:|---:|---:|---:|---:|
| 01 / 6930 | clean | 97.88 s | 245 | 8 | 18 | 237 |
| 02 / 260 | clean | 108.43 s | 292 | 26 | 30 | 377 |
| 03 / 7127 | clean | 98.36 s | 238 | 25 | 24 | 336 |
| 04 / 8230 | clean | 98.74 s | 270 | 19 | 5 | 333 |
| 05 / 1284 | clean | 100.37 s | 324 | 18 | 16 | 298 |
| 06 / 2830 | clean | 95.43 s | 290 | 10 | 10 | 428 |
| 07 / 4077 | clean | 101.44 s | 281 | 15 | 14 | 252 |
| 08 / 8224 | clean | 101.48 s | 220 | 8 | 4 | 370 |
| 09 / 5105 | clean | 105.19 s | 283 | 15 | 17 | 311 |
| 10 / 2300 | clean | 105.19 s | 248 | 6 | 8 | 346 |
| 11 / 7902 | other | 97.61 s | 343 | 44 | 32 | 342 |
| 12 / 6128 | other | 95.52 s | 260 | 73 | 57 | 371 |
| 13 / 7975 | other | 98.58 s | 345 | 30 | 55 | 386 |
| 14 / 3538 | other | 97.49 s | 363 | 21 | 23 | 272 |
| 15 / 4852 | other | 100.09 s | 309 | 61 | 63 | 346 |

## What was tested

Fifteen different speakers: ten passages from LibriSpeech test-clean and five from test-other. Each passage concatenates consecutive utterances from one speaker/chapter, with no repeated audio, inserted silence or artificial noise. Durations are 95.43–108.43 seconds, totaling 1,501.82 seconds (25.03 minutes). Every 60-second trial therefore exercises complete overlapping windows at 0–60 and 30–90 seconds, plus the remaining tail. The actual worker telemetry verifies each requested window is one model pass, with no hidden 15-second segmentation.

The same PCM is fed in real time at 100 ms intervals for all three configurations. Window lengths are 15, 30 and 60 seconds; overlap is half the window. Pause commitment is disabled to preserve full context across pauses. This differs from Pageborne's installed pause policy, which remains enabled. Model and decoding settings match the preceding study: Moonshine Tiny CPU/WASM SIMD, FP32 encoder/q4 decoder, pinned revision `a6da1241cd305dcd64eab1edbd615f2bb9aabb95`, one inference thread. No vocabulary hints or reference text enter the model. Warm-up precedes timing. Final accuracy is scored only after release and draining all pending audio.

There are 45 primary trials (15 passages × 3 configurations), plus nine repeat trials: cases 01, 08 and 13 repeated once at each size. Repeat cases were selected before the primary results. Repeats and calibration runs are excluded from pooled primary accuracy. These are 15 distinct passages per size, not 15 repetitions of each passage.

The manifest was fixed before the main inference batch. Selection used source metadata offsets, unused speakers and sufficient duration, without looking at model outputs. The four speakers in the earlier smoke corpus were excluded. The pinned `openslr/librispeech_asr` revision is `71cacbfb7e2354c4226d01e70d77d5fca3d04ba1`; SHA-256 hashes of each source FLAC and decoded WAV, references, row IDs and duration-based exclusions are retained in the [manifest](../benchmarks/window-study-expanded-manifest.json). Source: [LibriSpeech / OpenSLR 12](https://www.openslr.org/12), CC BY 4.0.

## Timing and repetition definitions

First-word time is the first nonempty visible output after capture begins; it is not a guarantee that this word is correct or a forced-aligned speech-onset measurement. P95 backlog is the 95th percentile of received audio minus the endpoint of the last completed decode, computed per trial. The table reports the median of those per-trial P95s. It is not exact per-word delay. Release delay includes all pending transcription and overlap reconciliation.

Unique final three-word phrases from source utterances give a supplementary check that recognized words reach the screen. Their arrival is measured relative to each clip endpoint, which can include trailing silence. Negative delays are possible. Only recognized phrases contribute delay statistics; missing phrases are reported separately. These are sentence-tail checks, not forced alignment. Stable arrival is the appearance after the last disappearance among updates, for phrases retained at finish.

A revision changes or removes previously visible normalized words; pure appends and punctuation/case-only changes are excluded. Changed-word totals cumulatively count replaced/deleted words across revisions, not distinct corrections. A lower revision count does not mean better output when a decoder is stuck repeating a phrase.

The major-repetition heuristic flags an unsupported 1–12-word unit repeated at least three times over at least 12 words, or an eight-word phrase appearing at least three times and more than its reference count plus one. Exact reference-supported repetition is exempt. Every visible update and the final transcript are checked separately. This deliberately conservative flag does not capture every duplicated word or false phrase; final WER remains the primary accuracy metric. Flagged final transcripts are manually inspected against their references.

## Workstation conditions and interruption

Headless Chrome 154.0.8037.57 ran on a shared Linux ARM workstation. Three independent test lanes used disjoint performance CPU pairs (5–6, 7–8, 15–16), rotating configurations across pairs. A serial-versus-concurrent calibration on identical 30-second windows showed at most 4.6% slowdown in median full-window inference, below a pre-batch 15% cutoff. All four final calibration transcripts were identical. This does not establish zero contention or phone timing.

After cases 01–07, unrelated shared-host memory pressure exhausted almost all RAM and swap, with substantial memory stalls. The benchmark processes were stopped; unrelated services were left alone. Interrupted attempts and logs are retained under `test-results/window-expanded/retries/`, with the original lane ledgers under `test-results/window-expanded/host-interruption-2026-10-13T1742/`. After pressure subsided, a recovery calibration produced the identical final transcript and median full-window inference within 0.6% of the initial serial calibration. Interrupted cases were rerun. They are environmental interruptions, not scored model transcripts. See [calibration and recovery measurements](../benchmarks/window-study-expanded-calibration.json).

Later brief host stalls invalidated four more completed trials (two primary and two repeats). Their original transcripts and timings were preserved before sequential retries. Retry selection follows timing/completion validity, never lower word-error counts.

Audio-feed lateness over 500 ms invalidates a timing run. Low feed lateness does not prove the inference worker experienced no resource contention: latency values remain descriptive shared-host measurements, even for runs that passed this check. The report retains timing validity, affinity and all final outputs. Read speech assembled from source clips is not spontaneous glasses dictation; this study does not measure iPhone/BLE latency, cold loading, battery use or full-process memory. Results apply to this pinned Tiny model and streaming implementation, not to longer-context ASR models in general.

## Reproduction

From the isolated `/path/to/browser-stt` checkout, using Node 22:

```sh
# Use Node 22.13+ from PATH
export BROWSER_STT_CACHE=/path/to/model-cache
export CHOKIDAR_USEPOLLING=true
FFMPEG=/path/to/ffmpeg python3 scripts/prepare-expanded-window-study.py
npm run build
```

To run one passage/configuration in isolation:

```sh
STUDY_LANE=solo taskset -c 5,6 node scripts/window-study.mjs \
  --manifest=benchmarks/window-study-expanded-manifest.json \
  --case=01-clean-6930-81414 --windows=30 --policies=context \
  --label=expanded-01-clean-6930-81414-30
```

To reproduce the batch, launch each lane in a separate terminal after confirming the host is stable:

```sh
taskset -c 5,6 node scripts/run-expanded-window-lane.mjs --lane=0
taskset -c 7,8 node scripts/run-expanded-window-lane.mjs --lane=1
taskset -c 15,16 node scripts/run-expanded-window-lane.mjs --lane=2
```

The runner resumes valid completed reports and archives unsuccessful attempts before retrying. Do not edit or rebuild watched source while a timed browser run is active. Raw reports include each actual model call, every visible draft and the audio backlog samples; compact results and source provenance are tracked in git. To intentionally rerun an already completed trial, archive its existing report first or use a different label.

After all runs finish:

```sh
node scripts/summarize-expanded-windows.mjs
node scripts/summarize-expanded-anchors.mjs
```

The [tracked results](../benchmarks/window-study-expanded-results.json) contain all 54 final transcripts, per-run scores, primary/repeat comparisons, sentence-tail checks, actual full-window coordinates, and an audit of 12 retained JSON attempts excluded for interruption or invalid timing. Startup-only logs are also retained locally. The last timed-out primary was rerun again successfully; no unsuccessful transcript was selected for a lower WER. All retained primary and repeat runs are complete and have valid feed timing; maximum primary feed lateness is 153.4 ms.

Validation for this follow-up: all source WAV hashes and PCM durations/formats checked (221 clips); same-input checks in the summary; 54 successful real-model trials with receipt/confidence-offset validation and one actual model segment per requested window; five calibration runs; script syntax checks and repetition-detector sanity cases. Engine source did not change, so the previous 94-unit/type/build/WebKit results remain historical checks rather than newly rerun tests. Pageborne remains local 0.8.64 / engine 0.1.8, Hub private 0.8.63 build 109312. No upload was requested or performed.
