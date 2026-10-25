import test from 'node:test';
import assert from 'node:assert/strict';
import { filenamesInText, filenameVocabulary, formatSpokenFilenames } from '../src/speech-filenames.js';

test('filename candidates include chat code, paths and quoted spaces, but exclude URLs and prose abbreviations', () => {
  assert.deepEqual(filenamesInText('Use `README.md`, src/speech_ui.js, "Final Report.pdf", `trace.customext` and archive.tar.gz. '
    + 'https://example.com/private.pdf www.example.com/file.md e.g. v1.2.3 README.md'),
  ['README.md', 'speech_ui.js', 'Final Report.pdf', 'trace.customext', 'archive.tar.gz']);
  assert.deepEqual(filenamesInText('Run `echo report.txt` then `a(); b()`.'), ['echo report.txt']);
  assert.deepEqual(filenamesInText("Call `fs.readFile('todo.txt')` then edit **AGENTS.md**."), ['todo.txt', 'AGENTS.md']);
});

test('spoken filename hints are bounded and keep suffix letter pronunciations together', () => {
  const hints = filenameVocabulary(['src/speech_ui.js', 'serverConfig.ts', 'README.md']);
  assert(hints.includes('speech ui dot j s'));
  assert(hints.includes('server Config dot t s'));
  assert(hints.includes('read me dot m d'));
  assert(filenameVocabulary(Array.from({ length: 100 }, (_, i) => `file_${i}.pdf`)).length <= 48);
});

test('explicit dots and common letter-name pronunciations work without a dictionary', () => {
  for (const [speech, expected] of [
    ['Open report dot PDF.', 'Open report.pdf.'],
    ['Open report dot pee dee eff, please.', 'Open report.pdf, please.'],
    ['Edit notes dot em dee and index dot jay ess.', 'Edit notes.md and index.js.'],
    ['Save config dot j s o n.', 'Save config.json.'],
    ['Use schema dot jay son.', 'Use schema.json.'],
    ['Try archive dot tar dot gee zee.', 'Try archive.tar.gz.'],
    ['Read build hyphen notes dot t x t.', 'Read build-notes.txt.'],
    ['Change speech underscore ui dot tee ess.', 'Change speech_ui.ts.'],
    ['Read manuscript dot p.d.f.', 'Read manuscript.pdf.'],
    ['Open todo dot txt and agents dot md.', 'Open todo.txt and agents.md.'],
    ['Read todo dot tee ex tee and agents dot em dee.', 'Read todo.txt and agents.md.'],
    ['Play sample dot double u ay vee.', 'Play sample.wav.'],
  ]) assert.equal(formatSpokenFilenames({ text: speech }).text, expected, speech);
});

test('known names restore spaces, casing, camel case and separators without fuzzy lexical substitutions', () => {
  const names = ['README.md', 'speech_ui.js', 'serverConfig.ts', 'Final Report.pdf', 'trace.customext', 'archive.tar.gz', 'todo.txt', 'AGENTS.md'];
  for (const [speech, expected] of [
    ['Read read me dot em dee.', 'Read README.md.'],
    ['Open speech you eye dot jay ess.', 'Open speech_ui.js.'],
    ['Edit server config dot ts.', 'Edit serverConfig.ts.'],
    ['Use final report dot pdf.', 'Use Final Report.pdf.'],
    ['Read trace dot customext.', 'Read trace.customext.'],
    ['Open readme.md.', 'Open README.md.'],
    ['Open archive dot tar dot g z.', 'Open archive.tar.gz.'],
    ['Read stranger dot md.', 'Read stranger.md.'],
    ['Open to do dot text and agents dot em dee.', 'Open todo.txt and AGENTS.md.'],
  ]) assert.equal(formatSpokenFilenames({ text: speech }, names).text, expected, speech);
  assert.equal(formatSpokenFilenames({ text: 'Read speech ui dot js.' }, ['speech_ui.js', 'speech-ui.js']).text,
    'Read speech ui.js.', 'ambiguous spellings are not guessed');
});

test('ordinary prose, unknown suffix words, incomplete dictation and sentence periods are preserved', () => {
  for (const text of ['Compute the dot product.', 'Connect the dots.', 'Read a report. PDF files are fine.',
    'Please read me.', 'Open report dot', 'Open report dot p d', 'The word is dot.',
    'The doctor asked me to go.', 'Use report. pdf.', 'Use the red dot on the screen.']) {
    const result = { text, partial: true, words: [] };
    assert.equal(formatSpokenFilenames(result, ['report.pdf', 'README.md']), result, text);
  }
});

test('formatting remaps confidence spans, retains uncertainty and never upgrades missing evidence', () => {
  const text = 'Read read me dot em dee and report dot pdf now.';
  const words = [...text.matchAll(/\w+/g)].map(m => ({ start: m.index, end: m.index + m[0].length,
    text: m[0], confidence: m[0] === 'em' ? .2 : .95, confident: m[0] !== 'em', tokens: [],
    scores: { minimum: m[0] === 'em' ? .2 : .95, mean: .95, geometricMean: .95 }, flags: { strict: m[0] !== 'em' } }));
  const input = { text, words, partial: true, transcribeMs: 42, models: ['conformer', 'moonshine'] };
  const out = formatSpokenFilenames(input, ['README.md']);
  assert.equal(out.text, 'Read README.md and report.pdf now.');
  assert(out.words.every(w => out.text.slice(w.start, w.end) === w.text));
  assert.equal(out.words[1].confidence, .2); assert.equal(out.words[1].confident, false);
  assert.equal(out.words[1].flags.strict, false);
  assert.equal(out.partial, true); assert.equal(out.transcribeMs, 42); assert.deepEqual(out.models, input.models);
  assert.equal(input.text, text); assert.equal(words[1].text, 'read');
  assert.deepEqual(formatSpokenFilenames(out, ['README.md']), out, 'formatting is idempotent');
  words[2].confidence = null; words[2].scores.minimum = null; words[2].confident = null;
  assert.equal(formatSpokenFilenames(input, ['README.md']).words[1].confidence, null);
  assert.deepEqual(formatSpokenFilenames({ text: 'notes dot md' }), { text: 'notes.md' });
});
