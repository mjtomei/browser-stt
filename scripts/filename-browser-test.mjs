// Focused synthetic-speech diagnostic, not a human dictation accuracy benchmark.
// Requires espeak-ng (or ESPEAK_PATH), built workers and local ensemble fixtures.
import { chromium, webkit } from '@playwright/test';
import { createServer } from 'vite';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { speechAssets } from './assets.mjs';

const cases = [
  ['Please open todo dot txt.', 'todo.txt'],
  ['Please read agents dot md.', 'AGENTS.md'],
  ['Please open to do dot tee ex tee.', 'todo.txt'],
  ['Please read agents dot em dee.', 'AGENTS.md'],
  ['Please open read me dot em dee.', 'README.md'],
  ['Please edit speech underscore you eye dot jay ess.', 'speech_ui.js'],
  ['Please check server config dot tee ess.', 'serverConfig.ts'],
  ['Please read report dot pee dee eff.', 'report.pdf'],
  ['Please use archive dot tar dot gee zee.', 'archive.tar.gz'],
  ['Compute the dot product and then read the next paragraph.', null],
];
const filenames = ['todo.txt', 'AGENTS.md', 'README.md', 'speech_ui.js', 'serverConfig.ts', 'archive.tar.gz'];
const directory = '.state/filename-audio'; await mkdir(directory, { recursive: true });
for (const [i, [text]] of cases.entries()) execFileSync(process.env.ESPEAK_PATH || 'espeak-ng', ['-v', 'en-us', '-s', '145', '-w', `${directory}/${i}.wav`, text]);
const manifest = JSON.parse(await readFile('vendor/stt/ensemble-models.json'));
const server = await createServer({ configFile: false, plugins: [speechAssets({ ensemble: true, refinement: false, benchmarks: false }), {
  name: 'filename-fixtures', configureServer(server) { server.middlewares.use((req, res, next) => {
    if (req.url === '/test') { res.setHeader('Content-Type', 'text/html'); return res.end('<!doctype html><title>Filename speech</title>'); }
    const sample = /^\/audio\/(\d+)$/.exec(req.url);
    if (sample && Number(sample[1]) < cases.length) { res.setHeader('Content-Type', 'audio/wav'); return createReadStream(`${directory}/${sample[1]}.wav`).pipe(res); }
    const file = manifest.flatMap(m => m.files.map(f => ({ ...f, directory: m.directory }))).find(f => req.url === '/model/' + f.sha256);
    if (!file) return next();
    res.setHeader('Content-Length', file.bytes); createReadStream(path.join('.state/ensemble/models', file.directory, file.file)).pipe(res);
  }); },
}], server: { host: '127.0.0.1', port: 0, watch: null } });
await server.listen();
const engine = process.argv.includes('--webkit') ? webkit : chromium;
const browser = await engine.launch({ executablePath: engine === chromium ? process.env.CHROME_PATH || '/usr/bin/google-chrome' : process.env.WEBKIT_PATH, headless: true });
const report = { engine: engine.name(), syntheticVoice: 'espeak-ng en-us, 145 wpm', physicalPhone: false, cases: [] };
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/test`);
  await page.evaluate(async () => {
    const { EnsembleSpeech, ensembleModels } = await import('/src/ensemble-speech.js');
    const { EnsembleModelStore } = await import('/src/ensemble-cache.js');
    const lookup = new Map(ensembleModels.flatMap(m => m.files.map(f => [f.url, f])));
    window.models = new EnsembleSpeech({ store: new EnsembleModelStore({ fetch: url => fetch('/model/' + lookup.get(url).sha256) }) });
    const ready = await models.open(); if (ready.some(r => r.status !== 'fulfilled')) throw Error('Real model preparation failed');
  });
  for (const [index, [spoken, expected]] of cases.entries()) {
    const result = await page.evaluate(async ({ index, filenames }) => {
      const { filenameVocabulary, formatSpokenFilenames } = await import('/src/speech-filenames.js');
      const { voteSpeech } = await import('/src/ensemble-vote.js');
      const { normalizeRecording } = await import('/src/speech-audio.js');
      const audio = await normalizeRecording(await (await fetch('/audio/' + index)).blob());
      const runs = [];
      for (const vocabulary of [[], filenameVocabulary(filenames)]) {
        const hypotheses = [];
        for (const id of Object.keys(models.entries)) hypotheses.push({ id, ...await models.transcribe(id, audio, { vocabulary }) });
        const raw = voteSpeech(hypotheses, { final: true, vocabulary, ...(vocabulary.length ? { filenames } : {}) });
        const formatted = formatSpokenFilenames(raw, filenames);
        if (!formatted.words.every(w => formatted.text.slice(w.start, w.end) === w.text)) throw Error('Invalid confidence offsets');
        runs.push({ hypotheses: hypotheses.map(h => ({ id: h.id, text: h.text })), raw: raw.text, formatted: formatted.text });
      }
      return { baseline: runs[0], hinted: runs[1] };
    }, { index, filenames });
    report.cases.push({ spoken, expected, ...result });
    console.log(JSON.stringify(report.cases.at(-1)));
    if (!expected) assert.equal(result.hinted.formatted, result.hinted.raw, 'ordinary dot-product prose must not be rewritten');
  }
  report.exactFilenames = Object.fromEntries(['baseline', 'hinted'].map(mode => [mode, report.cases.filter(c => c.expected && c[mode][mode === 'baseline' ? 'raw' : 'formatted'].includes(c.expected)).length]));
  report.totalFilenames = cases.filter(c => c[1]).length;
} finally {
  await mkdir('test-results', { recursive: true }); await writeFile(`test-results/filenames-${engine.name()}.json`, JSON.stringify(report, null, 2));
  await browser.close(); await server.close();
}
console.log(JSON.stringify({ exactFilenames: report.exactFilenames, total: report.totalFilenames }));
