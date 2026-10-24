import { chromium, webkit, expect } from '@playwright/test';
import { preview, createServer } from 'vite';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const useWebkit = process.argv.includes('--webkit');
const dev = process.argv.includes('--dev');
const server = dev ? await createServer({ configFile: 'demo/vite.config.js', server: { host: '127.0.0.1', port: 0, strictPort: false } })
  : await preview({ configFile: 'demo/vite.config.js', preview: { host: '127.0.0.1', port: 0, strictPort: false } });
if (dev) await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await (useWebkit ? webkit : chromium).launch({ executablePath: useWebkit ? process.env.WEBKIT_PATH : '/usr/bin/google-chrome', headless: true });
const errors = [], calls = []; const report = { physicalPhone: false, engine: useWebkit ? 'webkit' : 'chromium', dev, passed: false };
try {
  const page = await browser.newPage({ viewport: { width: 440, height: 806 } });
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message); }); page.on('console', message => { if (message.type() === 'error') console.error(message.text()); });
  page.on('request', request => { const url = new URL(request.url()); if (!['blob:', 'data:'].includes(url.protocol) && url.origin !== origin) calls.push(request.url()); });
  await page.goto(origin);
  await expect(page.locator('h1')).toHaveText('Browser STT');
  await page.locator('#prepare').click(); const monitor = setInterval(() => page.locator('#models').textContent().then(console.log).catch(() => {}), 10000);
  try { await expect(page.locator('#models')).toContainText('Tiny CPU: ready', { timeout: 30000 }); } finally { clearInterval(monitor); }
  await page.locator('#file').setInputFiles('vendor/stt/phone-benchmark/1272-128104-0000.wav');
  await expect(page.locator('#transcribe')).toBeEnabled(); await page.locator('#transcribe').click();
  await expect(page.locator('#progress')).toContainText('Tiny draft ready', { timeout: 60000 });
  const value = JSON.parse(await page.locator('#output').textContent());
  assert.equal(value.backend, 'wasm'); assert(value.simd); assert(value.text.length > 30); assert(value.words.length > 10);
  assert(value.words.every(word => typeof word.confident === 'boolean' && word.tokens.length && Number.isFinite(word.scores.mean)));
  await page.locator('#metric').selectOption('mean'); await page.locator('#threshold').fill('0'); await page.locator('#threshold').dispatchEvent('change');
  assert.equal(await page.locator('#words .uncertain').count(), 0);
  await page.locator('#threshold').fill('1'); await page.locator('#threshold').dispatchEvent('change');
  assert(await page.locator('#words .uncertain').count() > 0);
  const download = page.waitForEvent('download'); await page.locator('#save-audio').click();
  const exported = await download; assert.equal(exported.suggestedFilename(), 'recording.wav');
  assert((await readFile(await exported.path())).equals(await readFile('vendor/stt/phone-benchmark/1272-128104-0000.wav')));
  // Exercise the actual AudioWorklet/resampler with a synthetic microphone,
  // then cancel rather than presenting a sine wave to speech recognition.
  await page.evaluate(() => {
    window.__devices = navigator.mediaDevices;
    window.__devices.getUserMedia = async () => {
      const context = window.__audio = new AudioContext(); await context.resume();
      const tone = context.createOscillator(), destination = context.createMediaStreamDestination(); tone.connect(destination); tone.start();
      return destination.stream;
    };
  });
  await page.locator('#record').click();
  await expect(page.locator('#progress')).toContainText('Recording ·');
  await page.locator('#cancel').click(); await expect(page.locator('#progress')).toHaveText('Cancelled.');
  await expect(page.locator('#record')).toBeEnabled();
  await page.evaluate(() => window.__audio.close());
  assert.deepEqual(errors, []); assert.deepEqual(calls, []);
  Object.assign(report, { passed: true, text: value.text, words: value.words, transcribeMs: value.transcribeMs, errors, externalRequests: calls });
} finally {
  await mkdir('test-results', { recursive: true }); await writeFile(`test-results/browser-${report.engine}${dev ? '-dev' : ''}.json`, JSON.stringify(report, null, 2));
  await browser.close(); if (dev) await server.close(); else await new Promise(resolve => server.httpServer.close(resolve));
}
console.log(JSON.stringify({ passed: report.passed, engine: report.engine, text: report.text, transcribeMs: report.transcribeMs }));
