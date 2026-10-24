import test from 'node:test';
import assert from 'node:assert/strict';
import { vocabularyBias, whisperVocabularyPrompt } from '../src/speech-vocabulary.js';

test('Tiny biases plausible term prefixes with a bounded boost and never rescues suppressed tokens', () => {
  const tokenizer = { all_special_ids: [9], encode: () => [2, 3] };
  const bias = vocabularyBias(tokenizer, ['Quilter']);
  const logits = { data: new Float32Array([0, 0, -.2, -.5, -10]) };
  assert.equal(bias([[1n]], logits).get(2), .6);
  assert.equal(bias([[1n, 2n]], logits).get(3), 1.2);
  logits.data[3] = -Infinity; assert(!bias([[2n]], logits).has(3));
  assert.equal(logits.data[2], Math.fround(-.2), 'Bias calculation does not alter confidence inputs');
});

test('Whisper fills its 223-token previous-text allowance with whole terms and no special tokens', () => {
  const tokenizer = { all_special_ids: [90], encode: text => [...text].map(char => char === '!' ? 90 : 5) };
  const config = { prev_sot_token_id: 90, decoder_start_token_id: 91, no_timestamps_token_id: 92 };
  const { prefix, terms } = whisperVocabularyPrompt(tokenizer, config, ['JEV!', 'Kantorowicz']);
  assert.deepEqual(terms, ['Kantorowicz']);
  assert.equal(prefix[0], 90); assert.deepEqual(prefix.slice(-2), [91, 92]); assert(!prefix.slice(1, -2).includes(90));
  const full = whisperVocabularyPrompt(tokenizer, config, Array(200).fill('long custom term'));
  assert(full.prefix.length > 131 && full.prefix.length <= 226); assert.equal(full.tokenBudget, 223);
  assert.equal(whisperVocabularyPrompt(tokenizer, config, []).prefix, null);
  assert.equal(whisperVocabularyPrompt(tokenizer, {}, ['word']).prefix, null);
});

test('Whisper skips a term that will not fit and uses smaller lower-ranked terms to fill the remainder', () => {
  const tokenizer = { encode: text => Array(({ ' first.': 7, ' larger.': 3, ' last.': 2 })[text]).fill(1) };
  const config = { prev_sot_token_id: 90, decoder_start_token_id: 91, no_timestamps_token_id: 92 };
  const { prefix, terms, tokenBudget } = whisperVocabularyPrompt(tokenizer, config, ['first', 'larger', 'last'], 20);
  assert.deepEqual(terms, ['first', 'last']); assert.equal(tokenBudget, 9); assert.equal(prefix.length, 12);
});
