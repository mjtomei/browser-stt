import { samplesWave, waveSamples } from './speech-audio.js';

export function benchmarkWords(text) {
  return String(text).toLowerCase().replace(/[’‘]/g, "'").replace(/\bmr\.?\s/g, 'mister ').replace(/[^\p{L}\p{N}' ]/gu, ' ').split(/\s+/).filter(Boolean);
}
export function scoreSpeech(reference, text, { normalize = benchmarkWords } = {}) {
  const ref = normalize(reference), hyp = normalize(text);
  if (!ref.length) return null;
  const rows = Array.from({ length: ref.length + 1 }, () => new Uint16Array(hyp.length + 1));
  for (let i = 0; i <= ref.length; i++) rows[i][0] = i;
  for (let j = 0; j <= hyp.length; j++) rows[0][j] = j;
  for (let i = 1; i <= ref.length; i++) for (let j = 1; j <= hyp.length; j++) rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + Number(ref[i - 1] !== hyp[j - 1]));
  const wrong = new Array(ref.length).fill(false), extras = new Array(ref.length + 1).fill(0);
  let i = ref.length, j = hyp.length, substitutions = 0, deletions = 0, insertions = 0;
  while (i || j) {
    if (i && j && rows[i][j] === rows[i - 1][j - 1] + Number(ref[i - 1] !== hyp[j - 1])) {
      if (ref[i - 1] !== hyp[j - 1]) { wrong[i - 1] = true; substitutions++; } i--; j--;
    } else if (i && rows[i][j] === rows[i - 1][j] + 1) { wrong[--i] = true; deletions++; }
    else { extras[i]++; insertions++; j--; }
  }
  const errors = substitutions + deletions + insertions;
  return { errors, referenceWords: ref.length, wer: errors / ref.length, substitutions, deletions, insertions, wrong, extras };
}
export function correctionChanges(draft, corrected) {
  if (!draft || !corrected) return null;
  let fixed = 0, introduced = 0;
  draft.wrong.forEach((wrong, index) => { if (wrong && !corrected.wrong[index]) fixed++; if (!wrong && corrected.wrong[index]) introduced++; });
  draft.extras.forEach((count, index) => { fixed += Math.max(0, count - corrected.extras[index]); introduced += Math.max(0, corrected.extras[index] - count); });
  return { fixed, introduced };
}
export function noisySpeech(samples) {
  const output = samples.slice(); let energy = 0, seed = 714;
  for (const value of samples) energy += value * value;
  const amplitude = Math.sqrt(energy / samples.length) / Math.sqrt(10) * Math.sqrt(3);
  for (let i = 0; i < output.length; i++) { seed = (1664525 * seed + 1013904223) >>> 0; output[i] = Math.max(-1, Math.min(1, output[i] + (seed / 2 ** 32 * 2 - 1) * amplitude)); }
  return output;
}
export function summarizeSpeech(runs) {
  const summary = {};
  for (const model of ['fast', 'refine']) {
    const rows = runs.filter(row => row[model] && !row[model].error), scored = rows.filter(row => row[model].score);
    const words = scored.reduce((sum, row) => sum + row[model].score.referenceWords, 0);
    const errors = scored.reduce((sum, row) => sum + row[model].score.errors, 0);
    summary[model] = { count: rows.length, words, errors, wer: words ? errors / words : null, meanMs: rows.length ? rows.reduce((sum, row) => sum + row[model].ms, 0) / rows.length : null };
  }
  const paired = runs.filter(row => row.fast && !row.fast.error && row.refine && !row.refine.error);
  const scoredPairs = paired.filter(row => row.fast.score && row.refine.score);
  const words = scoredPairs.reduce((sum, row) => sum + row.fast.score.referenceWords, 0);
  summary.paired = { count: paired.length, meanMs: paired.length ? paired.reduce((sum, row) => sum + row.fast.ms + row.refine.ms, 0) / paired.length : null,
    words, draftWer: words ? scoredPairs.reduce((sum, row) => sum + row.fast.score.errors, 0) / words : null,
    finalWer: words ? scoredPairs.reduce((sum, row) => sum + row.refine.score.errors, 0) / words : null,
    fixed: paired.reduce((sum, row) => sum + (row.changes?.fixed || 0), 0), introduced: paired.reduce((sum, row) => sum + (row.changes?.introduced || 0), 0),
    improved: paired.filter(row => row.changes && row.refine.score.errors < row.fast.score.errors).length,
    worsened: paired.filter(row => row.changes && row.refine.score.errors > row.fast.score.errors).length };
  return summary;
}

export async function runSpeechBenchmark({ samples, models, signal, progress = () => {}, update = () => {}, now = () => performance.now() }) {
  const report = { completed: false, prepared: {}, runs: [] };
  progress('Preparing both models…', 'prepare');
  await Promise.all(['fast', 'refine'].map(async model => {
    const start = now(), alreadyReady = models.entries[model].state === 'ready';
    try { const info = await models.wait(model, { signal, retry: true }); report.prepared[model] = { alreadyReady, waitMs: now() - start, ...info }; }
    catch (error) { signal.throwIfAborted(); report.prepared[model] = { error: error.message }; }
  }));
  signal.throwIfAborted(); update(report);
  if (Object.values(report.prepared).every(row => row.error)) throw new Error('Neither voice model is available. Use Prepare / retry voice.');
  for (let index = 0; index < samples.length; index++) {
    signal.throwIfAborted(); const sample = samples[index];
    progress(`Test ${index + 1} of ${samples.length} · ${sample.label}`, 'run');
    const audio = await sample.audio(signal); signal.throwIfAborted();
    const pcm = waveSamples(await audio.arrayBuffer());
    const input = sample.noisy ? samplesWave(noisySpeech(pcm)) : audio;
    const row = { id: sample.id, label: sample.label, noisy: !!sample.noisy, reference: sample.reference, seconds: pcm.length / 16000 };
    for (const model of ['fast', 'refine']) {
      signal.throwIfAborted(); if (report.prepared[model].error) continue;
      progress(`Test ${index + 1} of ${samples.length} · ${sample.label} · ${model === 'fast' ? 'CPU draft' : 'GPU correction'}`, 'run');
      const start = now();
      try {
        // No reference/paper/custom vocabulary is given to either model. The
        // test reference is used only to score the independently produced text.
        const result = await models.transcribe(model, input, { signal, vocabulary: [] }); signal.throwIfAborted();
        row[model] = { text: result.text, words: result.words || [], ms: now() - start, inferenceMs: result.transcribeMs, backend: result.backend, score: scoreSpeech(sample.reference, result.text) };
      } catch (error) { signal.throwIfAborted(); row[model] = { error: error.message }; }
    }
    row.changes = correctionChanges(row.fast?.score, row.refine?.score);
    report.runs.push(row); report.summary = summarizeSpeech(report.runs); update(report);
  }
  report.completed = true; update(report); return report;
}
