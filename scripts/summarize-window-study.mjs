import { readFile, writeFile } from 'node:fs/promises';
import { benchmarkWords } from '../src/speech-benchmark.js';
const labels = ['prose-context-paced', 'mixed-context-paced', 'prose-current-policy', 'prose-60-sanity'];
const reports = await Promise.all(labels.map(async label => JSON.parse(await readFile(`test-results/window-study-chromium-${label}.json`))));
const model = JSON.parse(await readFile('vendor/stt/model.json'));
const median = values => { const sorted = values.toSorted((a, b) => a - b); return sorted.length ? (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2 : null; };
const summary = { date: '2026-10-13', hardware: 'Linux aarch64 ARM workstation, Cortex-X925; shared host; single-thread WASM SIMD',
  model: { repository: model.repository, revision: model.revision, backend: 'wasm' }, physicalPhone: false,
  notes: ['Two concatenated LibriSpeech recordings; the first three clips occur in both.',
    'No reference text or vocabulary supplied to recognition; warm-up excluded.',
    'Chunk size reaches the worker; each requested WAV is verified as one model segment.',
    'P95 backlog is delivered audio minus last completed decode, not forced-aligned word lag.',
    'Sentence-tail anchors use the final three reference words and original clip endpoints, which include trailing silence.',
    'Changed words cumulatively count substitutions/deletions of already-visible normalized words. Pure appended text is excluded.',
    'These are one run per configuration, not statistical estimates or phone measurements.'], reports: [] };
for (let index = 0; index < reports.length; index++) {
  const report = reports[index];
  if (report.errors.length || !report.runs.length) throw new Error(`Incomplete/failed report: ${labels[index]}`);
  summary.reports.push({ raw: `test-results/window-study-chromium-${labels[index]}.json`, engine: report.engine,
    browserVersion: report.browserVersion, scenario: report.scenario, paced: report.paced, samples: report.samples,
    runs: report.runs.map(run => {
      let end = 0;
      const anchors = report.scenario !== 'prose' ? [] : report.samples.map(sample => {
        end += sample.seconds;
        const anchor = benchmarkWords(sample.reference).slice(-3);
        const has = text => { const words = benchmarkWords(text); return words.some((_, i) => anchor.every((word, j) => words[i + j] === word)); };
        const first = run.updates.find(update => has(update.text));
        return { file: sample.file, anchor: anchor.join(' '), clipEndSeconds: end,
          firstVisibleLagSeconds: first ? first.ms / 1000 - end : null, presentAtFinish: has(run.text) };
      });
      const { wrong, extras, ...score } = run.score;
      return { policy: run.policy, windowSeconds: run.windowSeconds, overlapSeconds: run.overlapSeconds,
        metrics: run.metrics, score, text: run.text,
        ...(anchors.length ? { anchors, medianAnchorLagSeconds: median(anchors.map(a => a.firstVisibleLagSeconds).filter(v => v !== null)) } : {}) };
    }) });
}
await writeFile('benchmarks/window-study-2026-10-13.json', JSON.stringify(summary, null, 2) + '\n');
console.log('Saved benchmarks/window-study-2026-10-13.json');
