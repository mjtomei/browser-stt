// Actual ensemble runtimes and inference, with verified local model fixtures
// standing in for saved phone files. Linux browser-process PSS, not iPhone RAM.
import { chromium, webkit } from '@playwright/test';
import { createServer } from 'vite';
import { createReadStream, existsSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import path from 'node:path';
import { speechAssets } from './assets.mjs';

const useWebkit = process.argv.includes('--webkit');
const nativeCache = process.argv.includes('--native-cache');
const moonshineFirst = process.argv.includes('--moonshine-first');
const label = process.argv.find(v => v.startsWith('--label='))?.slice(8) || 'current';
const workerRoot = process.argv.find(v => v.startsWith('--worker-root='))?.slice(14);
const manifests = JSON.parse(await readFile('vendor/stt/ensemble-models.json'));
const files = manifests.flatMap(m => m.files.filter(f => f.url).map(f => ({ ...f, path: path.resolve('.state/ensemble/models', m.directory, f.file) })));
for (const f of files) {
  const bytes = await readFile(f.path);
  assert.equal(bytes.length, f.bytes); assert.equal(createHash('sha256').update(bytes).digest('hex'), f.sha256);
}
const server = await createServer({ configFile: false, plugins: [{
  name: 'baseline-worker', configureServer(server) { server.middlewares.use((req, res, next) => {
    if (!workerRoot || !req.url.startsWith('/stt/')) return next();
    const root = path.resolve(workerRoot), file = path.resolve(root, req.url.slice(5));
    if (!file.startsWith(root + path.sep) || !existsSync(file)) return next();
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream');
    createReadStream(file).pipe(res);
  }); },
}, speechAssets({ ensemble: true, refinement: false, benchmarks: false }), {
  name: 'memory-fixtures', configureServer(server) { server.middlewares.use((req, res, next) => {
    if (req.url === '/probe') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Ensemble preparation</title>'); return; }
    const file = files.find(f => req.url === '/model/' + f.sha256); if (!file) return next();
    res.setHeader('Content-Type', 'application/octet-stream'); res.setHeader('Content-Length', file.bytes);
    createReadStream(file.path, { highWaterMark: 24000 }).pipe(res);
  }); },
}], server: { host: '127.0.0.1', port: 0, watch: null }, optimizeDeps: { include: ['@noble/hashes/sha2.js'] } });
await server.listen();
async function memory(pid = process.pid) {
  const children = await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8').catch(() => ''); let total = 0;
  for (const child of children.trim().split(/\s+/).filter(Boolean)) {
    const text = await readFile(`/proc/${child}/smaps_rollup`, 'utf8').catch(() => '');
    total += Number(text.match(/^Pss:\s+(\d+)/m)?.[1] || 0) + await memory(child);
  }
  return total;
}
const order = moonshineFirst ? [...manifests].sort((a, b) => Number(b.id === 'moonshine') - Number(a.id === 'moonshine')) : manifests;
const report = { label, engine: useWebkit ? 'webkit' : 'chromium', physicalPhone: false, actualModels: true, order: order.map(m => m.id), storage: nativeCache ? 'native-cache format through a simulated string bridge' : 'verified local HTTP fixtures', passed: false, models: [] };
const browser = await (useWebkit ? webkit : chromium).launch({ headless: true, executablePath: useWebkit ? process.env.WEBKIT_PATH : '/usr/bin/google-chrome' });
try {
  const page = await browser.newPage(); await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/probe`);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  if (nativeCache) {
    const values = new Map(), prefix = 'pageborne:models:v1:';
    for (const file of files) {
      const bytes = await readFile(file.path), id = 'fixture-' + file.sha256;
      for (let offset = 0; offset < bytes.length; offset += 24000) values.set(`${prefix}${id}:${offset / 24000}`, bytes.subarray(offset, offset + 24000).toString('base64'));
      values.set(prefix + file.sha256, JSON.stringify({ id, chunks: Math.ceil(bytes.length / 24000), headers: { 'content-length': String(file.bytes), 'content-type': 'application/octet-stream' } }));
    }
    await page.exposeFunction('__modelKV', ({ key, value }) => value === undefined ? values.get(key) || '' : (values.set(key, value), true));
  }
  await page.evaluate(async nativeCache => {
    const { EnsembleSpeech } = await import('/src/ensemble-speech.js');
    const { EnsembleModelStore } = await import('/src/ensemble-cache.js');
    const store = nativeCache ? new EnsembleModelStore({ kv: { get: key => __modelKV({ key }), set: (key, value) => __modelKV({ key, value }) }, fetch: () => { throw Error('Cached-only probe must not download'); } }) : {
      ensure: async () => {}, beginPreparation: async () => async () => {},
      read: file => file.text !== undefined ? Promise.resolve(new Response(file.text)) : fetch('/model/' + file.sha256),
    };
    window.models = new EnsembleSpeech({ store });
  }, nativeCache);
  report.baselinePssMiB = Math.round(await memory() / 1024);
  for (const model of order) {
    const samples = []; let running = true;
    const monitor = (async () => { while (running) { samples.push(await memory()); await new Promise(r => setTimeout(r, 30)); } })();
    let result;
    try {
      result = await page.evaluate(async id => {
        const ready = await models.prepare(id);
        const audio = await (await fetch('/stt/ensemble-check.wav')).blob();
        const result = await models.transcribe(id, audio, { vocabulary: ['Quilter'] });
        return { ready, transcript: result.text, transcribeMs: result.transcribeMs };
      }, model.id);
    } finally { running = false; await monitor; }
    assert.equal(result.ready.verified, true); assert.match(result.transcript, /welcome his gospel/i);
    const measured = { id: model.id, peakPssMiB: Math.round(Math.max(...samples) / 1024), residentPssMiB: Math.round(await memory() / 1024), ...result };
    report.models.push(measured); console.log(JSON.stringify(measured));
  }
  assert.deepEqual(errors, []); report.passed = true;
} finally {
  await mkdir('test-results', { recursive: true }); await writeFile(`test-results/ensemble-preparation-${label}-${report.engine}.json`, JSON.stringify(report, null, 2));
  await browser.close(); await server.close();
}
