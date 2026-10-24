// Real production WASM decoders. Reference text is used only for scoring/fixture
// selection; hints come from the study's disjoint same-chapter excerpts.
import { chromium, webkit } from '@playwright/test';
import { createServer } from 'vite';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { speechAssets } from './assets.mjs';
import { scoreSpeech, benchmarkWords } from '../src/speech-benchmark.js';
import { voteSpeech } from '../src/ensemble-vote.js';
const engine = process.argv.includes('--webkit') ? 'webkit' : 'chromium';
const label = process.argv.find(a => a.startsWith('--label='))?.slice(8) || 'candidate';
const manifest = JSON.parse(await readFile('vendor/stt/ensemble-models.json'));
const inputs = JSON.parse(await readFile('benchmarks/ensemble-inputs.json'));
const cases = JSON.parse(await readFile('benchmarks/window-study-expanded-manifest.json')).cases;
const fixtures = inputs.map((input, index) => {
  let offset = 0;
  const samples = cases[index].samples.map(s => { const sample = { ...s, offset }; offset += s.seconds; return sample; });
  const keys = new Set(input.vocabulary.flatMap(benchmarkWords));
  const eligible = samples.filter(s => s.seconds >= 3 && s.seconds <= 12);
  const sample = process.argv.includes('--terms') ? eligible.sort((a, b) => benchmarkWords(b.reference).filter(w => keys.has(w)).length - benchmarkWords(a.reference).filter(w => keys.has(w)).length)[0]
    : eligible.find(s => benchmarkWords(s.reference).some(w => keys.has(w))) || eligible[0];
  return { ...sample, offset: 0, case: input.id, file: path.join('.state/expanded-window-study', sample.file), vocabulary: input.vocabulary };
});
const legacy = process.argv.includes('--legacy-stream') ? new Map(await Promise.all(['speech-stream', 'ensemble-stream', 'ensemble-vote'].map(async name => [`/src/${name}.js`, await readFile(`benchmarks/baselines/9860dc0/${name}.js`, 'utf8')])) ) : new Map();
const server = await createServer({ configFile: false, plugins: [{ name: 'legacy-stream', enforce: 'pre', transform(code, id) { for (const [file, source] of legacy) if (id.endsWith(file)) return source; } }, speechAssets({ ensemble: true, refinement: false, benchmarks: false }), { name: 'fixtures', configureServer(s) { s.middlewares.use((req, res, next) => {
  if (req.url === '/trial') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Dictation benchmark</title>'); return; }
  const fixture = fixtures.find(f => req.url === '/audio/' + f.id);
  const model = manifest.flatMap(m => m.files.map(f => ({ ...f, directory: m.directory }))).find(f => req.url === '/model/' + f.sha256);
  if (!fixture && !model) return next();
  res.setHeader('Content-Type', 'application/octet-stream');
  createReadStream(fixture ? fixture.file : path.join('.state/ensemble/models', model.directory, model.file)).pipe(res);
}); } }], server: { host: '127.0.0.1', port: 0, watch: null } });
await server.listen();
const browser = await (engine === 'webkit' ? webkit : chromium).launch({ executablePath: engine === 'webkit' ? process.env.WEBKIT_PATH : process.env.CHROME_PATH || '/usr/bin/google-chrome' });
const report = { engine, label, physicalPhone: false, createdAt: new Date().toISOString(), latency: [], vocabulary: [] };
try {
  const page = await browser.newPage();
  page.on('pageerror', e => console.error(e.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/trial`);
  await page.evaluate(async () => {
    const { EnsembleSpeech, ensembleModels } = await import('/src/ensemble-speech.js');
    const { EnsembleModelStore } = await import('/src/ensemble-cache.js');
    const lookup = new Map(ensembleModels.flatMap(m => m.files.map(f => [f.url, f.sha256])));
    window.models = new EnsembleSpeech({ verificationDevice: 'benchmark', store: new EnsembleModelStore({ fetch: url => fetch('/model/' + lookup.get(url)) }) });
    const loaded = await models.open(); if (loaded.some(r => r.status !== 'fulfilled')) throw Error(JSON.stringify(loaded));
  });
  const latencyFixtures = [{ id: 'check', seconds: 5.855, offset: 0, vocabulary: ['Quilter'], reference: 'MISTER QUILTER IS THE APOSTLE OF THE MIDDLE CLASSES AND WE ARE GLAD TO WELCOME HIS GOSPEL' }, ...fixtures.slice(0, 2)];
  for (const cold of process.argv.includes('--vocabulary-only') ? [] : [false, true]) for (const fixture of cold ? latencyFixtures.slice(0, 1) : latencyFixtures) {
    const result = await page.evaluate(async ({ fixture, cold }) => {
      const { EnsembleStream } = await import('/src/ensemble-stream.js');
      const { waveSamples } = await import('/src/speech-audio.js');
      const { pcmChecksum } = await import('/src/pcm-microphone.js');
      const samples = waveSamples(await (await fetch(fixture.id === 'check' ? '/stt/ensemble-check.wav' : '/audio/' + fixture.id)).arrayBuffer()).slice(Math.round(fixture.offset * 16000), Math.round((fixture.offset + fixture.seconds) * 16000));
      const pcm = new Uint8Array(samples.length * 2), view = new DataView(pcm.buffer);
      for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, samples[i] * 32768, true);
      if (cold) models.close();
      const updates = [], calls = [], started = performance.now(); let maxFeedLateMs = 0;
      const preparing = cold ? models.open() : Promise.resolve();
      const stream = new EnsembleStream({ models: { entries: models.entries, prepare: (id, options) => models.prepare(id, options), transcribe: async (id, audio, options) => {
        const at = performance.now(); const result = await models.transcribe(id, audio, options);
        calls.push({ id, ms: performance.now() - at, audioMs: (audio.size - 44) / 32 }); return result;
      } }, result: r => updates.push({ ms: performance.now() - started, text: r.text, models: r.models }) });
      stream.start(fixture.vocabulary);
      for (let i = 0; i < pcm.length; i += 1600) {
        const end = Math.min(pcm.length, i + 1600), due = end / 32;
        await new Promise(r => setTimeout(r, Math.max(0, due - (performance.now() - started))));
        maxFeedLateMs = Math.max(maxFeedLateMs, performance.now() - started - due);
        stream.receive(pcm.subarray(i, end));
      }
      const released = performance.now();
      const result = await stream.finish({ kind: 'pcm-stream', bytes: pcm.length, checksum: pcmChecksum(pcm) });
      await preparing;
      return { firstWordMs: updates[0]?.ms, releaseMs: performance.now() - released, maxFeedLateMs, result, updates, calls };
    }, { fixture, cold });
    report.latency.push({ id: fixture.id, cold, ...result });
    report.latency.at(-1).firstCorrectWordMs = result.updates.find(u => benchmarkWords(u.text)[0] === benchmarkWords(fixture.reference)[0])?.ms;
    assert(result.maxFeedLateMs < 500, 'audio delivery invalidates timing');
    console.log('LATENCY', fixture.id, cold ? 'cold' : 'warm', Math.round(result.firstWordMs), result.result.text);
  }
  if (!process.argv.includes('--latency-only')) for (const fixture of fixtures) {
    for (const hints of [false, true]) {
      const hypotheses = await page.evaluate(async ({ fixture, hints }) => {
        const { waveSamples, samplesWave } = await import('/src/speech-audio.js');
        const samples = waveSamples(await (await fetch('/audio/' + fixture.id)).arrayBuffer()).slice(Math.round(fixture.offset * 16000), Math.round((fixture.offset + fixture.seconds) * 16000));
        const audio = samplesWave(samples), results = [];
        for (const id of Object.keys(models.entries)) results.push({ id, ...await models.transcribe(id, audio, { vocabulary: hints ? fixture.vocabulary : [] }) });
        return results;
      }, { fixture, hints });
      const baseline = voteSpeech(hypotheses, { final: true });
      const weighted = voteSpeech(hypotheses, { final: true, vocabulary: hints ? fixture.vocabulary : [] });
      const score = text => { const s = scoreSpeech(fixture.reference, text); return { errors: s.errors, words: s.referenceWords, wer: s.wer }; };
      const row = { id: fixture.id, hints, reference: fixture.reference, vocabulary: fixture.vocabulary, hypotheses: hypotheses.map(h => ({ ...h, score: score(h.text) })), baseline: { ...baseline, score: score(baseline.text) }, weighted: { ...weighted, score: score(weighted.text) } };
      report.vocabulary.push(row);
      console.log('VOCAB', fixture.id, hints, JSON.stringify(row.hypotheses.map(h => ({ id: h.id, errors: h.score.errors, ms: Math.round(h.transcribeMs) }))), baseline.text);
      await mkdir('test-results/dictation', { recursive: true }); await writeFile(`test-results/dictation/${label}-${engine}.json`, JSON.stringify(report, null, 2));
    }
  }
  report.passed = true;
} finally {
  await mkdir('test-results/dictation', { recursive: true }); await writeFile(`test-results/dictation/${label}-${engine}.json`, JSON.stringify(report, null, 2));
  await browser.close(); await server.close();
}
