// Actual Tiny inference, including a late PCM flush and retained 15 s segments.
import { chromium, webkit } from '@playwright/test';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const useWebkit = process.argv.includes('--webkit');
const server = await createServer({ configFile: 'demo/vite.config.js', server: { host: '127.0.0.1', port: 0, strictPort: false } }); await server.listen();
const browser = await (useWebkit ? webkit : chromium).launch({ executablePath: useWebkit ? process.env.WEBKIT_PATH : '/usr/bin/google-chrome', headless: true });
const report = { engine: useWebkit ? 'webkit' : 'chromium', physicalPhone: false, passed: false, errors: [] };
try {
  const page = await browser.newPage(); page.on('pageerror', error => report.errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0]);
  Object.assign(report, await page.evaluate(async module => {
    const { ResidentSpeech, SpeechStream, pcmWave, waveSamples } = await import(module);
    const speech = new ResidentSpeech(); await speech.open({ refine: false });
    const samples = waveSamples(await (await fetch('/stt/benchmark/1272-128104-0000.wav')).arrayBuffer());
    const pcm = new Uint8Array(samples.length * 2), view = new DataView(pcm.buffer);
    for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, samples[i] * 32768, true);
    const calls = [], drafts = [], decoded = [];
    const stream = new SpeechStream({ intervalMs: 0, transcribe: async (audio, options) => { calls.push((audio.size - 44) / 32000); const response = await speech.transcribe('fast', audio, options); decoded.push(response.text); return response; }, result: value => drafts.push(value.text) });
    const until = async check => { const start = performance.now(); while (!check()) { if (performance.now() - start > 60000) throw new Error('Timed out waiting for Tiny'); await new Promise(r => setTimeout(r, 20)); } };
    try {
      const wordUpdates = []; const start = performance.now();
      const baseline = await speech.transcribe('fast', pcmWave([pcm]), { onPartial: value => wordUpdates.push({ text: value.text, words: value.words, ms: Math.round(performance.now() - start) }) });
      const wordDoneMs = Math.round(performance.now() - start);
      stream.start(); stream.receive(pcm); await until(() => !stream.job && stream.completedEnd > 0);
      const reused = await stream.finish(pcmWave([pcm])); const reuseCalls = calls.splice(0); drafts.length = 0;
      stream.start(); stream.receive(pcm.subarray(0, pcm.length - 16000)); await until(() => !stream.job && stream.completedEnd > 0);
      const flushed = await stream.finish(pcmWave([pcm])); const flushCalls = calls.splice(0); drafts.length = 0;
      // Repeat the sentence with silence between utterances. The first two
      // chunks settle while recording; finish must only process the last tail.
      const chunk = new Uint8Array(15 * 32000); chunk.set(pcm.subarray(0, chunk.length));
      const long = new Uint8Array(chunk.length * 2 + pcm.length); long.set(chunk); long.set(chunk, chunk.length); long.set(pcm, chunk.length * 2);
      stream.start(); stream.receive(long.subarray(0, chunk.length * 2));
      await until(() => stream.completedEnd === chunk.length * 2 && !stream.job);
      const beforeRelease = calls.length, committedText = stream.committed;
      const drained = await stream.finish(pcmWave([long]));
      const baselineLong = await speech.transcribe('fast', pcmWave([long]));
      const longReport = { text: drained.text, baseline: baselineLong.text, decoded: [...decoded], committedText, calls: [...calls], beforeRelease, words: drained.words };
      calls.length = 0; drafts.length = 0;
      const compact = new Uint8Array((pcm.length + 6400) * 6);
      for (let i = 0; i < 6; i++) compact.set(pcm, i * (pcm.length + 6400));
      stream.start(); stream.receive(compact.subarray(0, 30 * 32000));
      await until(() => stream.completedEnd === 30 * 32000 && !stream.job);
      const compactBefore = calls.length;
      const compactResult = await stream.finish(pcmWave([compact]));
      const compactBaseline = await speech.transcribe('fast', pcmWave([compact]));
      return { wordUpdates, wordDoneMs, baseline: baseline.text, reused: reused.text, reuseCalls, flushed: flushed.text, flushCalls, long: longReport, compact: { text: compactResult.text, baseline: compactBaseline.text, calls, beforeRelease: compactBefore } };
    } finally { stream.cancel(); speech.close(); }
  }, `/@fs${process.cwd()}/src/index.js`));
  assert(report.wordUpdates.length > 4, 'words arrive during inference');
  assert(report.wordUpdates[0].ms < report.wordDoneMs);
  assert(report.wordUpdates.every(value => report.baseline.startsWith(value.text)));
  for (const update of report.wordUpdates) for (const word of update.words) assert.equal(update.text.slice(word.start, word.end), word.text);
  assert.equal(report.reused, report.baseline); assert.equal(report.reuseCalls.length, 1);
  assert.equal(report.flushed, report.baseline); assert.equal(report.flushCalls.length, 2);
  assert.equal(report.long.text, Array(3).fill(report.baseline).join(' '), 'retain all three spoken repetitions; a second model pass is not ground truth');
  assert(report.long.text.startsWith(report.long.committedText));
  assert(report.long.calls.every(seconds => seconds <= 15));
  assert(report.long.calls.slice(report.long.beforeRelease).reduce((a, b) => a + b, 0) < 15);
  assert(report.long.text.endsWith(report.baseline));
  for (const word of report.long.words) assert.equal(report.long.text.slice(word.start, word.end), word.text);
  assert.equal(report.compact.text, Array(6).fill(report.baseline).join(' '), 'retain all six spoken repetitions');
  assert(report.compact.calls.slice(report.compact.beforeRelease).every(seconds => seconds <= 15));
  assert.deepEqual(report.errors, []); report.passed = true;
} finally {
  await mkdir('test-results', { recursive: true }); await writeFile(`test-results/stream-${report.engine}.json`, JSON.stringify(report, null, 2));
  await browser.close(); await server.close();
}
console.log(JSON.stringify({ passed: report.passed, engine: report.engine, baseline: report.baseline, reuseCalls: report.reuseCalls, flushCalls: report.flushCalls, longCalls: report.long.calls }));
