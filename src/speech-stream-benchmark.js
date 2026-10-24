import { SpeechStream } from './speech-stream.js';
import { waveSamples, samplesWave } from './speech-audio.js';
import { pcmWave } from './pcm-microphone.js';
import { noisySpeech, scoreSpeech, correctionChanges } from './speech-benchmark.js';
import { safeTimeout, cancelTimeout } from './timers.js';

function delay(ms, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { cancelTimeout(timer); reject(signal.reason); };
    const timer = safeTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

// Feed recorded PCM at capture speed, through the same bounded-window decoder
// used for dictation. This measures delivered text, not just model inference.
export async function streamSpeechSample({ audio, transcribe, signal = new AbortController().signal,
  update = () => {}, now = () => performance.now(), sleep = delay, createStream = options => new SpeechStream(options) }) {
  const samples = waveSamples(await audio.arrayBuffer()); signal.throwIfAborted();
  const pcm = new Uint8Array(samples.length * 2), view = new DataView(pcm.buffer);
  for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, samples[i] * 32768, true);
  const complete = pcmWave([pcm]), durationMs = samples.length / 16;
  const start = now(), updates = [], backlog = []; let released, failure, calls = 0, inferenceMs = 0, maxFeedDelayMs = 0, fedMs = 0;
  const behind = () => Math.max(0, fedMs - (stream.completedEnd || 0) / 32);
  const changed = result => {
    if (signal.aborted || !result.text?.trim() || updates.at(-1)?.text === result.text) return;
    updates.push({ ms: now() - start, text: result.text });
    update({ text: result.text, elapsedMs: now() - start, durationMs, backlogMs: behind(), finishing: released !== undefined });
  };
  const stream = createStream({ minAudioMs: 500, intervalMs: 100, result: changed,
    failure: error => { failure = error; },
    transcribe: async (wave, options) => {
      calls++;
      const result = await transcribe(wave, { ...options, vocabulary: [] });
      inferenceMs += result.transcribeMs || 0; return result;
    },
  });
  const abort = () => stream.cancel(); signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted(); stream.start([]);
    for (let offset = 0; offset < pcm.length; offset += 3200) {
      const end = Math.min(offset + 3200, pcm.length), due = start + end / 32;
      await sleep(Math.max(0, due - now()), signal); signal.throwIfAborted();
      if (failure) throw failure;
      maxFeedDelayMs = Math.max(maxFeedDelayMs, now() - due);
      fedMs = end / 32; stream.receive(pcm.subarray(offset, end));
      backlog.push({ ms: now() - start, audioMs: fedMs, completedAudioMs: (stream.completedEnd || 0) / 32, backlogMs: behind() });
    }
    released = now();
    const textAtRelease = updates.at(-1)?.text || '', backlogAtReleaseMs = behind();
    update({ text: textAtRelease, elapsedMs: released - start, durationMs, backlogMs: backlogAtReleaseMs, finishing: true });
    const result = await stream.finish(complete, { signal }); signal.throwIfAborted(); changed(result);
    const end = now(), gaps = updates.slice(1).map((row, i) => row.ms - updates[i].ms);
    const sortedBacklog = backlog.map(row => row.backlogMs).sort((a, b) => a - b);
    const mean = rows => rows.reduce((sum, row) => sum + row.backlogMs, 0) / rows.length;
    const third = Math.max(1, Math.floor(backlog.length / 3));
    return { text: result.text, words: result.words || [], backend: result.backend, model: result.model,
      audioMs: durationMs, recordingMs: released - start, firstWordMs: updates[0]?.ms ?? null,
      releaseMs: end - released, totalMs: end - start, inferenceMs, calls,
      textAtRelease, backlog, backlogAtReleaseMs, backlogP95Ms: sortedBacklog[Math.ceil(sortedBacklog.length * .95) - 1],
      backlogEarlyMs: mean(backlog.slice(0, third)), backlogLateMs: mean(backlog.slice(-third)),
      updates, updateCount: updates.length, maxUpdateGapMs: gaps.length ? Math.max(...gaps) : null,
      revisions: updates.slice(1).filter((row, i) => !row.text.startsWith(updates[i].text)).length,
      maxFeedDelayMs, timingValid: maxFeedDelayMs <= 500 };
  } finally { signal.removeEventListener('abort', abort); stream.cancel(); }
}

export async function runStreamingSpeechBenchmark({ samples, models, signal = new AbortController().signal,
  progress = () => {}, update = () => {}, now = () => performance.now(), runSample = streamSpeechSample }) {
  if (!samples.length) throw new Error('Choose at least one test recording.');
  const report = { kind: 'streaming', completed: false, cadence: { feedMs: 100, minAudioMs: 500, intervalMs: 100 },
    prepared: {}, warmup: {}, runs: [], active: null };
  const emit = () => { signal.throwIfAborted(); update(report); };
  emit(); progress('Preparing Tiny and Small…', 'prepare');
  // The shared model waits are independent; Tiny stays available even while
  // Small downloads. Cancelling this test does not terminate shared preloads.
  await Promise.all(['fast', 'refine'].map(async model => {
    const start = now(), alreadyReady = models.entries[model].state === 'ready';
    try { report.prepared[model] = { ...(await models.wait(model, { signal, retry: true })), alreadyReady, waitMs: now() - start }; }
    catch (error) { signal.throwIfAborted(); report.prepared[model] = { error: error.message }; }
    emit();
  }));
  const clips = [];
  for (const sample of samples) {
    const audio = await sample.audio(signal); signal.throwIfAborted();
    clips.push({ ...sample, audio: sample.noisy ? samplesWave(noisySpeech(waveSamples(await audio.arrayBuffer()))) : audio });
  }
  // Kernel compilation/first inference is reported separately. Timed runs
  // start with both models ready and execute separately to avoid contention.
  for (const model of ['fast', 'refine']) {
    signal.throwIfAborted(); if (report.prepared[model].error) continue;
    progress(`Warming up ${model === 'fast' ? 'Tiny · CPU' : 'Small · GPU'}…`, 'warmup');
    const start = now();
    try {
      const result = await models.transcribe(model, clips[0].audio, { signal, vocabulary: [] });
      report.warmup[model] = { ms: now() - start, backend: result.backend };
    } catch (error) { signal.throwIfAborted(); report.warmup[model] = { error: error.message }; }
    emit();
  }
  for (const [index, clip] of clips.entries()) {
    const row = { id: clip.id, label: clip.label, reference: clip.reference, noisy: !!clip.noisy }; report.runs.push(row);
    // Alternate order to reduce a systematic first-model thermal advantage.
    for (const model of index % 2 ? ['refine', 'fast'] : ['fast', 'refine']) {
      signal.throwIfAborted(); if (report.prepared[model].error || report.warmup[model]?.error) continue;
      progress(`Clip ${index + 1}/${clips.length} · ${model === 'fast' ? 'Tiny · CPU' : 'Small · GPU'}`, 'stream');
      report.active = { model, label: clip.label, text: '', elapsedMs: 0 }; emit();
      try {
        row[model] = await runSample({ audio: clip.audio, signal, now,
          transcribe: (audio, options) => models.transcribe(model, audio, options),
          update: active => { report.active = { model, label: clip.label, ...active }; emit(); },
        });
        row[model].score = scoreSpeech(clip.reference, row[model].text);
        row[model].releaseScore = scoreSpeech(clip.reference, row[model].textAtRelease || '');
      } catch (error) { signal.throwIfAborted(); row[model] = { error: error.message }; }
      emit();
    }
    row.changes = correctionChanges(row.fast?.score, row.refine?.score);
  }
  signal.throwIfAborted(); report.active = null; report.completed = true; emit(); return report;
}

export function summarizeStreamingSpeech(runs) {
  return Object.fromEntries(['fast', 'refine'].map(model => {
    const successful = runs.map(row => row[model]).filter(row => row && !row.error);
    const timed = successful.filter(row => row.timingValid), scored = successful.filter(row => row.score);
    const mean = key => { const rows = timed.filter(row => row[key] != null); return rows.length ? rows.reduce((sum, row) => sum + row[key], 0) / rows.length : null; };
    const backlog = timed.flatMap(row => row.backlog || []).map(row => row.backlogMs).sort((a, b) => a - b);
    const gaps = timed.map(row => row.maxUpdateGapMs).filter(ms => ms != null);
    const words = scored.reduce((sum, row) => sum + row.score.referenceWords, 0);
    return [model, { count: successful.length, timedCount: timed.length,
      wer: words ? scored.reduce((sum, row) => sum + row.score.errors, 0) / words : null,
      firstWordMs: mean('firstWordMs'), releaseMs: mean('releaseMs'), updateCount: mean('updateCount'), revisions: mean('revisions'),
      backlogP95Ms: backlog.length ? backlog[Math.ceil(backlog.length * .95) - 1] : null, backlogAtReleaseMs: mean('backlogAtReleaseMs'),
      backlogEarlyMs: mean('backlogEarlyMs'), backlogLateMs: mean('backlogLateMs'), maxUpdateGapMs: gaps.length ? Math.max(...gaps) : null }];
  }));
}
