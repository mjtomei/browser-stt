import test from 'node:test';
import assert from 'node:assert/strict';
import { EnsembleModelStore, nativeModelCache } from '../src/ensemble-cache.js';
import { voteSpeech } from '../src/ensemble-vote.js';
import { decodeCtc } from '../src/ctc-context.js';
import { EnsembleStream } from '../src/ensemble-stream.js';
import { pcmWave } from '../src/pcm-microphone.js';
import { sha256 } from '@noble/hashes/sha2.js';
const hash = bytes => Buffer.from(sha256(bytes)).toString('hex');
const hypothesis = (id, text, confidence = .95) => ({ id, text, words: [...text.matchAll(/\w+/g)].map(m => ({ start: m.index, end: m.index + m[0].length, text: m[0], confidence })) });
const memory = () => { const values = new Map(); return { values, async get(k) { return values.get(k); }, async set(k, v) { values.set(k, v); } }; };

test('checksum keys reuse native downloads across store instances and reject corruption', async () => {
  const kv = memory(), bytes = new Uint8Array(100000).fill(42), file = { file: 'model.onnx', bytes: bytes.length, sha256: hash(bytes), url: 'https://example.invalid/weights' };
  let downloads = 0;
  const store = new EnsembleModelStore({ kv, fetch: async () => { downloads++; return new Response(bytes); } });
  await store.ensure(file);
  const updated = new EnsembleModelStore({ kv, fetch: async () => { throw Error('Must work offline'); } });
  await updated.ensure(file); assert.deepEqual(new Uint8Array(await (await updated.read(file)).arrayBuffer()), bytes); assert.equal(downloads, 1);
  const chunk = [...kv.values.keys()].find(k => /:0$/.test(k)); kv.values.set(chunk, btoa('wrong'));
  await assert.rejects(async () => (await updated.read(file)).arrayBuffer(), /integrity/);
  assert.equal(await (await store.cache()).match(file.sha256), undefined);
});

test('verified native chunks can transfer ownership without stalling or skipping the remaining file', async () => {
  const kv = memory(), bytes = Uint8Array.from({ length: 200003 }, (_, i) => i % 251);
  const file = { bytes: bytes.length, sha256: hash(bytes), url: 'https://example.invalid/model' };
  const store = new EnsembleModelStore({ kv, fetch: async () => new Response(bytes) });
  await store.ensure(file);
  const reader = (await store.read(file)).body.getReader(), result = new Uint8Array(bytes.length); let offset = 0;
  for (;;) {
    const { value, done } = await reader.read(); if (done) break;
    assert.equal(value.byteLength, value.buffer.byteLength);
    result.set(value, offset); offset += value.length;
    structuredClone(value.buffer, { transfer: [value.buffer] });
    assert.equal(value.byteLength, 0);
  }
  reader.releaseLock(); assert.equal(offset, bytes.length); assert.deepEqual(result, bytes);
  assert.deepEqual(new Uint8Array(await (await store.read(file)).arrayBuffer()), bytes, 'stored weights were not detached');
});

test('failed downloads are never visible and an interrupted journal is recovered', async () => {
  const kv = memory(), bytes = new Uint8Array(75000).fill(9), file = { bytes: bytes.length, sha256: hash(bytes), url: 'https://example.invalid' };
  const store = new EnsembleModelStore({ kv, fetch: async () => new Response(new Uint8Array(bytes.length)) });
  await assert.rejects(store.ensure(file), /integrity/);
  assert.equal(await (await store.cache()).match(file.sha256), undefined);
  store.fetch = async () => new Response(bytes); await store.ensure(file);
  assert.deepEqual(new Uint8Array(await (await store.read(file)).arrayBuffer()), bytes);
  assert.equal([...kv.values.values()].filter(v => v && v.length === 32000).length, 3);
});

test('native cache commits only after EOF; quota failures leave no usable file', async () => {
  const kv = memory(), cache = nativeModelCache(kv);
  const set = kv.set; let count = 0; kv.set = async (k, v) => { if (++count === 4) throw Error('quota'); return set(k, v); };
  await assert.rejects(cache.put('a', new Response(new Uint8Array(100000))), /quota/);
  assert.equal(await cache.match('a'), undefined);
});

test('confidence votes beat a high-confidence minority, preserve punctuation and expose disagreements', () => {
  const result = voteSpeech([hypothesis('conformer', 'the word is correct', .8), hypothesis('zipformer', 'the word is correct', .8), hypothesis('moonshine', 'The bird is correct.', .99)], { final: true });
  assert.equal(result.text, 'The word is correct.'); assert.equal(result.words[1].votes, 2); assert.equal(result.words[1].confident, false);
  for (const w of result.words) assert.equal(result.text.slice(w.start, w.end), w.text);
});
test('aligned Moonshine sentence punctuation survives a voted word substitution', () => {
  for (const [plain, punctuated, expected] of [
    ['please read the book', 'Please read the look.', 'Please read the book.'],
    ['please read the book then stop', 'Please read the look, then stop.', 'Please read the book, then stop.'],
    ['did you read the book', 'Did you read the look?', 'Did you read the book?'],
  ]) {
    const r = voteSpeech([hypothesis('conformer', plain), hypothesis('zipformer', plain), hypothesis('moonshine', punctuated)], { final: true });
    assert.equal(r.text, expected);
    assert.equal(r.words.find(w => w.text === 'book').votes, 2);
    assert(r.words.every(w => r.text.slice(w.start, w.end) === w.text));
  }
});
test('punctuation is not borrowed across gaps, unanchored disagreements, numeric separators or a lagging tail', () => {
  for (const [plain, moonshine, expected] of [
    ['please read the book now', 'Please read the look.', 'Please read the book now'],
    ['read the book', 'See a look.', 'read the book'],
    ['please read the book', 'Please read the good book.', 'Please read the book.'],
    ['please read the book', 'Please read the book now.', 'Please read the book'],
    ['the amount is 12 5 dollars', 'The amount is 13.5 dollars.', 'The amount is 12 5 dollars.'],
  ]) {
    const r = voteSpeech([hypothesis('conformer', plain), hypothesis('zipformer', plain), hypothesis('moonshine', moonshine)], { final: true });
    assert.equal(r.text, expected);
  }
});
test('a lagging stream abstains from the live tail; final deletion votes remove unsupported words', () => {
  const sources = [hypothesis('conformer', 'one two'), hypothesis('zipformer', 'one two'), hypothesis('moonshine', 'one two three')];
  assert.equal(voteSpeech(sources).text, 'one two three'); assert.equal(voteSpeech(sources, { final: true }).text, 'one two');
});

test('dictionary evidence breaks close lexical votes without inflating acoustic confidence', () => {
  const sources = [hypothesis('conformer', 'read NeRF now', .8), hypothesis('moonshine', 'read nerve now', .9)];
  assert.equal(voteSpeech(sources).text, 'read nerve now');
  const biased = voteSpeech(sources, { vocabulary: ['NERF', 'nerf'] });
  assert.equal(biased.text, 'read NeRF now');
  assert(Math.abs(biased.words[1].confidence - .8 / 1.7) < 1e-12);
  assert.equal(biased.words[1].votes, 1);
  assert.deepEqual(biased.words[1].sources.map(s => s.confidence), [.8, .9]);
  assert.equal(voteSpeech([...sources, hypothesis('zipformer', 'read nerve now', .9)], { vocabulary: ['NeRF'] }).text, 'read nerve now');
});
test('dictionary weighting never creates words, rescues gaps or boosts weak/unmeasured guesses', () => {
  for (const value of [.2, null]) {
    const sources = [hypothesis('conformer', 'a NeRF paper', value), hypothesis('moonshine', 'a nerve paper', .6)];
    assert.equal(voteSpeech(sources, { vocabulary: ['NeRF'] }).text, 'a nerve paper');
  }
  assert.equal(voteSpeech([hypothesis('conformer', 'read NeRF now', .45), hypothesis('moonshine', 'read now', .9)], { vocabulary: ['NeRF'], final: true }).text, 'read now');
  assert.equal(voteSpeech([hypothesis('conformer', 'a normal word')], { vocabulary: ['NeRF'] }).text, 'a normal word');
  const sources = [hypothesis('conformer', 'read NeRF now', .8), hypothesis('moonshine', 'read nerve now', .9)];
  assert.equal(voteSpeech(sources, { vocabulary: ['NeRF rendering'] }).text, 'read nerve now', 'partial phrases are not full dictionary detections');
  assert.equal(voteSpeech(sources, { vocabulary: ['NeRF now'] }).text, 'read NeRF now');
});
test('voted expansions of abbreviations do not inherit a mid-sentence period', () => {
  for (const [plain, punctuated, expected] of [
    ['we visited saint Clair county', 'We visited St. Clair county.', 'We visited saint Clair county.'],
    ['we saw mister Finney today', 'We saw Mr. Finney today.', 'We saw mister Finney today.'],
    ['we asked doctor Smith today', 'We asked Dr. Smith today.', 'We asked doctor Smith today.'],
  ]) {
    const r = voteSpeech([hypothesis('conformer', plain), hypothesis('zipformer', plain), hypothesis('moonshine', punctuated)], { final: true });
    assert.equal(r.text, expected);
    assert(r.words.every(w => r.text.slice(w.start, w.end) === w.text));
  }
  assert.equal(voteSpeech([hypothesis('moonshine', 'We visited St. Clair.')]).text, 'We visited St. Clair.');
});
test('long shared histories retain the beginning and align an inserted word at the end', () => {
  const prefix = Array.from({ length: 1800 }, (_, i) => 'word' + i).join(' ');
  assert.equal(voteSpeech([hypothesis('a', prefix + ' the end'), hypothesis('b', prefix + ' the end'), hypothesis('c', prefix + ' the extra end')], { final: true }).text, prefix + ' the end');
});
test('contextual CTC chooses plausible hints without inflating acoustic confidence', () => {
  const logs = Float32Array.from([.4, .35, .25, .01, .01, .98].map(Math.log));
  assert.equal(decodeCtc(logs, 2, ['▁cat', '▁cap', '<blk>']).text, 'cat');
  const biased = decodeCtc(logs, 2, ['▁cat', '▁cap', '<blk>'], ['cap']);
  assert.equal(biased.text, 'cap'); assert(Math.abs(biased.words[0].confidence - .35) < .0001);
});

test('three streams run concurrently, fast partials arrive before the slow model, cancellation suppresses late results', async () => {
  const pending = [], updates = [], models = { entries: { a: {}, b: {}, c: {} }, transcribe: (id, audio, options) => new Promise((resolve, reject) => {
    pending.push({ id, resolve, options }); options.signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
  }) };
  const stream = new EnsembleStream({ models, result: r => updates.push(r), streamOptions: { intervalMs: 1 } });
  stream.start(['technical']); const pcm = new Uint8Array(32000); new Int16Array(pcm.buffer).fill(2000); stream.receive(pcm);
  await new Promise(r => setTimeout(r, 20)); assert.equal(pending.length, 3);
  pending[0].resolve(hypothesis('a', 'the first words')); await new Promise(r => setTimeout(r, 10)); assert(updates.some(r => r.text === 'the first words'));
  stream.cancel(); const count = updates.length; pending[1].resolve(hypothesis('b', 'late words')); pending[2].resolve(hypothesis('c', 'late words'));
  await new Promise(r => setTimeout(r, 10)); assert.equal(updates.length, count);
  stream.start(); stream.cancel();
});

test('final ensemble accepts full-recording receipts and tolerates one model failing explicitly', async () => {
  const models = { entries: { a: {}, b: {}, c: {} }, transcribe: async id => { if (id === 'c') throw Error('model unavailable'); return hypothesis(id, 'a final transcript'); } };
  const stream = new EnsembleStream({ models, result: () => {}, streamOptions: { intervalMs: 10000 } });
  stream.start(); const pcm = new Uint8Array(32000); new Int16Array(pcm.buffer).fill(2000); stream.receive(pcm);
  const result = await stream.finish(pcmWave([pcm])); assert.equal(result.text, 'a final transcript'); assert.deepEqual(result.unavailableModels, ['c']); assert.equal(stream.active, false);
});

test('interrupted model initialization requires explicit retry without removing downloaded files', async () => {
  const kv = memory(), first = new EnsembleModelStore({ kv }), model = { id: 'conformer', name: 'Conformer' };
  await first.beginPreparation(model); // Simulate termination without cleanup.
  const second = new EnsembleModelStore({ kv });
  await assert.rejects(second.beginPreparation(model), /interrupted/);
  const clear = await second.beginPreparation(model, { retry: true }); await clear();
  const clearAgain = await second.beginPreparation(model); await clearAgain();
});

test('one overloaded model does not end capture while another model is keeping up', async () => {
  const models = { entries: { fast: {}, slow: {} }, transcribe: async id => hypothesis(id, 'still recording') }; let stopped = false;
  const stream = new EnsembleStream({ models, result: () => {}, backlog: () => { stopped = true; } });
  stream.start(); const fast = stream.streams.get('fast'), slow = stream.streams.get('slow');
  fast.length = fast.completedEnd = 61 * 32000; slow.length = 61 * 32000; slow.completedEnd = 0;
  slow.backlog(); assert.equal(stopped, false); assert.equal(stream.active, true); assert.equal(slow.active, false); assert(stream.errors.has('slow')); stream.cancel();
});

test('large native model transfers yield to the event loop, bound hash chunks and keep integrity', async () => {
  const bytes = new Uint8Array(4 * 1024 * 1024).fill(42), kv = memory(); let ticks = 0, maxChunk = 0;
  const file = { bytes: bytes.length, sha256: hash(bytes), url: 'https://example.invalid' };
  const timer = setInterval(() => ticks++, 1);
  try {
    const store = new EnsembleModelStore({ kv, fetch: async () => new Response(bytes) });
    await store.ensure(file); assert(ticks > 0, 'native writes must not monopolize the main thread');
    const response = await store.verify(new Response(bytes), file), reader = response.body.getReader();
    for (;;) { const { done, value } = await reader.read(); if (done) break; maxChunk = Math.max(maxChunk, value.length); }
    assert(maxChunk <= 65536); assert.deepEqual(new Uint8Array(await (await store.read(file)).arrayBuffer()), bytes);
  } finally { clearInterval(timer); }
});
