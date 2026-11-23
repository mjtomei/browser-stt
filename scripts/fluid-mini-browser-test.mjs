// Real Fluid Speech Mini inference. No physical-phone performance claim.
import { chromium, webkit } from '@playwright/test';
import { createServer } from 'vite';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { speechAssets } from './assets.mjs';
const manifest = JSON.parse(await readFile('vendor/stt/fluid-mini.json'));
const native = process.argv.includes('--native');
const isolated = process.env.FLUID_ISOLATED === '1';
const engine = process.argv.includes('--webkit') ? 'webkit' : 'chromium';
const samples = process.env.FLUID_INPUTS ? JSON.parse(await readFile(process.env.FLUID_INPUTS, 'utf8')) : [];
const modelDir = process.env.FLUID_MODEL_DIR || path.resolve('.state/ensemble/models', manifest.directory);
const server = await createServer({ configFile: false, plugins: [{ name: 'fluid-isolation', configureServer(server) {
  server.middlewares.use((_req, res, next) => {
    if (isolated) { res.setHeader('Cross-Origin-Opener-Policy', 'same-origin'); res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp'); }
    next();
  });
} }, speechAssets({ ensemble: true, refinement: false, benchmarks: false }), {
  name: 'fluid-fixtures', configureServer(server) { server.middlewares.use((req, res, next) => {
    if (req.url === '/fluid-test') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Fluid Mini test</title>'); return; }
    const sample = samples.find((_, i) => req.url === '/sample/' + i);
    if (sample) { res.setHeader('Content-Type', 'audio/wav'); createReadStream(sample.audio).on('error', e => res.destroy(e)).pipe(res); return; }
    const file = manifest.files.find(f => req.url === '/model/' + f.sha256);
    if (!file) return next();
    res.setHeader('Content-Length', file.bytes); res.setHeader('Content-Type', 'application/octet-stream');
    createReadStream(path.join(modelDir, file.file)).on('error', e => res.destroy(e)).pipe(res);
  }); },
} ], server: { host: '127.0.0.1', port: 0, watch: null, ...(isolated ? { headers: {
  'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp',
} } : {}) }, optimizeDeps: { include: ['@noble/hashes/sha2.js'] } });
await server.listen();
const browser = await (engine === 'webkit' ? webkit : chromium).launch({ headless: true, executablePath: engine === 'webkit' ? process.env.WEBKIT_PATH : process.env.CHROME_PATH || '/usr/bin/google-chrome', ...(engine === 'chromium' ? { args: ['--disable-gpu'] } : {}) });
const report = { engine, isolated, nativeCache: native, incorrectModuleMime: true, physicalPhone: false, passed: false, errors: [] };
try {
  const page = await browser.newPage(); page.setDefaultTimeout(180000);
  page.on('console', message => { if (['warning', 'error'].includes(message.type()) || message.text().startsWith('Mini setup:')) console.log(message.type(), message.text().slice(0, 1000)); });
  await page.route('**/stt/ort-wasm-simd-threaded.mjs', async route => { const response = await route.fetch(); await route.fulfill({ response, contentType: 'application/octet-stream' }); });
  page.on('pageerror', e => report.errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/fluid-test`);
  report.ready = await page.evaluate(async native => {
    const { EnsembleSpeech, fluidSpeechMini } = await import('/src/ensemble-speech.js');
    const { EnsembleModelStore } = await import('/src/ensemble-cache.js');
    const lookup = new Map(fluidSpeechMini.files.map(f => [f.url, f]));
    const values = new Map(), kv = native ? { get: async key => values.get(key), set: async (key, value) => values.set(key, value) } : undefined;
    const store = new EnsembleModelStore({ kv, fetch: url => fetch('/model/' + lookup.get(url).sha256) });
    let phase;
    window.models = new EnsembleSpeech({ store, modelIds: ['fluid-mini'], verificationDevice: 'test-desktop-browser', changed() {
      const entry = models.entries['fluid-mini'], next = `${entry.state}:${entry.setup.stage}:${entry.setup.component || ''}`;
      if (next !== phase) { phase = next; console.log('Mini setup:', phase); }
    } });
    return models.prepare('fluid-mini');
  }, native);
  console.log('Mini ready', JSON.stringify(report.ready));
  report.capabilities = await page.evaluate(() => ({ isolated: crossOriginIsolated, sharedMemory: typeof SharedArrayBuffer === 'function', cores: navigator.hardwareConcurrency }));
  assert.equal(report.capabilities.isolated, isolated, 'requested response headers reached the test document');
  const threads = report.capabilities.isolated && report.capabilities.sharedMemory ? Math.min(4, report.capabilities.cores) : 1;
  assert.equal(report.ready.threads, threads);
  report.clip = await page.evaluate(async () => {
    const audio = await (await fetch('/stt/ensemble-check.wav')).blob();
    const started = performance.now(), updates = [];
    const result = await models.transcribe('fluid-mini', audio, { onPartial: value => {
      if (value.text) updates.push({ ms: performance.now() - started, text: value.text });
    } });
    return { ...result, partials: updates, firstWordMs: updates[0]?.ms };
  });
  assert.match(report.clip.text.toLowerCase(), /apostle/); assert(report.clip.words.length > 8);
  assert(report.clip.words.every(w => Number.isFinite(w.confidence) && w.text === report.clip.text.slice(w.start, w.end)));
  assert(report.clip.partials.some(p => p.text && p.text !== report.clip.text), 'words arrive before the complete decode');
  assert.match(report.clip.partials[0].text, /^(mr\.?|mister)(\s|$)/i, 'first prefix is a word, not a token fragment');
  console.log('Clip', report.clip.text, report.clip.transcribeMs);
  report.streaming = await page.evaluate(async () => {
    const { EnsembleStream } = await import('/src/ensemble-stream.js');
    const { waveSamples } = await import('/src/speech-audio.js');
    const { pcmChecksum } = await import('/src/pcm-microphone.js');
    const samples = waveSamples(await (await fetch('/stt/ensemble-check.wav')).arrayBuffer());
    const pcm = new Uint8Array(samples.length * 2), view = new DataView(pcm.buffer);
    for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, Math.round(samples[i] * 32768), true);
    const updates = [], started = performance.now();
    const stream = new EnsembleStream({ models, result: r => updates.push({ ms: performance.now() - started, text: r.text, models: r.models }) });
    stream.start(['Pageborne']);
    for (let i = 0; i < pcm.length; i += 3200) { stream.receive(pcm.subarray(i, i + 3200)); await new Promise(r => setTimeout(r, 100)); }
    const released = performance.now(), result = await stream.finish({ kind: 'pcm-stream', bytes: pcm.length, checksum: pcmChecksum(pcm) });
    return { result, firstWordMs: updates[0]?.ms, releaseMs: performance.now() - released, updates };
  });
  assert.deepEqual(report.streaming.result.models, ['fluid-mini']);
  assert.equal(report.streaming.result.model, 'Fluid Speech Mini');
  assert.match(report.streaming.result.text.toLowerCase(), /gospel/);
  assert(report.streaming.updates.length > 1);
  console.log('Stream', report.streaming.firstWordMs, report.streaming.releaseMs, report.streaming.result.text);
  if (samples.length) {
    report.corpus = [];
    const normalized = text => text.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
    for (let i = 0; i < samples.length; i++) {
      const result = await page.evaluate(async i => models.transcribe('fluid-mini', await (await fetch('/sample/' + i)).blob()), i);
      assert.equal(normalized(result.text), normalized(samples[i].nativeText), 'browser/native parity for ' + samples[i].id);
      report.corpus.push({ id: samples[i].id, nativeParity: true, seconds: result.seconds, ms: result.transcribeMs });
    }
    report.longStream = await page.evaluate(async count => {
      const { EnsembleStream } = await import('/src/ensemble-stream.js');
      const { waveSamples } = await import('/src/speech-audio.js');
      const { pcmChecksum } = await import('/src/pcm-microphone.js');
      const clips = [];
      for (let i = 0; i < count; i++) clips.push(waveSamples(await (await fetch('/sample/' + i)).arrayBuffer()));
      const pcm = new Uint8Array(clips.reduce((n, c) => n + c.length, 0) * 2), view = new DataView(pcm.buffer);
      let offset = 0; for (const clip of clips) for (const v of clip) { view.setInt16(offset, Math.round(v * 32768), true); offset += 2; }
      const stream = new EnsembleStream({ models, result() {} }); stream.start();
      for (let i = 0; i < pcm.length; i += 3200) stream.receive(pcm.subarray(i, i + 3200));
      const result = await stream.finish({ kind: 'pcm-stream', bytes: pcm.length, checksum: pcmChecksum(pcm) });
      return { text: result.text, seconds: result.seconds, words: result.words.length, ms: result.transcribeMs };
    }, Math.min(4, samples.length));
    assert(report.longStream.seconds > 30 && report.longStream.words > 70, 'long recording drains across overlapping windows');
    assert(normalized(report.longStream.text).endsWith(normalized(samples[Math.min(4, samples.length) - 1].nativeText).split(' ').slice(-5).join(' ')), 'final words survive the window boundary');
    console.log('Corpus parity and long stream', report.corpus.length, report.longStream.seconds);
  }
  report.cancel = await page.evaluate(async () => {
    const audio = await (await fetch('/stt/ensemble-check.wav')).blob(), cancel = new AbortController();
    const job = models.transcribe('fluid-mini', audio, { signal: cancel.signal });
    setTimeout(() => cancel.abort(), 100);
    let error; try { await job; } catch (e) { error = e.name; }
    const retry = await models.transcribe('fluid-mini', audio);
    return { error, retryText: retry.text };
  });
  assert.equal(report.cancel.error, 'AbortError'); assert.equal(report.cancel.retryText, report.clip.text);
  report.silence = await page.evaluate(async () => {
    const { samplesWave } = await import('/src/speech-audio.js');
    const results = [];
    for (const seconds of [1, 5, 15]) results.push(await models.transcribe('fluid-mini', samplesWave(new Float32Array(seconds * 16000))));
    return results;
  });
  assert(report.silence.every(r => r.text === ''));
  report.cachedReload = await page.evaluate(async () => {
    const store = models.store; models.close(); store.fetch = async () => { throw Error('Network disabled'); };
    const verified = await models.restoreVerification(), ready = await models.prepare('fluid-mini');
    return { verified, ready, bytes: store.stats };
  });
  assert.equal(report.cachedReload.verified, true); assert.equal(report.cachedReload.ready.verification, 'saved');
  assert.deepEqual(report.errors, []); report.passed = true;
} finally {
  await mkdir('test-results', { recursive: true }); await writeFile(process.env.FLUID_REPORT || `test-results/fluid-mini-${engine}${native ? '-native' : ''}.json`, JSON.stringify(report, null, 2));
  await browser.close(); await server.close();
}
