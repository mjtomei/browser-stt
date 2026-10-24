import test from 'node:test';
import assert from 'node:assert/strict';
import { confidenceWords, classifyWords, confidenceOptions } from '../src/speech-confidence.js';
import { LocalSpeech } from '../src/local-speech.js';

test('per-word raw probabilities, aggregates and independently configured binary rules', () => {
  const pieces = [' sun', 'shine', '!'];
  const words = confidenceWords('sunshine!', [.8, 1, .001].map((probability, token) => ({ token, probability })), ids => ids.map(id => pieces[id]).join(''),
    { metric: 'mean', threshold: .9, rules: { cautious: { metric: 'minimum', threshold: .9 }, tolerant: { metric: 'minimum', threshold: .8 } } });
  assert.equal(words[0].confidence, .9); assert.equal(words[0].confident, true);
  assert.deepEqual(words[0].scores, { minimum: .8, mean: .9, geometricMean: Math.sqrt(.8) });
  assert.deepEqual(words[0].flags, { cautious: false, tolerant: true });
  assert.deepEqual(words[0].tokens, [{ token: 0, probability: .8 }, { token: 1, probability: 1 }]);
  assert.equal(classifyWords(words)[0].confident, false);
  assert.equal(classifyWords(words, { metric: 'geometricMean', threshold: .8 })[0].confident, true);
  assert.equal(words[0].confident, true, 'Reclassification does not mutate the saved transcript');
});
test('unknown evidence stays unknown; zero is evidence; invalid policy fails explicitly', () => {
  assert.equal(classifyWords([{ start: 0, end: 4 }])[0].confident, null);
  for (const score of [NaN, -1, 1.2, null]) assert.equal(classifyWords([{ confidence: score }])[0].confident, null);
  const words = confidenceWords('word', [{ token: 0, probability: 0 }], () => 'word');
  assert.equal(words[0].scores.geometricMean, 0); assert.equal(words[0].confident, false);
  assert.equal(classifyWords(words, { threshold: 0 })[0].confident, true);
  for (const threshold of [-1, 2, NaN, null]) assert.throws(() => confidenceOptions({ threshold }), /threshold/);
  assert.throws(() => confidenceOptions({ metric: 'made-up' }), /metric/);
});
test('worker requests carry confidence policy and bad policies do not start a worker', async () => {
  const sent = []; const worker = { postMessage(data) { sent.push(data); queueMicrotask(() => this.onmessage({ data: { id: data.id, result: {} } })); }, terminate() {} };
  const speech = new LocalSpeech({ base: 'https://example.test/stt/', createWorker: () => worker, idleMs: 0, confidence: { metric: 'mean', threshold: .8 } });
  try {
    await speech.prepare('wasm'); assert.equal(sent[0].confidence.metric, 'mean');
    await speech.transcribe('wasm', new Blob([]), { confidence: { metric: 'minimum', threshold: .95 } });
    assert.equal(sent[1].confidence.threshold, .95);
    await assert.rejects(speech.prepare('wasm', { confidence: { threshold: 5 } }), /threshold/);
    assert.equal(sent.length, 2);
  } finally { speech.close(); }
});
