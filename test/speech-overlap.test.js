import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeSpeechOverlap } from '../src/speech-overlap.js';
const value = (text, confidence = .8) => ({ text, words: [...text.matchAll(/\S+/g)].map(m => ({ text: m[0], start: m.index, end: m.index + m[0].length, confidence })) });
const merge = (a, b) => mergeSpeechOverlap(value(a), value(b));

test('overlap keeps the old beginning and adds only words after the shared suffix', () => {
  const r = merge('Remember the opening. We walked across the old stone bridge', 'across the old stone bridge before sunset.');
  assert.equal(r.text, 'Remember the opening. We walked across the old stone bridge before sunset.');
  assert(r.words.every(w => r.text.slice(w.start, w.end) === w.text));
});
test('a clipped or hallucinated opening is discarded when a later unique anchor joins the windows', () => {
  assert.equal(merge('Keep this. We walked across the old stone bridge', 'broken words to discard old stone bridge before sunset.').text,
    'Keep this. We walked across the old stone bridge before sunset.');
});
test('higher confidence resolves disagreements only inside matching anchors', () => {
  const old = value('At noon we crossed the cold stone bridge before the storm', .7);
  const next = value('we crossed the old stone bridge before the storm arrived.', .95);
  const r = mergeSpeechOverlap(old, next);
  assert.equal(r.text, 'At noon we crossed the old stone bridge before the storm arrived.');
  assert(r.words.every(w => r.text.slice(w.start, w.end) === w.text));
  assert(r.words.find(w => w.text === 'old').confidence === .95);
  assert.equal(mergeSpeechOverlap(next, value('we crossed the cold stone bridge before the storm arrived. slowly', .2)).text,
    'we crossed the old stone bridge before the storm arrived. slowly');
});
test('one vote cannot erase a word, confidence-less differences keep the previous reading', () => {
  assert.equal(merge('we should really cross the old stone bridge', 'we should cross the old stone bridge tomorrow').text,
    'we should really cross the old stone bridge tomorrow');
  assert.equal(mergeSpeechOverlap({ text: 'we crossed the cold stone bridge before the storm', words: [] }, value('we crossed the old stone bridge before the storm arrived')).text,
    'we crossed the cold stone bridge before the storm arrived');
});
test('short, repeated, unrelated or ambiguous matches cannot justify deleting overlap', () => {
  for (const [a, b] of [ ['the old bridge', 'old bridge tomorrow'], ['yes yes yes yes', 'yes yes yes again'],
    ['go to the bridge go to the bridge', 'go to the bridge then stop'], ['one two three', 'unrelated words follow'] ]) assert.equal(merge(a, b), null);
});

test('cut-off final words can be corrected using the interior of the next window', () => {
  const r = mergeSpeechOverlap(value('he finds the manner less interested', .9), value('he finds the manner less interesting than the matter', .9));
  assert.equal(r.text, 'he finds the manner less interesting than the matter');
  assert.equal(merge('yes yes yes', 'yes yes yes again'), null);
});

test('later detected punctuation survives equal or lower word confidence in an overlap', () => {
  for (const confidence of [.8, .2]) {
    const r = mergeSpeechOverlap(value('we walked across the old stone bridge at noon'), value('across the old stone bridge, at noon we stopped.', confidence));
    assert.equal(r.text, 'we walked across the old stone bridge, at noon we stopped.');
    assert(r.words.every(w => r.text.slice(w.start, w.end) === w.text));
    assert.equal(r.words.find(w => w.text === 'bridge').confidence, .8);
  }
  // Production confidence spans exclude punctuation, unlike whole-token fixtures.
  const lexical = text => ({ text, words: [...text.matchAll(/\w+/g)].map(m => ({ text: m[0], start: m.index, end: m.index + m[0].length, confidence: .8 })) });
  const r = mergeSpeechOverlap(lexical('we crossed the old stone bridge'), lexical('the old stone bridge. Then we stopped.'));
  assert.equal(r.text, 'we crossed the old stone bridge. Then we stopped.');
  assert(r.words.every(w => r.text.slice(w.start, w.end) === w.text));
});
test('punctuation updates do not rewrite lexical punctuation or erase existing marks', () => {
  assert.equal(merge('we saw the old stone bridge, at noon', 'the old stone bridge at noon we stopped.').text, 'we saw the old stone bridge, at noon we stopped.');
  assert.equal(mergeSpeechOverlap(value('we know it cannot cross the old stone bridge', .9), value('we know it can-not, cross the old stone bridge tomorrow', .2)).text,
    'we know it cannot cross the old stone bridge tomorrow');
});
