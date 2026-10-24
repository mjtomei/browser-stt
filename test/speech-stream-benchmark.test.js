import test from 'node:test';
import assert from 'node:assert/strict';
import { samplesWave } from '../src/speech-audio.js';
import { streamSpeechSample, runStreamingSpeechBenchmark, summarizeStreamingSpeech } from '../src/speech-stream-benchmark.js';

const audio = samplesWave(Float32Array.from({ length: 16000 }, (_, i) => .1 * Math.sin(i)));
const clip = { id: 'one', label: 'One', reference: 'hello world', audio: async () => audio };
test('paced audio measures first words, release tail and revisions separately from preparation', async () => {
  let clock = 0, received = 0, cancelled = false; const sent = [];
  const result = await streamSpeechSample({ audio, now: () => clock,
    sleep: async ms => { clock += ms; },
    createStream: options => ({ completedEnd: 0, start() {}, receive(bytes) {
      sent.push(clock); received += bytes.length;
      if (received % 6400 === 0) this.completedEnd = received - 3200;
      if (received === 9600) options.result({ text: 'yellow' });
      if (received === 19200) options.result({ text: 'yellow world' });
    }, async finish(wave) { assert.equal(wave.size, audio.size); clock += 80; return { text: 'hello world', backend: 'webgpu' }; }, cancel() { cancelled = true; } }),
  });
  assert.deepEqual(sent, [100,200,300,400,500,600,700,800,900,1000]);
  assert.equal(result.firstWordMs, 300); assert.equal(result.releaseMs, 80); assert.equal(result.totalMs, 1080);
  assert.equal(result.updateCount, 3); assert.equal(result.revisions, 1); assert(result.timingValid); assert(cancelled);
  assert.equal(result.backlogAtReleaseMs, 100); assert.equal(result.backlogP95Ms, 200);
  assert.equal(result.backlog[3].completedAudioMs, 300); assert.equal(result.textAtRelease, 'yellow world');
});
test('late audio delivery marks timings invalid; cancellation stops playback and decoder', async () => {
  let clock = 0, cancelled = false;
  const controller = new AbortController();
  const createStream = options => ({ start() {}, receive() { options.result({ text: 'hello' }); },
    async finish() { return { text: 'hello', backend: 'wasm' }; }, cancel() { cancelled = true; } });
  const result = await streamSpeechSample({ audio, now: () => clock, sleep: async ms => { clock += ms + 600; }, createStream });
  assert.equal(result.timingValid, false);
  await assert.rejects(streamSpeechSample({ audio, signal: controller.signal, now: () => clock,
    sleep: async () => controller.abort(), createStream }), { name: 'AbortError' });
  assert(cancelled);
});
test('each model gets the same clips without hints, warm-up is excluded and order alternates', async () => {
  let clock = 0; const calls = [], order = [];
  const models = { entries: { fast: { state: 'ready' }, refine: { state: 'idle' } },
    async wait(model) { clock += 100; return { backend: model === 'fast' ? 'wasm' : 'webgpu' }; },
    async transcribe(model, input, options) { assert.deepEqual(options.vocabulary, []); calls.push([model, input.size]); clock += 200; return { text: model === 'fast' ? 'yellow world' : 'hello world', backend: model === 'fast' ? 'wasm' : 'webgpu' }; },
  };
  const report = await runStreamingSpeechBenchmark({ samples: [clip, { ...clip, id: 'two' }], models, now: () => clock,
    runSample: async ({ audio: input, transcribe }) => {
      const result = await transcribe(input, { vocabulary: [] }); order.push(result.backend);
      return { ...result, firstWordMs: 300, releaseMs: 50, updateCount: 3, revisions: 1, timingValid: true };
    },
  });
  assert.deepEqual(order, ['wasm', 'webgpu', 'webgpu', 'wasm']); assert.equal(calls.length, 6);
  assert(calls.every(row => row[1] === audio.size)); assert(report.prepared.fast.alreadyReady);
  assert.equal(report.warmup.refine.ms, 200); assert(report.completed); assert.equal(report.active, null);
  const summary = summarizeStreamingSpeech(report.runs);
  assert.equal(summary.fast.firstWordMs, 300); assert.equal(summary.fast.wer, .5); assert.equal(summary.refine.wer, 0);
});
test('GPU failure preserves CPU results; interrupted or missing runs cannot improve timing averages', async () => {
  const models = { entries: { fast: {}, refine: {} }, async wait(model) { if (model === 'refine') throw new Error('GPU unavailable'); return {}; },
    async transcribe() { return { text: 'hello world', backend: 'wasm' }; } };
  const report = await runStreamingSpeechBenchmark({ samples: [clip], models,
    runSample: async () => ({ text: 'hello world', firstWordMs: 100, releaseMs: 50, timingValid: false }) });
  assert.match(report.prepared.refine.error, /unavailable/); assert.equal(report.runs[0].refine, undefined);
  const summary = summarizeStreamingSpeech(report.runs);
  assert.equal(summary.fast.count, 1); assert.equal(summary.fast.timedCount, 0); assert.equal(summary.fast.firstWordMs, null);
  assert.equal(summary.fast.wer, 0); assert.equal(summary.refine.wer, null);
  const controller = new AbortController(); let completed = false;
  await assert.rejects(runStreamingSpeechBenchmark({ samples: [clip], models, signal: controller.signal,
    update: state => { completed ||= state.completed; if (state.active) controller.abort(); } }), { name: 'AbortError' });
  assert(!completed);
});
