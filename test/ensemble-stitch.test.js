import test from 'node:test';
import assert from 'node:assert/strict';
import {stitch} from '../scripts/ensemble/stitch.mjs';

const group = {window:15, shift:0, hints:true};
function part(text, start, end, extra={}) {
  return {...group, text, start, end, words:[...text.matchAll(/\S+/g)].map(m => ({text:m[0], start:m.index, end:m.index+m[0].length, confidence:.9})), ...extra};
}
function run(windows) { return stitch({model:'test', case:'case', windows}, group); }
test('overlapping windows preserve the prefix and trim native leading spaces', () => {
  const out = run([part('  The first part before the middle of this sentence',0,15),part('the middle of this sentence continues into the next paragraph',7.5,22.5),part('into the next paragraph we read more words',15,30)]);
  assert.equal(out.text,'The first part before the middle of this sentence continues into the next paragraph we read more words');
  assert.equal(out.seconds,30);
  for (const w of out.words) assert.equal(out.text.slice(w.start,w.end), w.text);
});
test('unrelated overlap is not appended wholesale; the new-audio fallback is required', () => {
  const windows=[part('a properly recognized first phrase',0,15),part('completely wrong output with no anchors',7.5,22.5)];
  assert.deepEqual(run(windows).missing.map(x=>[x.start,x.end]), [[15,22.5]]);
  windows.push(part('a newly decoded ending',15,22.5,{fallback:true}));
  const out=run(windows);
  assert.equal(out.text,'a properly recognized first phrase a newly decoded ending');
  assert.equal(out.fallbacks,1);
});
test('a clipped start can align at a later unique anchor', () => {
  const out=run([part('we are near the center of the first section',0,15),part('garbled fragment center of the first section and now we continue',7.5,22.5)]);
  assert.equal(out.text,'we are near the center of the first section and now we continue');
});
