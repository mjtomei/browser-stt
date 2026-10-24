import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const lexical = text => [...text.matchAll(/[\p{L}\p{N}]+(?:['’.-][\p{L}\p{N}]+)*/gu)];
function boundaries(text) {
  const words = lexical(text);
  const gaps = words.map((w, i) => text.slice(w.index + w[0].length, words[i + 1]?.index));
  return { words: words.map(w => w[0].toLowerCase()), gaps, marks: gaps.map(gap => (gap.match(/[,?.]/g) || []).join('')) };
}
function score(rows, interior = false) {
  let tp = 0, fp = 0, fn = 0;
  for (const row of rows) {
    const ref = boundaries(row.reference), hyp = boundaries(row.output);
    assert.deepEqual(hyp.words, ref.words, `Word preservation: ${row.id}`);
    for (let i = 0; i < ref.words.length - Number(interior); i++) {
      for (const mark of new Set(hyp.marks[i])) ref.marks[i].includes(mark) ? tp++ : fp++;
      for (const mark of new Set(ref.marks[i])) if (!hyp.marks[i].includes(mark)) fn++;
    }
  }
  return { tp, fp, fn, precision: tp / (tp + fp), recall: tp / (tp + fn), f1: 2 * tp / (2 * tp + fp + fn) };
}
const summary = { date: '2026-10-20', physicalPhone: false, productionChanged: false,
  protocol: '38 author-written text cases with punctuation removed, plus saved real ASR hypotheses/production ensemble votes from 25 public LibriSpeech clips. References withheld from punctuation inference. Text cases do not compare fresh Moonshine audio inference. Single desktop pass, 3 calls per text; warm timing excludes first call. Curated reference punctuation is not uniquely correct; stylistic alternatives count as mismatches. Unsupported punctuation/notation cases excluded from supported F1. WASM heap is not total process memory.',
  runs: [] };
for (const browser of ['chromium', 'webkit']) for (const precision of ['int8', 'fp32']) {
  const report = JSON.parse(await readFile(`test-results/punctuation/${browser}-${precision}.json`));
  assert(report.passed);
  const curated = report.rows.filter(r => r.source === 'curated-text');
  assert.equal(curated.length, 38);
  for (const row of report.rows) assert.deepEqual(boundaries(row.output).words, boundaries(row.input).words, `Lexical change: ${row.id}`);
  const supported = curated.filter(r => !['unsupported-marks', 'protected-text'].includes(r.category));
  const times = report.rows.flatMap(r => r.timesMs.slice(1)).sort((a, b) => a - b);
  const and = { required: 0, correct: 0, falseCommaBeforeAndInControls: 0 };
  for (const row of curated.filter(r => r.category.startsWith('and-'))) {
    const ref = boundaries(row.reference), hyp = boundaries(row.output);
    for (let i = 0; i < ref.words.length - 1; i++) if (ref.words[i + 1] === 'and') {
      if (ref.marks[i].includes(',')) { and.required++; if (hyp.marks[i].includes(',')) and.correct++; }
      else if (hyp.marks[i].includes(',')) and.falseCommaBeforeAndInControls++;
    }
  }
  const raw = report.rows.filter(r => r.source === 'moonshine');
  const additions = [], commaOnlyOutputs = [];
  for (const row of raw) {
    const ref = boundaries(row.original), hyp = boundaries(row.output);
    assert.deepEqual(hyp.words, ref.words, 'Restoration must preserve all words except case');
    const insertions = [];
    for (let i = 0; i < ref.words.length - 1; i++) if (!ref.gaps[i].trim() && hyp.marks[i] === ',') {
      insertions.push(i);
      additions.push({
      id: row.id, after: ref.words[i], before: ref.words[i + 1], beforeAnd: ref.words[i + 1] === 'and', original: row.original, candidate: row.output,
      });
    }
    if (insertions.length) {
      const words = lexical(row.original);
      let output = row.original;
      for (const i of insertions.toReversed()) {
        const offset = words[i].index + words[i][0].length;
        output = `${output.slice(0, offset)},${output.slice(offset)}`;
      }
      commaOnlyOutputs.push({id: row.id, original: row.original, output});
    }
  }
  summary.runs.push({ browser, precision, preparation: report.preparation,
    medianWarmMs: times[Math.floor(times.length / 2)], p95WarmMs: times[Math.floor(times.length * .95)],
    maxLinearHeap: Math.max(...report.rows.map(r => r.heap)),
    supportedCases: supported.length, supportedPunctuation: score(supported), interiorPunctuation: score(supported, true), and,
    naturalClips: raw.length, naturalLostTerminalMark: raw.filter(r => /[.?!]$/.test(r.original) && !/[.?!]$/.test(r.output)).length,
    lexicalPreservedCases: report.rows.length, naturalCommaAdditions: additions, commaOnlyOutputs });
}
await writeFile('benchmarks/punctuation-2026-10-20.json', JSON.stringify(summary, null, 2) + '\n');
for (const run of summary.runs) console.log(JSON.stringify({ ...run, naturalCommaAdditions: run.naturalCommaAdditions.length, commaOnlyOutputs: run.commaOnlyOutputs.length }));
