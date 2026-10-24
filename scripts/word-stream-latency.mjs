// Real Tiny inference with paced PCM; desktop timing, not physical phone/BLE.
import { chromium, webkit } from '@playwright/test';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const useWebkit = process.argv.includes('--webkit');
const vite = await createServer({ configFile: 'demo/vite.config.js', server: { host: '127.0.0.1', port: 0, strictPort: false } }); await vite.listen();
const browser = await (useWebkit ? webkit : chromium).launch({ executablePath: useWebkit ? process.env.WEBKIT_PATH : '/usr/bin/google-chrome', headless: true });
const report = { engine: useWebkit ? 'webkit' : 'chromium', physicalPhone: false, passed: false, errors: [] };
try {
  const page = await browser.newPage(); page.on('pageerror', error => report.errors.push(error.message)); await page.goto(vite.resolvedUrls.local[0]);
  Object.assign(report, await page.evaluate(async module => {
    const { ResidentSpeech, SpeechStream, pcmWave, waveSamples } = await import(module);
    const speech = new ResidentSpeech(); await speech.open({ refine: false });
    const samples = waveSamples(await (await fetch('/stt/benchmark/1272-128104-0000.wav')).arrayBuffer());
    const pcm = new Uint8Array(samples.length * 2), view = new DataView(pcm.buffer);
    for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, samples[i] * 32768, true);
    const baseline = await speech.transcribe('fast', pcmWave([pcm]));
    const runs = [];
    try {
      for (const previous of [true, false]) {
        const updates = []; let calls = 0, decodeMs = 0; const start = performance.now();
        const stream = new SpeechStream({ ...(previous ? { minAudioMs: 1250, intervalMs: 750 } : {}),
          transcribe: async (audio, options) => { calls++; const value = await speech.transcribe('fast', audio, previous ? { ...options, onPartial: undefined } : options); decodeMs += value.transcribeMs; return value; },
          result: value => { if (updates.at(-1)?.text !== value.text) updates.push({ text: value.text, ms: Math.round(performance.now() - start) }); },
        });
        stream.start();
        for (let offset = 0; offset < pcm.length; offset += 3200) {
          const end = Math.min(offset + 3200, pcm.length);
          await new Promise(resolve => setTimeout(resolve, Math.max(0, end / 32 - (performance.now() - start))));
          stream.receive(pcm.subarray(offset, end));
        }
        const released = performance.now(); const final = await stream.finish(pcmWave([pcm]));
        runs.push({ previous, updates, calls, decodeMs, releaseMs: Math.round(performance.now() - released), text: final.text });
      }
      return { baseline: baseline.text, runs };
    } finally { speech.close(); }
  }, `/@fs${process.cwd()}/src/index.js`));
  for (const run of report.runs) assert.equal(run.text, report.baseline);
  assert(report.runs[1].updates[0].ms < report.runs[0].updates[0].ms);
  assert(report.runs[1].updates.length > report.runs[0].updates.length);
  assert.deepEqual(report.errors, []); report.passed = true;
} finally { await mkdir('test-results', { recursive: true }); await writeFile(`test-results/word-stream-latency-${report.engine}.json`, JSON.stringify(report, null, 2)); await browser.close(); await vite.close(); }
console.log(JSON.stringify({ engine: report.engine, passed: report.passed, runs: report.runs.map(run => ({ previous: run.previous, firstWordMs: run.updates[0]?.ms, updates: run.updates.length, calls: run.calls, decodeMs: run.decodeMs, releaseMs: run.releaseMs })) }));
