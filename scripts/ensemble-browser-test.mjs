import { chromium, webkit } from '@playwright/test';
import { createServer } from 'vite';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { speechAssets } from './assets.mjs';
const manifest = JSON.parse(await readFile('vendor/stt/ensemble-models.json'));
const engine = process.argv.includes('--webkit') ? 'webkit' : 'chromium';
const server = await createServer({ configFile: false, plugins: [speechAssets({ ensemble: true, refinement: false, benchmarks: false }), { name: 'fixtures', configureServer(server) { server.middlewares.use((req, res, next) => {
  if (req.url === '/ensemble-test') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Ensemble test</title>'); return; }
  if (req.url === '/long.wav') { res.setHeader('Content-Type', 'audio/wav'); createReadStream('.state/ensemble/audio/01-clean-6930-81414.wav').pipe(res); return; }
  if (req.url === '/fixture.wav') { res.setHeader('Content-Type', 'audio/wav'); createReadStream('vendor/stt/phone-benchmark/1272-128104-0000.wav').pipe(res); return; }
  const file = manifest.flatMap(m => m.files.map(f => ({ ...f, directory: m.directory }))).find(f => req.url === '/model/' + f.sha256);
  if (!file) return next();
  res.setHeader('Content-Length', file.bytes); res.setHeader('Content-Type', 'application/octet-stream');
  createReadStream(path.join('.state/ensemble/models', file.directory, file.file)).pipe(res);
}); } }], server: { host: '127.0.0.1', port: 0, watch: null }, optimizeDeps: { include: ['@noble/hashes/sha2.js'] } });
await server.listen();
const browser = await (engine === 'webkit' ? webkit : chromium).launch({ ...(engine === 'chromium' ? { executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome' } : { executablePath: process.env.WEBKIT_PATH }), headless: true });
const report = { engine, physicalPhone: false, passed: false, results: [] };
try {
  const page = await browser.newPage(); page.on('console', m => console.log(m.type(), m.text())); page.on('pageerror', e => console.log('PAGEERROR', e.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/ensemble-test`);
  await page.evaluate(remote => { window.remoteModels = remote; }, process.argv.includes('--remote'));
  await page.evaluate(async () => {
    const { EnsembleSpeech, ensembleModels } = await import('/src/ensemble-speech.js');
    const { EnsembleModelStore } = await import('/src/ensemble-cache.js');
    const lookup = new Map(ensembleModels.flatMap(m => m.files.map(f => [f.url, f])));
    const store = new EnsembleModelStore({ fetch: window.remoteModels ? url => fetch(url, { credentials: 'omit' }) : url => fetch('/model/' + lookup.get(url).sha256) });
    window.models = new EnsembleSpeech({ store, changed: () => console.log(JSON.stringify(Object.fromEntries(Object.entries(window.models?.entries || {}).map(([id, e]) => [id, { state: e.state, progress: e.progress }])))) });
  });
  for (const model of manifest) {
    const ready = await page.evaluate(id => window.models.prepare(id), model.id); console.log('READY', model.id, ready);
    const result = await page.evaluate(async id => {
      const audio = await (await fetch('/fixture.wav')).blob();
      return models.transcribe(id, audio, { vocabulary: ['Northanger', 'Abbey', 'Jane Austen'], onPartial: r => console.log('partial', id, r.text) });
    }, model.id);
    console.log('RESULT', model.id, result.text, result.transcribeMs); assert(result.text.length > 25); assert(result.words.length > 8); assert(result.words.every(w => Number.isFinite(w.confidence)));
    report.results.push({ id: model.id, ready, result });
  }
  report.streaming = await page.evaluate(async () => {
    const { EnsembleStream } = await import('/src/ensemble-stream.js');
    const { waveSamples } = await import('/src/speech-audio.js');
    const { pcmChecksum } = await import('/src/pcm-microphone.js');
    const samples = waveSamples(await (await fetch('/fixture.wav')).arrayBuffer());
    const pcm = new Uint8Array(samples.length * 2), view = new DataView(pcm.buffer);
    for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, samples[i] * 32768, true);
    const updates = [], started = performance.now();
    const stream = new EnsembleStream({ models, result: r => updates.push({ ms: performance.now() - started, text: r.text, models: r.models }), failure: e => { throw e; } });
    stream.start(['Quilter']);
    for (let i = 0; i < pcm.length; i += 3200) { stream.receive(pcm.subarray(i, i + 3200)); await new Promise(r => setTimeout(r, 100)); }
    const released = performance.now(), result = await stream.finish({ kind: 'pcm-stream', bytes: pcm.length, checksum: pcmChecksum(pcm) });
    return { result, firstWordMs: updates[0]?.ms, releaseMs: performance.now() - released, updates };
  });
  console.log('STREAM', report.streaming.firstWordMs, report.streaming.releaseMs, report.streaming.result.text);
  assert(report.streaming.firstWordMs < 5855); assert.equal(report.streaming.result.models.length, 3);
  if (process.argv.includes('--long')) {
    report.long = await page.evaluate(async () => {
      const { EnsembleStream } = await import('/src/ensemble-stream.js');
      const { waveSamples } = await import('/src/speech-audio.js');
      const { pcmChecksum } = await import('/src/pcm-microphone.js');
      const pcm = new Uint8Array(await (await fetch('/long.wav')).arrayBuffer()).slice(44); // Fixture: PCM16 mono 16 kHz, standard 44-byte WAV header.
      const started = performance.now(), updates = [], stream = new EnsembleStream({ models, result: r => updates.push({ ms: performance.now() - started, words: r.words.length, text: r.text }) });
      stream.start(['Northanger', 'Abbey', 'Catherine', 'Tilney']);
      for (let i = 0; i < pcm.length; i += 3200) { stream.receive(pcm.subarray(i, i + 3200)); await new Promise(r => setTimeout(r, 100)); }
      const released = performance.now(), result = await stream.finish({ kind: 'pcm-stream', bytes: pcm.length, checksum: pcmChecksum(pcm) });
      return { duration: pcm.length / 32000, firstWordMs: updates[0]?.ms, releaseMs: performance.now() - released, result, updates };
    });
    console.log('LONG', report.long.duration, report.long.firstWordMs, report.long.releaseMs, report.long.result.text);
    assert.equal(report.long.result.models.length, 3); assert(report.long.result.words.length > 180);
  }
  report.cachedReload = await page.evaluate(async () => {
    const store = models.store; models.close(); store.fetch = async () => { throw Error('Network disabled for cached reload'); };
    const loaded = await models.open(); if (loaded.some(r => r.status !== 'fulfilled')) throw Error('Cached reload failed');
    return { ready: Object.keys(models.entries), bytes: store.stats };
  });
  report.passed = true;
} finally {
  await mkdir('test-results', { recursive: true }); await writeFile(`test-results/ensemble-${engine}.json`, JSON.stringify(report, null, 2));
  await browser.close(); await server.close();
}
