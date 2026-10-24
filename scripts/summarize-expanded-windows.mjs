// Run from the isolated engine checkout after all paced trials finish.
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const root = process.cwd();
const { benchmarkWords } = await import(pathToFileURL(`${root}/src/speech-benchmark.js`));
const manifest = JSON.parse(await readFile('benchmarks/window-study-expanded-manifest.json'));
if (manifest.cases.length !== 15 || new Set(manifest.cases.map(c => c.speaker)).size !== 15 || manifest.cases.some(c => c.seconds < 95)) throw new Error('Expected 15 different speakers with >=95s passages');
const windows = [15, 30, 60], repeatCases = [0, 7, 12];
const median = values => { const sorted = values.toSorted((a, b) => a - b), mid = Math.floor(sorted.length / 2); return !sorted.length ? null : sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2; };
const percentile = (values, p) => { const sorted = values.toSorted((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? null; };
function counts(words, n) {
  const result = new Map();
  for (let i = 0; i <= words.length - n; i++) {
    const key = words.slice(i, i + n).join(' '); result.set(key, (result.get(key) || 0) + 1);
  }
  return result;
}
// Conservative flag, not an ASR accuracy metric. Ignore repetition supported
// by the reference; catch long tandem loops and recurring eight-word phrases.
function repetitionDetector(reference) {
  const ref = benchmarkWords(reference), refText = ` ${ref.join(' ')} `, refCounts = counts(ref, 8);
  return text => {
    const words = benchmarkWords(text), phrases = counts(words, 8);
    let best = null;
    for (const [phrase, count] of phrases) if (count >= 3 && count > (refCounts.get(phrase) || 0) + 1) {
      if (!best || count > best.copies) best = { kind: 'recurring-8gram', phrase, copies: count };
    }
    for (let i = 0; i < words.length; i++) for (let n = 1; n <= 12 && i + 3 * n <= words.length; n++) {
      if (words[i] !== words[i + n]) continue;
      let end = i + n;
      while (end < words.length && words[end] === words[i + (end - i) % n]) end++;
      const copies = Math.floor((end - i) / n), length = copies * n;
      if (copies < 3 || length < 12 || refText.includes(` ${words.slice(i, i + length).join(' ')} `)) continue;
      if (!best || length > (best.repeatedWords || 0)) best = { kind: 'tandem', phrase: words.slice(i, i + n).join(' '), copies, repeatedWords: length };
    }
    return best;
  };
}
// Legitimate repetition must not be labelled a hallucination.
if (repetitionDetector('we shall go we shall go we shall go we shall go')('we shall go we shall go we shall go we shall go')) throw new Error('Reference repetition false positive');
if (!repetitionDetector('we shall go home')('we shall go '.repeat(5))) throw new Error('Missed repeated phrase');
if (repetitionDetector('the book is here')('the book is here')) throw new Error('Normal text false positive');

const rows = [];
for (let index = 0; index < manifest.cases.length; index++) for (const windowSeconds of windows) for (const repeat of repeatCases.includes(index) ? [false, true] : [false]) {
  const sample = manifest.cases[index], label = `expanded-${sample.id}-${windowSeconds}${repeat ? '-repeat' : ''}`;
  const raw = `test-results/window-study-chromium-${label}.json`;
  const report = JSON.parse(await readFile(raw));
  const run = report.runs[0], expected = sample.samples.map(s => s.reference).join(' ');
  const detect = repetitionDetector(expected);
  if (!report.completed || report.errors.length || !run) {
    rows.push({ id: sample.id, config: sample.config, speaker: sample.speaker, windowSeconds, repeat, raw, failed: true, errors: report.errors }); continue;
  }
  const finalLoop = detect(run.text);
  if (!report.paced || report.case?.id !== sample.id || run.windowSeconds !== windowSeconds || run.expected !== expected ||
      report.samples.some((clip, i) => clip.sha256 !== sample.samples[i]?.sha256)) throw new Error(`Mismatched trial inputs: ${raw}`);
  if (windowSeconds === 60 && ![0, 30].every(start => run.calls.some(c => c.start === start && c.end === start + 60 && c.segments.length === 1 && c.segments[0].seconds === 60))) throw new Error(`Missing full 60-second model windows: ${raw}`);
  const modelLoops = run.calls.flatMap(call => {
    const example = detect(call.text);
    return example ? [{ start: call.start, end: call.end, seconds: call.seconds, example }] : [];
  });
  let everLoop = null, flaggedUpdates = 0;
  for (const update of run.updates) {
    const loop = detect(update.text);
    if (loop) { everLoop ||= { ...loop, ms: update.ms }; flaggedUpdates++; }
  }
  const { wrong, extras, ...score } = run.score;
  rows.push({ id: sample.id, config: sample.config, speaker: sample.speaker, windowSeconds, repeat, raw, failed: false,
    execution: report.execution, score, metrics: run.metrics, text: run.text,
    repetition: { ever: !!everLoop, final: !!finalLoop, resolvedByFinish: !!everLoop && !finalLoop, flaggedUpdates, first: everLoop, finalExample: finalLoop,
      rawModelCallsFlagged: modelLoops.length, rawModelExamples: modelLoops.slice(-2) } });
}
const primary = rows.filter(row => !row.repeat);
if (primary.length !== 45 || rows.length !== 54) throw new Error('Expected 45 distinct sample trials plus nine repeats');
const aggregates = windows.map(windowSeconds => {
  const all = primary.filter(row => row.windowSeconds === windowSeconds), completed = all.filter(row => !row.failed), timed = completed.filter(row => row.metrics.timingValid);
  const errors = completed.reduce((n, row) => n + row.score.errors, 0), words = completed.reduce((n, row) => n + row.score.referenceWords, 0);
  return { windowSeconds, planned: all.length, completed: completed.length, failed: all.length - completed.length, validTimingRuns: timed.length,
    errors, words, pooledWer: errors / words, medianWer: median(completed.map(row => row.score.wer)),
    substitutions: completed.reduce((n, row) => n + row.score.substitutions, 0), deletions: completed.reduce((n, row) => n + row.score.deletions, 0), insertions: completed.reduce((n, row) => n + row.score.insertions, 0),
    finalRepetitionCases: completed.filter(row => row.repetition.final).length, temporaryOnlyRepetitionCases: completed.filter(row => row.repetition.resolvedByFinish).length,
    revisions: completed.reduce((n, row) => n + row.metrics.revisions, 0), changedWords: completed.reduce((n, row) => n + row.metrics.changedWords, 0),
    medianFirstWordMs: median(timed.map(row => row.metrics.firstWordMs)), medianP95BacklogSeconds: median(timed.map(row => row.metrics.backlogP95Seconds)), medianReleaseMs: median(timed.map(row => row.metrics.releaseMs)),
    maxReleaseMs: Math.max(...timed.map(row => row.metrics.releaseMs)), maxFeedLatenessMs: Math.max(...timed.map(row => row.metrics.feedLateMs)) };
});
const completePairs = manifest.cases.map(sample => [15, 30].map(size => primary.find(row => row.id === sample.id && row.windowSeconds === size))).filter(pair => pair.every(row => !row.failed));
let seed = 20261013;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
const differences = [];
for (let iteration = 0; iteration < 10000; iteration++) {
  const sampled = ['clean', 'other'].flatMap(config => {
    const group = completePairs.filter(pair => pair[0].config === config);
    return group.map(() => group[Math.floor(random() * group.length)]);
  });
  const words = sampled.reduce((sum, pair) => sum + pair[0].score.referenceWords, 0);
  differences.push(sampled.reduce((sum, pair) => sum + pair[1].score.errors - pair[0].score.errors, 0) / words);
}
const comparison = { pairs: completePairs.length, wins30: completePairs.filter(([a, b]) => b.score.errors < a.score.errors).length,
  wins15: completePairs.filter(([a, b]) => a.score.errors < b.score.errors).length, ties: completePairs.filter(([a, b]) => a.score.errors === b.score.errors).length,
  pairedBootstrap95Difference30Minus15: [percentile(differences, .025), percentile(differences, .975)], bootstrapSamples: 10000, seed: 20261013, stratifiedBy: 'clean/other',
  caution: 'Exploratory paired bootstrap on 15 read-speech passages, not a general benchmark or phone estimate.' };
const repeats = rows.filter(row => row.repeat).map(row => {
  const first = primary.find(other => other.id === row.id && other.windowSeconds === row.windowSeconds);
  return { id: row.id, windowSeconds: row.windowSeconds, bothCompleted: !first.failed && !row.failed,
    ...(!first.failed && !row.failed ? { identicalFinalText: first.text === row.text, errors: [first.score.errors, row.score.errors],
      identicalNormalizedText: benchmarkWords(first.text).join(' ') === benchmarkWords(row.text).join(' '),
      finalRepetition: [first.repetition.final, row.repetition.final], firstWordMs: [first.metrics.firstWordMs, row.metrics.firstWordMs],
      p95BacklogSeconds: [first.metrics.backlogP95Seconds, row.metrics.backlogP95Seconds], releaseMs: [first.metrics.releaseMs, row.metrics.releaseMs] } : {}) };
});
const retainedAttempts = [];
const retryDirectory = 'test-results/window-expanded/retries';
for (const filename of (await readdir(retryDirectory)).sort()) {
  if (!filename.endsWith('.json')) continue;
  const raw = `${retryDirectory}/${filename}`, report = JSON.parse(await readFile(raw)), run = report.runs[0];
  retainedAttempts.push({ raw, createdAt: report.createdAt, completed: report.completed, errors: report.errors,
    ...(run ? { windowSeconds: run.windowSeconds, timingValid: run.metrics.timingValid, feedLateMs: run.metrics.feedLateMs,
      finalWordErrors: run.score.errors } : {}) });
}
const summary = { createdAt: new Date().toISOString(), model: { name: 'Moonshine Tiny', backend: 'CPU WASM SIMD', revision: 'a6da1241cd305dcd64eab1edbd615f2bb9aabb95' },
  physicalPhone: false, manifest: 'benchmarks/window-study-expanded-manifest.json', sampleCount: 15,
  notes: ['Half-window overlap, pause commitment disabled; final output after release/draining.', '15 distinct speakers, 10 test-clean and 5 test-other, >=95s per passage.',
    'Three concurrent lanes, distinct performance CPU pairs, configuration rotated across lanes. Shared host; see calibration reports.',
    'First-word time is from capture start, not a forced-aligned speech onset. Backlog is received minus completed audio.',
    'Final repetition is a reference-aware heuristic: tandem 1–12-word units repeated >=3 times over >=12 words, or an eight-word phrase occurring >=3 times and >reference count+1.',
    'Three preselected cases repeated at every size; repeats excluded from pooled accuracy and confidence interval.',
    'Host memory-pressure interruptions and feed lateness >500ms trigger retries. Select the first completed timing-valid attempt, never the lowest WER. Later timing retries ran sequentially. All prior JSON attempts are listed; startup-only logs are also retained in the retry directory.',
    'Valid feed timing does not establish uncontended inference. Shared-host latency remains descriptive; see interruption/recovery details in the report.'],
  aggregates, comparison, repeats, retainedAttempts, rows };
await writeFile('benchmarks/window-study-expanded-results.json', JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify({ aggregates, comparison, repeats }, null, 2));
