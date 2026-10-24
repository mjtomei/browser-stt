// Real Tiny CPU with paced, multi-sentence audio and pauses. Desktop only;
// PCM/recognition are real, microphone/BLE transport is not exercised here.
import { chromium, webkit } from '@playwright/test';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const useWebkit = process.argv.includes('--webkit');
const server = await createServer({ configFile: 'demo/vite.config.js', server: { host: '127.0.0.1', port: 0, strictPort: false } }); await server.listen();
const browser = await (useWebkit ? webkit : chromium).launch({ executablePath: useWebkit ? process.env.WEBKIT_PATH : '/usr/bin/google-chrome', headless: true });
const report = { engine: useWebkit ? 'webkit' : 'chromium', physicalPhone: false, passed: false, errors: [] };
try {
  const page = await browser.newPage(); page.on('pageerror', error => report.errors.push(error.message)); await page.goto(server.resolvedUrls.local[0]);
  Object.assign(report, await page.evaluate(async module => {
    const { ResidentSpeech, SpeechStream, pcmWave, waveSamples } = await import(module);
    const speech = new ResidentSpeech({ refinement: false }); await speech.open({ refine: false });
    const files = ['1272-128104-0000', '1272-128104-0001', '1272-128104-0002', '2961-960-0003'];
    const clips = [];
    for (const file of files) {
      const samples = waveSamples(await (await fetch(`/stt/benchmark/${file}.wav`)).arrayBuffer());
      const bytes = new Uint8Array(samples.length * 2), view = new DataView(bytes.buffer);
      for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, samples[i] * 32768, true);
      clips.push(bytes);
    }
    const join = parts => { const pcm = new Uint8Array(parts.reduce((n, part) => n + part.length, 0)); let at = 0; for (const part of parts) { pcm.set(part, at); at += part.length; } return pcm; };
    const runs = [];
    try {
      // Normal paced capture spans several window boundaries. Slow/coalesced
      // delivery models an inference backlog and final microphone flush.
      for (const paced of [true, false]) {
        const pcm = join(clips.flatMap(clip => [clip, new Uint8Array(paced ? 19200 : 64000)]));
        const calls = [], updates = [], checkpoints = [], lost = []; const start = performance.now(); let pinned = '';
        const stream = new SpeechStream({ transcribe: async (audio, options) => {
          const call = { start: stream.offset / 32000, end: stream.lastEnd / 32000 }; calls.push(call);
          const value = await speech.transcribe('fast', audio, options); call.text = value.text; return value;
        }, result: value => {
          if (pinned && !value.text.startsWith(pinned)) lost.push({ pinned, text: value.text });
          if (stream.committed && stream.committed !== pinned) { pinned = stream.committed; checkpoints.push({ text: pinned, seconds: stream.offset / 32000 }); }
          if (updates.at(-1)?.text !== value.text) updates.push({ text: value.text, ms: Math.round(performance.now() - start) });
        } });
        try {
          stream.start();
          if (paced) {
            for (let offset = 0; offset < pcm.length; offset += 3200) {
              const end = Math.min(pcm.length, offset + 3200);
              await new Promise(resolve => setTimeout(resolve, Math.max(0, end / 32 - (performance.now() - start))));
              stream.receive(pcm.subarray(offset, end));
            }
          } else stream.receive(pcm.subarray(0, 30 * 32000));
          const released = performance.now(), value = await stream.finish(pcmWave([pcm]));
          runs.push({ paced, seconds: pcm.length / 32000, text: value.text, releaseMs: Math.round(performance.now() - released), calls, checkpoints, updates, lost,
            validConfidenceOffsets: value.words.every(word => value.text.slice(word.start, word.end) === word.text) });
        } finally { stream.cancel(); }
      }
      return { files, runs };
    } finally { speech.close(); }
  }, `/@fs${process.cwd()}/src/index.js`));
  for (const run of report.runs) {
    assert.match(run.text, /^Mr\.? Quilter is the apostle/i);
    for (const anchor of ['less interesting than his matter', 'festive season', 'most readily to the mind', 'absorbed in his theology', 'not understood by them at all']) assert(run.text.toLowerCase().includes(anchor), `Lost ${anchor}: ${run.text}`);
    assert.deepEqual(run.lost, []); assert(run.validConfidenceOffsets);
    assert(run.checkpoints.length >= 3);
    assert(run.checkpoints[0].seconds < 10, 'first phrase commits before the old 15-second boundary');
    assert(run.calls.every(call => call.end > call.start && call.end - call.start <= 15.001));
  }
  assert.deepEqual(report.errors, []); report.passed = true;
} finally {
  await mkdir('test-results', { recursive: true }); await writeFile(`test-results/long-stream-${report.engine}.json`, JSON.stringify(report, null, 2));
  await browser.close(); await server.close();
}
console.log(JSON.stringify({ engine: report.engine, passed: report.passed, runs: report.runs.map(run => ({ paced: run.paced, seconds: run.seconds, releaseMs: run.releaseMs, text: run.text, checkpoints: run.checkpoints.length })) }));
