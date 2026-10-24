// Real Tiny CPU, identical known-reference PCM, paced capture or batch accuracy.
// Does not change Pageborne's installed package. See docs/window-study.md.
import { chromium, webkit } from '@playwright/test';
import { createServer } from 'vite';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { speechAssets } from './assets.mjs';
const argument = (key, fallback) => process.argv.find(v => v.startsWith(`--${key}=`))?.split('=')[1] || fallback;
const engine = argument('engine', 'chromium'), scenario = argument('scenario', 'prose');
const manifestPath = argument('manifest', ''), caseId = argument('case', '');
const expanded = manifestPath ? JSON.parse(await readFile(manifestPath)) : null;
const selected = expanded?.cases.find(entry => entry.id === caseId);
if (expanded && !selected) throw new Error(`Unknown case ${caseId}`);
const windows = argument('windows', '15,30,60').split(',').map(Number);
const policies = argument('policies', 'context').split(',');
const paced = !process.argv.includes('--batch');
const label = argument('label', `${scenario}-${policies.join('-')}-${paced ? 'paced' : 'batch'}`);
const manifest = expanded ? { source: expanded.source, samples: selected.samples } : scenario === 'prose' ? JSON.parse(await readFile('.state/window-study/samples.json')) :
  { source: 'vendor/stt/benchmark-samples.json', samples: JSON.parse(await readFile('vendor/stt/benchmark-samples.json')) };
// Consecutive source excerpts, no repeats, no artificial pauses/noise. Preserve
// existing clipped source boundaries. A second suite covers multiple speakers.
const samples = expanded ? manifest.samples : scenario === 'prose' ? manifest.samples.slice(0, 10) : manifest.samples;
const files = new Map();
for (const sample of samples) {
  const bytes = await readFile(`${expanded ? '.state/expanded-window-study' : scenario === 'prose' ? '.state/window-study' : 'vendor/stt/phone-benchmark'}/${sample.file}`);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sample.sha256 && sha256 !== sample.sha256) throw new Error(`Audio checksum mismatch: ${sample.file}`);
  sample.sha256 = sha256; files.set('/study-audio/' + sample.file, bytes);
}
const server = await createServer({ configFile: false, root: process.cwd(),
  ...(process.env.STUDY_LANE ? { cacheDir: `.state/window-vite-${process.env.STUDY_LANE}` } : {}),
  define: { __STT_CPU_ONLY__: 'true' }, server: { host: '127.0.0.1', port: 0, strictPort: false },
  plugins: [speechAssets({ refinement: false }), { name: 'window-study', configureServer(s) {
    s.middlewares.use((req, res, next) => {
      if (req.url === '/study') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Tiny window study</title>'); }
      else if (files.has(req.url)) { res.setHeader('Content-Type', 'audio/wav'); res.end(files.get(req.url)); }
      else next();
    });
  } }] });
await server.listen();
const browser = await (engine === 'webkit' ? webkit : chromium).launch({ headless: true,
  executablePath: engine === 'webkit' ? process.env.WEBKIT_PATH : '/usr/bin/google-chrome' });
const report = { createdAt: new Date().toISOString(), engine, browserVersion: browser.version(), scenario, paced, physicalPhone: false,
  completed: false, source: manifest.source, samples, ...(selected ? { case: { id: selected.id, config: selected.config, speaker: selected.speaker, chapter: selected.chapter } } : {}),
  execution: { lane: process.env.STUDY_LANE || null, cpuAffinity: process.platform === 'linux' ? (await readFile('/proc/self/status', 'utf8')).match(/Cpus_allowed_list:\s*(.*)/)?.[1] : null },
  cadence: { deliveryMs: 100, minNewAudioMs: 500, coalesceMs: 100 }, runs: [], errors: [] };
const path = `test-results/window-study-${engine}-${label}.json`;
await mkdir('test-results', { recursive: true });
try {
  const page = await browser.newPage();
  page.on('pageerror', error => report.errors.push(error.message));
  await page.exposeFunction('studyProgress', message => console.log(message));
  await page.exposeFunction('studyResult', async run => {
    report.runs.push(run); await writeFile(path, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ policy: run.policy, window: run.windowSeconds, ...run.metrics, score: run.score && { errors: run.score.errors, words: run.score.referenceWords, deletions: run.score.deletions } }));
  });
  await page.goto(server.resolvedUrls.local[0] + 'study');
  await page.evaluate(async ({ samples, windows, policies, paced }) => {
    const { ResidentSpeech, SpeechStream, PcmMicrophone, pcmWave, waveSamples } = await import('/src/index.js');
    const { scoreSpeech, benchmarkWords } = await import('/src/speech-benchmark.js');
    const clips = await Promise.all(samples.map(async sample => {
      const floats = waveSamples(await (await fetch('/study-audio/' + sample.file)).arrayBuffer());
      const pcm = new Uint8Array(floats.length * 2), view = new DataView(pcm.buffer);
      for (let i = 0; i < floats.length; i++) view.setInt16(i * 2, floats[i] * 32768, true);
      return pcm;
    }));
    const pcm = new Uint8Array(clips.reduce((sum, clip) => sum + clip.length, 0));
    let at = 0; for (const clip of clips) { pcm.set(clip, at); at += clip.length; }
    const expected = samples.map(s => s.reference).join(' ');
    const speech = new ResidentSpeech({ refinement: false });
    await speech.open({ refine: false }); await speech.wait('fast');
    // Explicit warm-up excluded from timings; never run competing inferences.
    await speech.transcribe('fast', pcmWave([clips[0]]));
    const percentile = (values, p) => values.length ? [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))] : null;
    const mean = values => values.reduce((sum, value) => sum + value, 0) / (values.length || 1);
    try {
      for (const policy of policies) for (const windowSeconds of windows) {
        await window.studyProgress(`Starting ${policy} ${windowSeconds}s / ${windowSeconds / 2}s overlap (${(pcm.length / 32000).toFixed(2)}s audio; ${paced ? 'paced' : 'batch'})`);
        const updates = [], calls = [], backlog = [];
        let firstWordMs = null, peakPcmBytes = 0, feedLateMs = 0, fatal = null, lastText = '', revisions = 0, changedWords = 0;
        const start = performance.now();
        const stream = new SpeechStream({ windowSeconds, overlapSeconds: windowSeconds / 2, commitOnPause: policy === 'pause',
          failure: error => { fatal = error; },
          transcribe: async (audio, options) => {
            const call = { start: stream.offset / 32000, end: stream.lastEnd / 32000, seconds: (audio.size - 44) / 32000,
              fallback: typeof options.onPartial !== 'function', ms: performance.now() - start };
            calls.push(call);
            const value = await speech.transcribe('fast', audio, options);
            Object.assign(call, { text: value.text, segments: value.segments, transcribeMs: value.transcribeMs, wallMs: performance.now() - start - call.ms });
            return value;
          }, result: value => {
            if (!value.text || value.text === lastText) return;
            if (firstWordMs === null) firstWordMs = performance.now() - start;
            const old = benchmarkWords(lastText), next = benchmarkWords(value.text);
            if (old.some((word, index) => next[index] !== word)) {
              revisions++;
              const changes = scoreSpeech(lastText, value.text);
              changedWords += changes.substitutions + changes.deletions;
            }
            lastText = value.text;
            updates.push({ ms: performance.now() - start, text: value.text, audioSeconds: stream.length / 32000 });
          } });
        const mic = new PcmMicrophone(async () => true, () => {}, chunk => stream.receive(chunk));
        stream.start(); await mic.start({ retainAudio: false });
        try {
          const step = paced ? 3200 : windowSeconds / 2 * 32000;
          let progressAt = 0;
          for (let offset = 0; offset < pcm.length; offset += step) {
            const end = Math.min(pcm.length, offset + step), due = end / 32;
            if (paced) await new Promise(resolve => setTimeout(resolve, Math.max(0, due - (performance.now() - start))));
            if (fatal) throw fatal;
            mic.receive(pcm.subarray(offset, end));
            feedLateMs = Math.max(feedLateMs, performance.now() - start - due);
            peakPcmBytes = Math.max(peakPcmBytes, stream.bytes.byteLength);
            backlog.push({ audioSeconds: end / 32000, seconds: (end - stream.completedEnd) / 32000 });
            if (!paced) await stream.run(true);
            if (end / 32000 - progressAt >= 30) {
              progressAt = end / 32000;
              await window.studyProgress(`${policy} ${windowSeconds}s: fed ${progressAt.toFixed(0)}s, processed ${(stream.completedEnd / 32000).toFixed(1)}s`);
            }
          }
          const receipt = await mic.stop(), release = performance.now();
          const beforeRelease = lastText;
          const result = await stream.finish(receipt);
          if (result.words.some(w => result.text.slice(w.start, w.end) !== w.text)) throw new Error('Invalid confidence offsets');
          if (calls.some(c => c.segments?.length !== 1 || Math.abs(c.segments[0].seconds - c.seconds) > .001)) throw new Error('Worker split a requested acoustic window');
          const third = pcm.length / 32000 / 3;
          const metrics = { audioSeconds: pcm.length / 32000, firstWordMs, releaseMs: performance.now() - release,
            inferenceMs: calls.reduce((sum, c) => sum + c.transcribeMs, 0), calls: calls.length,
            updates: updates.length, revisions, changedWords, peakPcmBytes,
            longestActualModelSegment: Math.max(...calls.flatMap(c => c.segments.map(s => s.seconds))),
            tokenLimitHits: calls.flatMap(c => c.segments).filter(s => s.tokens >= s.tokenLimit).length,
            fallbackCalls: calls.filter(c => c.fallback).length,
            backlogP95Seconds: percentile(backlog.map(p => p.seconds), .95),
            backlogEarlyMeanSeconds: mean(backlog.filter(p => p.audioSeconds <= third).map(p => p.seconds)),
            backlogLateMeanSeconds: mean(backlog.filter(p => p.audioSeconds > third * 2).map(p => p.seconds)),
            updateGapP95Ms: percentile(updates.slice(1).map((u, i) => u.ms - updates[i].ms), .95),
            feedLateMs: paced ? feedLateMs : null, timingValid: paced && feedLateMs <= 500 };
          await window.studyResult({ policy, windowSeconds, overlapSeconds: windowSeconds / 2, metrics, text: result.text,
            score: scoreSpeech(expected, result.text), beforeReleaseScore: scoreSpeech(expected, beforeRelease), expected, calls, updates, backlog });
        } finally { await mic.stop(); stream.cancel(); }
      }
    } finally { speech.close(); }
  }, { samples, windows, policies, paced });
  if (report.errors.length) throw new Error(report.errors.join('\n'));
  report.completed = true;
} catch (error) {
  report.errors.push(error.message); throw error;
} finally {
  await writeFile(path, JSON.stringify(report, null, 2)); await browser.close(); await server.close();
}
console.log(`Saved ${path}`);
