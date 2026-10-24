// Actual Tiny + Small preparation, cached reload and inference. Linux child PSS
// is a desktop process-memory measurement, not an iPhone memory-limit estimate.
import { chromium, webkit } from '@playwright/test';
import { createServer } from 'vite';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { speechDownloads } from '../src/speech-download-config.js';
const cpu = process.argv.includes('--cpu'), useWebkit = process.argv.includes('--webkit');
const label = process.argv.find(v => v.startsWith('--label='))?.slice(8) || 'current';
const assets = process.env.BROWSER_STT_CACHE || '.state/stt-assets';
const server = await createServer({ configFile: 'demo/vite.config.js', server: { host: '127.0.0.1', port: 0, strictPort: false, fs: { allow: [process.cwd(), assets] } } });
await server.listen(); const origin = server.resolvedUrls.local[0];
async function memory(pid = process.pid) {
  const children = await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8').catch(() => ''); let total = 0;
  for (const child of children.trim().split(/\s+/).filter(Boolean)) {
    const text = await readFile(`/proc/${child}/smaps_rollup`, 'utf8').catch(() => '');
    total += Number(text.match(/^Pss:\s+(\d+)/m)?.[1] || 0) + await memory(child);
  }
  return total;
}
const report = { label, physicalPhone: false, actualModels: true, cpuOverride: cpu, engine: useWebkit ? 'webkit' : 'chromium', passed: false, runs: [] };
const browser = await (useWebkit ? webkit : chromium).launch({ headless: true, executablePath: useWebkit ? process.env.WEBKIT_PATH : '/usr/bin/google-chrome',
  ...(!cpu && !useWebkit ? { args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=vulkan', '--enable-features=Vulkan', '--disable-vulkan-surface', '--disable-gpu-compositing'], env: { ...process.env, VK_ICD_FILENAMES: '/usr/share/vulkan/icd.d/nvidia_icd.json' } } : {}) });
try {
  const page = await browser.newPage(); let offline = false, stage = 'preparation';
  await page.exposeFunction('__phase', value => { stage = value; });
  await page.route('**/speech-worker.js', async route => {
    const response = await route.fetch();
    const files = speechDownloads.map(f => ({ url: f.url, local: new URL(`/@fs${path.join(assets, 'whisper-small.en', f.file)}`, origin).href }));
    const baselineWorker = process.argv.find(v => v.startsWith('--baseline-worker='))?.slice(18);
    const worker = baselineWorker ? await readFile(baselineWorker, 'utf8') : await response.text();
    await route.fulfill({ response, body: worker + `
      const originalFetch = self.fetch.bind(self), files = ${JSON.stringify(files)};
      self.fetch = (url, options) => { const f = files.find(f => f.url === String(url)); if (f && ${offline}) throw new Error('offline test'); return originalFetch(f?.local || url, options); };
      const dispatch = self.onmessage; self.onmessage = event => { if (${cpu} && event.data.model === 'refine') event.data.backend = 'wasm'; dispatch(event); };` });
  });
  for (const cache of ['cold', 'warm']) {
    offline = cache === 'warm'; await page.goto(origin);
    const baseline = await memory(), samples = []; let running = true; stage = 'preparation';
    const monitor = (async () => { while (running) { const current = stage; samples.push({ stage: current, memory: await memory() }); await new Promise(r => setTimeout(r, 100)); } })();
    let result;
    try {
      result = await page.evaluate(async module => {
        const { ResidentSpeech } = await import(module); const phases = [];
        const models = window.models = new ResidentSpeech({ changed: () => {
          const r = models.entries.refine;
          const phase = r.state === 'loading' ? r.progress.replace(/[\d.]+/g, '#') : r.state;
          if (phases.at(-1)?.phase !== phase) { phases.push({ phase, at: performance.now() }); console.log('model phase:', phase); }
        } });
        await models.open();
        for (const e of Object.values(models.entries)) { if (e.error) throw e.error; if (e.state !== 'ready') throw new Error('Model not ready'); }
        const prepared = Object.fromEntries(Object.entries(models.entries).map(([k, e]) => [k, e.ready]));
        await new Promise(resolve => setTimeout(resolve, 300));
        await window.__phase('inference');
        const audio = await (await fetch('/stt/benchmark/1272-128104-0000.wav')).blob();
        const text = {};
        for (const m of ['fast', 'refine']) text[m] = (await models.transcribe(m, audio)).text;
        return { prepared, text, phases };
      }, `/@fs${process.cwd()}/src/index.js`);
      assert.match(result.text.fast, /Quilter/i); assert.match(result.text.refine, /Quilter/i);
      assert.equal(result.prepared.refine.download.downloadedBytes, cache === 'cold' ? 585972125 : 0);
    } finally { running = false; await monitor; }
    report.runs.push({ cache, baselinePssMiB: Math.round(baseline / 1024), peakPssMiB: Math.round(Math.max(...samples.map(s => s.memory)) / 1024),
      preparationPeakPssMiB: Math.round(Math.max(...samples.filter(s => s.stage === 'preparation').map(s => s.memory)) / 1024),
      readyPssMiB: Math.round(await memory() / 1024), ...result });
    console.log(JSON.stringify(report.runs.at(-1)));
    await page.evaluate(() => window.models.close());
  }
  report.passed = true;
} finally {
  await mkdir('test-results', { recursive: true });
  await writeFile(`test-results/model-preparation-${label}-${report.engine}${cpu ? '-cpu' : '-gpu'}.json`, JSON.stringify(report, null, 2));
  await browser.close(); await server.close();
}
