// Real Tiny, known LibriSpeech references, identical audio for both policies.
// Transport is injected PCM, not a physical microphone/BLE measurement.
import { chromium, webkit } from '@playwright/test';
import { createServer } from 'vite';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const useWebkit = process.argv.includes('--webkit');
const reference = JSON.parse(await readFile('vendor/stt/benchmark-samples.json'));
const baseline = (await readFile('benchmarks/baselines/9a7bb3e/speech-stream.js', 'utf8'))
  .replaceAll("from './", `from '/@fs${process.cwd()}/src/`);
const server = await createServer({ configFile: 'demo/vite.config.js', server: { host: '127.0.0.1', port: 0, strictPort: false, watch: null },
  plugins: [{ name: 'old-stream-test', configureServer(server) { server.middlewares.use('/old-stream.js', (_, res) => { res.setHeader('Content-Type', 'text/javascript'); res.end(baseline); }); } }] });
await server.listen();
const browser = await (useWebkit ? webkit : chromium).launch({ executablePath: useWebkit ? process.env.WEBKIT_PATH : '/usr/bin/google-chrome', headless: true });
const report = { paced: !process.argv.includes('--quick'), engine: useWebkit ? 'webkit' : 'chromium', physicalPhone: false, passed: false, errors: [] };
try {
  const page = await browser.newPage(); page.on('pageerror', e => report.errors.push(e.message)); await page.goto(server.resolvedUrls.local[0]);
  Object.assign(report, await page.evaluate(async ({ module, reference, quick }) => {
    const { ResidentSpeech, SpeechStream, PcmMicrophone, pcmWave } = await import(module);
    const { SpeechStream: OldStream } = await import('/old-stream.js');
    const { scoreSpeech } = await import(module.replace('index.js', 'speech-benchmark.js'));
    const speech = new ResidentSpeech({ refinement: false }); await speech.open({ refine: false });
    const files = ['1272-128104-0000', '1272-128104-0001', '1272-128104-0002', '2961-960-0003'];
    const clips = await Promise.all(files.map(async name => new Uint8Array(await (await fetch(`/stt/benchmark/${name}.wav`)).arrayBuffer()).slice(44)));
    const join = parts => { const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of parts) { bytes.set(p, at); at += p.length; } return bytes; };
    const runs = [];
    async function run(label, pcm, Type, overlapSeconds, paced = false) {
      let firstWordMs = null, peakBytes = 0; const calls = [], start = performance.now();
      const stream = new Type({ overlapSeconds, intervalMs: 0, transcribe: async (audio, options) => {
        const raw = new Uint8Array(await audio.arrayBuffer());
        let checksum = 0; for (const b of raw) checksum = Math.imul(checksum, 31) + b | 0;
        const call = { bytes: raw.length, checksum, start: stream.offset / 32000, end: stream.lastEnd / 32000 }; calls.push(call);
        const result = await speech.transcribe('fast', audio, options); call.text = result.text; return result;
      }, result: r => { if (r.text && firstWordMs === null) firstWordMs = performance.now() - start; } });
      const mic = new PcmMicrophone(async () => true, () => {}, b => stream.receive(b));
      stream.start(); await mic.start({ retainAudio: false });
      try {
        if (paced) {
          for (let at = 0; at < pcm.length; at += 3200) {
            await new Promise(r => setTimeout(r, Math.max(0, (at + 3200) / 32 - (performance.now() - start))));
            mic.receive(pcm.subarray(at, at + 3200)); peakBytes = Math.max(peakBytes, stream.bytes.byteLength);
          }
        } else {
          for (let at = 0; at < pcm.length; at += 7.5 * 32000) {
            mic.receive(pcm.subarray(at, at + 7.5 * 32000));
            peakBytes = Math.max(peakBytes, stream.bytes.byteLength);
            await stream.run(true);
          }
        }
        const receipt = await mic.stop(), released = performance.now();
        const result = await stream.finish(Type === OldStream ? pcmWave([pcm]) : receipt);
        return { label, text: result.text, seconds: result.seconds, firstWordMs, releaseMs: performance.now() - released, peakBytes,
          calls, validOffsets: result.words.every(w => result.text.slice(w.start, w.end) === w.text) };
      } finally { stream.cancel(); }
    }
    try {
      const short = join(clips.flatMap(p => [p, new Uint8Array(19200)]));
      runs.push(await run('legacy', short, OldStream, 0));
      runs.push(await run('rolling-same-windows', short, SpeechStream, 0));
      const pcm = join([...clips, ...clips].flatMap(p => [p, new Uint8Array(19200)]));
      runs.push(await run('rolling-paced-over-one-minute', pcm, SpeechStream, 7.5, !quick));
      // Force continuous windows with a modest constant noise floor. Both
      // policies hear exactly these samples; references are never model input.
      const continuous = pcm.slice(), view = new DataView(continuous.buffer);
      for (let at = 0; at < continuous.length; at += 2) view.setInt16(at, Math.max(-32768, Math.min(32767, view.getInt16(at, true) + 500)), true);
      runs.push(await run('continuous-no-overlap', continuous, SpeechStream, 0));
      runs.push(await run('continuous-half-overlap', continuous, SpeechStream, 7.5));
      const expected = [...files, ...files].map(file => reference.find(row => row.file === file + '.wav' || row.id === file)?.reference || '').join(' ');
      for (const run of runs.slice(2)) run.score = scoreSpeech(expected, run.text);
      return { runs, expected };
    } finally { speech.close(); }
  }, { module: `/@fs${process.cwd()}/src/index.js`, reference, quick: process.argv.includes('--quick') }));
  const [old, same, paced, baselineRun, overlap] = report.runs;
  assert.equal(same.text, old.text);
  assert.deepEqual(same.calls, old.calls, 'rolling storage preserves exact full-window WAVs and outputs without overlap');
  assert(paced.seconds > 80); assert(report.expected.length > 600);
  for (const run of report.runs.slice(2)) {
    assert(run.validOffsets); assert(run.peakBytes <= 30 * 32000);
    assert(run.calls.every(c => c.bytes <= 44 + 15 * 32000));
    assert.equal((run.text.match(/apostle/gi) || []).length, 2, `${run.label} loses a repeated opening`);
    assert.equal((run.text.match(/not understood by them at all/gi) || []).length, 2, `${run.label} loses an ending`);
  }
  assert(overlap.calls.some((c, i, a) => i && c.start < a[i - 1].end), 'actual inference includes overlapping acoustic windows');
  assert(overlap.score.errors <= baselineRun.score.errors, 'check regression against known reference, never an ASR-generated reference');
  assert.deepEqual(report.errors, []); report.passed = true;
} finally {
  await mkdir('test-results', { recursive: true }); await writeFile(`test-results/rolling-stream-${report.engine}.json`, JSON.stringify(report, null, 2));
  await browser.close(); await server.close();
}
console.log(JSON.stringify({ engine: report.engine, passed: report.passed, paced: report.paced, runs: report.runs.map(r => ({ label: r.label, seconds: r.seconds, firstWordMs: r.firstWordMs, releaseMs: r.releaseMs, peakBytes: r.peakBytes, errors: r.score?.errors, referenceWords: r.score?.referenceWords, calls: r.calls.length })) }));
