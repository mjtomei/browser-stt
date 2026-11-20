import test from 'node:test';
import assert from 'node:assert/strict';
import { fluidDecision, fluidMelFilters, fluidTokenizer, fluidPartial } from '../src/fluid-mini-utils.js';
import { EnsembleSpeech, fluidSpeechMini } from '../src/ensemble-speech.js';
import { confidenceWords } from '../src/speech-confidence.js';
import { nativeModelCache } from '../src/ensemble-cache.js';

test('Mini is opt-in for the standalone library and selects only its pinned assets', () => {
  const legacy = new EnsembleSpeech({ base: 'https://test.invalid/' });
  assert.deepEqual(Object.keys(legacy.entries), ['conformer', 'zipformer', 'moonshine']);
  const mini = new EnsembleSpeech({ base: 'https://test.invalid/', modelIds: ['fluid-mini'] });
  assert.deepEqual(Object.keys(mini.entries), ['fluid-mini']);
  assert.equal(mini.entries['fluid-mini'].totalBytes, 300146787);
  for (const file of fluidSpeechMini.files) assert(file.url.includes('/resolve/' + fluidSpeechMini.revision + '/'));
  assert.throws(() => new EnsembleSpeech({ modelIds: ['untrusted'], base: 'https://test.invalid/' }), /Unknown/);
  assert.throws(() => new EnsembleSpeech({ modelIds: ['fluid-mini', 'fluid-mini'], base: 'https://test.invalid/' }), /duplicate/);
});

test('TDT decisions score only the token vocabulary and advance a zero-duration blank', () => {
  const config = { vocab_size: 3, blank_token_id: 2, durations: [0, 1, 2] };
  assert.deepEqual(fluidDecision(new Float32Array([0, 0, 1, 100, 2, 1]), config), { token: 2, step: 1, probability: 1 / (1 + 2 * Math.exp(-1)) });
  assert.equal(fluidDecision(new Float32Array([4, 0, 1, 0, 1, 9]), config).step, 2);
  assert.throws(() => fluidDecision(new Float32Array(6).fill(NaN), config), /invalid scores/);
  assert.throws(() => fluidDecision(new Float32Array(2), config), /Unexpected/);
});

test('Fluid punctuation and Unicode confidence offsets remain aligned', () => {
  const tokenizer = fluidTokenizer({ model: { vocab: { '▁I': 0, "'m": 1, '▁naïve': 2, '.': 3, '<pad>': 4 } }, added_tokens: [{ id: 4, content: '<pad>', special: true }] }, { blank_token_id: 5, pad_token_id: 4 });
  const ids = [0, 1, 2, 3], scores = ids.map(token => ({ token, probability: .8 }));
  assert.equal(tokenizer.decode([5, ...ids, 4]), "I'm naïve.");
  const text = tokenizer.decode(ids), words = confidenceWords(text, scores, tokenizer.decode);
  assert.deepEqual(words.map(w => w.text), ["I'm", 'naïve']);
  assert(words.every(w => text.slice(w.start, w.end) === w.text && w.confidence === .8));
});

test('NumPy filter loading validates type and dimensions before use', () => {
  const header = "{'descr': '<f4', 'fortran_order': False, 'shape': (2, 2), }\n";
  const bytes = new Uint8Array(10 + header.length + 16), view = new DataView(bytes.buffer);
  bytes.set([0x93, ...new TextEncoder().encode('NUMPY'), 1, 0]); view.setUint16(8, header.length, true);
  bytes.set(new TextEncoder().encode(header), 10);
  [1, 2, 3, 4].forEach((n, i) => view.setFloat32(10 + header.length + i * 4, n, true));
  assert.deepEqual(fluidMelFilters(bytes.buffer, 2, 2), [[1, 2], [3, 4]]);
  assert.throws(() => fluidMelFilters(bytes.buffer, 128, 257), /shape/);
  assert.throws(() => fluidMelFilters(bytes.buffer.slice(0, -1), 2, 2), /shape/);
});

test('live Mini prefixes wait for a word boundary and preserve matching confidence spans', () => {
  const words = [{ text: 'Mr.', start: 0, end: 2, confidence: .8 }, { text: 'Qu', start: 4, end: 6, confidence: .7 }];
  assert.deepEqual(fluidPartial({ text: 'M', words: [] }), { text: '', words: [] });
  assert.deepEqual(fluidPartial({ text: 'Mr. Qu', words }), { text: 'Mr.', words: [words[0]] });
  assert.deepEqual(fluidPartial({ text: 'naïve café', words: [{ start: 0, end: 5 }] }), { text: 'naïve', words: [{ start: 0, end: 5 }] });
  assert.equal(words.length, 2, 'final confidence data is left intact');
});

test('retiring native weights resumes after interrupted deletion without orphaned chunks', async () => {
  const values = new Map(), kv = { get: async k => values.get(k), set: async (k, v) => values.set(k, v) };
  const cache = nativeModelCache(kv); await cache.put('old', new Response(new Uint8Array(75000).fill(7)));
  await cache.put('current', new Response('keep')); const set = kv.set;
  let clears = 0;
  kv.set = async (k, v) => { if (!v && ++clears === 2) throw Error('Interrupted'); return set(k, v); };
  await assert.rejects(cache.delete('old'), /Interrupted/);
  assert(values.get('pageborne:models:v1:old'), 'descriptor remains until all chunks are cleared');
  kv.set = set; await nativeModelCache(kv).delete('old');
  assert.equal(await cache.match('old'), undefined);
  assert.equal(await (await cache.match('current')).text(), 'keep');
  assert.equal([...values.values()].filter(Boolean).length, 2, 'only the current descriptor and chunk remain');
});
