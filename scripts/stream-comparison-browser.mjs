// Actual streaming inference. --cpu is an explicit Small CPU correctness run,
// not a GPU/phone performance measurement. Never changes production backends.
import { chromium, webkit } from '@playwright/test';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { speechDownloads } from '../src/speech-download-config.js';
const cpu = process.argv.includes('--cpu'), useWebkit = process.argv.includes('--webkit');
const assets = process.env.BROWSER_STT_CACHE || '.state/stt-assets';
const vite = await createServer({ configFile: 'demo/vite.config.js', server: { host: '127.0.0.1', port: 0, strictPort: false,
  fs: { allow: [process.cwd(), assets] } } }); await vite.listen();
const origin = vite.resolvedUrls.local[0];
const browser = await (useWebkit ? webkit : chromium).launch({ headless: true,
  executablePath: useWebkit ? process.env.WEBKIT_PATH : '/usr/bin/google-chrome',
  ...(!cpu && !useWebkit ? { args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=vulkan', '--enable-features=Vulkan', '--disable-vulkan-surface', '--disable-gpu-compositing'],
    env: { ...process.env, VK_ICD_FILENAMES: '/usr/share/vulkan/icd.d/nvidia_icd.json' } } : {}) });
const report = { passed: false, actualModels: true, physicalPhone: false, engine: useWebkit ? 'webkit' : 'chromium',
  smallCpuOverride: cpu, errors: [] };
try {
  const page = await browser.newPage(); page.on('pageerror', error => report.errors.push(error.message));
  await page.route('**/speech-worker.js', async route => {
    const response = await route.fetch();
    const files = speechDownloads.map(file => ({ url: file.url, local: new URL(`/@fs${path.join(assets, 'whisper-small.en', file.file)}`, origin).href }));
    await route.fulfill({ response, body: await response.text() + `
      const originalFetch = self.fetch.bind(self), files = ${JSON.stringify(files)};
      self.fetch = (url, options) => originalFetch(files.find(file => file.url === String(url))?.local || url, options);
      const dispatch = self.onmessage; self.onmessage = event => { if (${cpu} && event.data.model === 'refine') event.data.backend = 'wasm'; dispatch(event); };` });
  });
  await page.goto(origin);
  report.comparison = await page.evaluate(async module => {
    const { ResidentSpeech, runStreamingSpeechBenchmark } = await import(module);
    const models = new ResidentSpeech();
    try {
      return await runStreamingSpeechBenchmark({ models, samples: [{ id: 'librispeech', label: 'LibriSpeech 5.855 s',
        reference: 'MISTER QUILTER IS THE APOSTLE OF THE MIDDLE CLASSES AND WE ARE GLAD TO WELCOME HIS GOSPEL',
        audio: async () => (await fetch('/stt/benchmark/1272-128104-0000.wav')).blob() }] });
    } finally { models.close(); }
  }, `/@fs${process.cwd()}/src/index.js`);
  for (const model of cpu || report.comparison.runs[0].refine ? ['fast', 'refine'] : ['fast']) {
    const result = report.comparison.runs[0][model];
    assert(result && !result.error, JSON.stringify(report.comparison));
    assert(result.text.trim()); assert(result.updateCount > 1); assert(result.firstWordMs > 0);
    assert(result.backlog.length > 50); assert(result.score); assert(result.words.length > 0);
  }
  report.smallValidated = !!report.comparison.runs[0].refine && !report.comparison.runs[0].refine.error;
  assert.deepEqual(report.errors, []); report.passed = true;
} catch (error) { report.error = error.stack; throw error; }
finally {
  await mkdir('test-results', { recursive: true }); await writeFile(`test-results/stream-comparison-${report.engine}${cpu ? '-cpu' : '-gpu'}.json`, JSON.stringify(report, null, 2));
  await browser.close(); await vite.close();
}
console.log(JSON.stringify({ passed: report.passed, smallCpuOverride: cpu, prepared: report.comparison.prepared,
  runs: report.comparison.runs.map(row => Object.fromEntries(['fast', 'refine'].map(model => [model, row[model] && {
    error: row[model].error, firstWordMs: row[model].firstWordMs, releaseMs: row[model].releaseMs, updates: row[model].updateCount,
    backlogEarlyMs: row[model].backlogEarlyMs, backlogLateMs: row[model].backlogLateMs, wer: row[model].score?.wer }])) ) }, null, 2));
