import test from 'node:test';
import assert from 'node:assert/strict';
import { SpeechStream } from '../src/speech-stream.js';
import { PcmMicrophone, pcmWave } from '../src/pcm-microphone.js';
import { PcmResampler } from '../src/speech-resampler.js';
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
const tone = seconds => {
  const bytes = new Uint8Array(seconds * 32000), view = new DataView(bytes.buffer);
  for (let at = 0; at < bytes.length; at += 2) view.setInt16(at, 4000, true);
  return bytes;
};

test('the shorter opening cadence returns to normal after the first visible word', async () => {
  const calls = [];
  const stream = new SpeechStream({ firstAudioMs: 250, firstIntervalMs: 0, intervalMs: 0,
    transcribe: async audio => { calls.push((audio.size - 44) / 32000); return { text: 'Hello' }; }, result: () => {} });
  try {
    stream.start(); stream.receive(tone(.25)); await tick(); assert.deepEqual(calls, [.25]);
    stream.receive(tone(.25)); await tick(); assert.equal(calls.length, 1);
    stream.receive(tone(.25)); await tick(); assert.deepEqual(calls, [.25, .75]);
  } finally { stream.cancel(); }
});
test('cold preparation uses accumulated PCM and cancellation prevents a stale decode', async () => {
  let ready; const calls = [];
  const stream = new SpeechStream({ intervalMs: 0,
    prepare: () => new Promise(resolve => { ready = resolve; }),
    transcribe: async audio => { calls.push((audio.size - 44) / 32000); return { text: 'The complete opening' }; }, result: () => {} });
  try {
    stream.start(); stream.receive(tone(.5)); await tick(); stream.receive(tone(2)); ready(); await tick();
    assert.deepEqual(calls, [2.5], 'the first inference includes audio captured during model loading');
    stream.start(); stream.receive(tone(.5)); await tick(); stream.cancel(); ready(); await tick();
    assert.deepEqual(calls, [2.5]);
  } finally { stream.cancel(); }
});

for (const windowSeconds of [15, 30, 60]) test(`${windowSeconds}s windows retain half their audio and pass the same decoder limit`, async () => {
  const calls = [];
  const stream = new SpeechStream({ windowSeconds, overlapSeconds: windowSeconds / 2, commitOnPause: false, intervalMs: 10000,
    transcribe: async (audio, options) => { calls.push({ seconds: (audio.size - 44) / 32000, limit: options.chunkSeconds }); return { text: 'A unique matching sentence ends here.', words: [] }; }, result: () => {} });
  stream.start();
  try {
    stream.receive(tone(windowSeconds)); await stream.run();
    assert.equal(stream.offset, windowSeconds / 2 * 32000);
    stream.receive(tone(windowSeconds / 2)); await stream.run();
    assert.equal(stream.offset, windowSeconds * 32000);
    assert.deepEqual(calls, [{ seconds: windowSeconds, limit: windowSeconds }, { seconds: windowSeconds, limit: windowSeconds }]);
    assert.equal(stream.latest.text, 'A unique matching sentence ends here.');
  } finally { stream.cancel(); }
});

test('pause commitment can be disabled for a true long-context comparison', async () => {
  const stream = new SpeechStream({ windowSeconds: 60, commitOnPause: false, intervalMs: 10000,
    transcribe: async () => ({ text: 'Keep this context.' }), result: () => {} });
  stream.start();
  try {
    stream.receive(tone(2)); stream.receive(new Uint8Array(32000)); await stream.run();
    assert.equal(stream.offset, 0);
    assert.equal(stream.completedEnd, 3 * 32000);
  } finally { stream.cancel(); }
});

test('invalid window sizes fail before recording begins', () => {
  for (const windowSeconds of [0, 1, 61, Infinity, NaN, '60']) assert.throws(() => new SpeechStream({ windowSeconds }), /between 2 and 60/);
});

test('a quiet phrase is committed before later speech can replace its beginning', async () => {
  const calls = [], updates = [];
  const stream = new SpeechStream({ intervalMs: 0, transcribe: async audio => {
    calls.push((audio.size - 44) / 32000);
    const text = calls.length === 1 ? 'Remember the beginning.' : 'And the next thought.';
    return { text, words: [{ text: text.split(' ')[0], start: 0, end: text.indexOf(' '), confidence: .9 }] };
  }, result: value => updates.push(value) });
  const first = tone(2), pause = new Uint8Array(.5 * 32000), second = tone(2);
  stream.start(); stream.receive(first); stream.receive(pause); await tick();
  assert.equal(stream.committed, 'Remember the beginning.');
  assert(stream.offset >= 2.4 * 32000 && stream.offset <= 2.5 * 32000);
  stream.receive(second); await tick();
  const result = await stream.finish(pcmWave([first, pause, second]));
  assert.equal(result.text, 'Remember the beginning. And the next thought.');
  assert.equal(calls.length, 2, 'release reuses completed streaming work');
  assert(updates.every(value => value.text.startsWith('Remember the beginning.')));
  assert(result.words.every(word => result.text.slice(word.start, word.end) === word.text));
});

test('a forced boundary never re-decodes less audio than the draft already covers', async () => {
  const ends = [];
  const stream = new SpeechStream({ intervalMs: 0, minAudioMs: 100, transcribe: async () => {
    ends.push(stream.lastEnd); return { text: 'The beginning stays.' };
  }, result: () => {} });
  stream.start(); stream.receive(new Uint8Array(14.8 * 32000)); await tick();
  stream.receive(new Uint8Array(.2 * 32000)); await tick();
  assert(ends[1] >= ends[0], `${ends[1]} must not rewind ${ends[0]}`);
  stream.cancel();
});

for (const silentError of [false, true]) test(`an ${silentError ? 'explicitly silent' : 'empty'} boundary decode retains previous words in the final review`, async () => {
  let calls = 0;
  const stream = new SpeechStream({ intervalMs: 0, transcribe: async () => {
    if (++calls === 2) { if (silentError) throw new Error('The recording is silent.'); return { text: '', words: [] }; }
    const text = calls === 1 ? 'Do not lose these words.' : 'The ending.';
    return { text, words: [{ text: text.split(' ')[0], start: 0, end: text.indexOf(' '), confidence: .8 }] };
  }, result: () => {} });
  stream.start(); stream.receive(new Uint8Array(14 * 32000)); await tick();
  stream.receive(new Uint8Array(32000)); await tick();
  stream.receive(new Uint8Array(2 * 32000)); await tick();
  const result = await stream.finish(pcmWave([new Uint8Array(17 * 32000)]));
  assert.equal(result.text, 'Do not lose these words. The ending.');
  assert(result.words.every(word => result.text.slice(word.start, word.end) === word.text));
});

test('short pauses and steady background energy do not chop a spoken phrase', async () => {
  for (const pcm of [tone(4), new Uint8Array([...tone(2), ...new Uint8Array(.2 * 32000), ...tone(1)])]) {
    const stream = new SpeechStream({ intervalMs: 0, transcribe: async () => ({ text: 'one continuous phrase' }), result: () => {} });
    stream.start(); stream.receive(pcm); await tick();
    assert.equal(stream.offset, 0); stream.cancel();
  }
});

test('release reuses the in-flight draft when it already covers the complete audio', async () => {
  const calls = [];
  const stream = new SpeechStream({ intervalMs: 0, transcribe: (audio, options) => new Promise(resolve => calls.push({ audio, options, resolve })), result: () => {} });
  const pcm = new Uint8Array(2 * 32000);
  stream.start(); stream.receive(pcm); await tick();
  const final = stream.finish(pcmWave([pcm])); await tick();
  assert.equal(calls.length, 1); assert.equal(calls[0].options.signal.aborted, false);
  calls[0].resolve({ text: 'The existing draft.', words: [{ start: 0, end: 3, confidence: .9 }], backend: 'wasm', transcribeMs: 10 });
  const response = await final;
  assert.equal(response.text, 'The existing draft.'); assert.equal(response.partial, false); assert.equal(response.seconds, 2);
  assert.equal(response.words[0].confidence, .9); assert.equal(calls.length, 1);
});

test('release processes the unfinished window and microphone flush, preserving committed text and offsets', async () => {
  const calls = [];
  const stream = new SpeechStream({ intervalMs: 0, transcribe: async audio => {
    calls.push(audio.size); return { text: calls.length === 1 ? 'First' : 'tail', words: [{ start: 0, end: calls.length === 1 ? 5 : 4 }] };
  }, result: () => {} });
  stream.start(); stream.receive(new Uint8Array(15 * 32000)); await tick();
  const committedEnd = stream.offset; assert(committedEnd > 0);
  const response = await stream.finish(pcmWave([new Uint8Array(15 * 32000 + 1600)]));
  assert.equal(response.text, 'First tail'); assert.deepEqual(response.words.map(w => w.start), [0, 6]);
  assert.equal(calls.at(-1), 44 + 15 * 32000 + 1600 - committedEnd);
  assert(calls.every(size => size <= 44 + 15 * 32000));
});

test('release with no live draft decodes short audio, but already-completed audio is never decoded twice', async () => {
  let calls = 0;
  const stream = new SpeechStream({ intervalMs: 0, transcribe: async () => { calls++; return { text: 'short' }; }, result: () => {} });
  stream.start(); stream.receive(new Uint8Array(6400));
  assert.equal((await stream.finish(pcmWave([new Uint8Array(6400)]))).text, 'short'); assert.equal(calls, 1);
  stream.start(); stream.receive(new Uint8Array(64000)); await tick();
  assert.equal((await stream.finish(pcmWave([new Uint8Array(64000)]))).text, 'short'); assert.equal(calls, 2);
});

test('cancelling release invalidates a late result without affecting a new recording', async () => {
  const calls = [], results = [];
  const stream = new SpeechStream({ intervalMs: 0, transcribe: (audio, options) => new Promise(resolve => calls.push({ resolve, options })), result: r => results.push(r) });
  stream.start(); stream.receive(new Uint8Array(64000)); await tick();
  const abort = new AbortController();
  const final = stream.finish(pcmWave([new Uint8Array(64000)]), { signal: abort.signal });
  const rejected = assert.rejects(final, { name: 'AbortError' }); await tick(); abort.abort();
  stream.start(); stream.receive(new Uint8Array(64000)); await tick();
  calls[0].resolve({ text: 'stale' }); await rejected;
  assert(calls[0].options.signal.aborted); assert(!calls[1].options.signal.aborted);
  calls[1].resolve({ text: 'new recording' }); await tick();
  assert.deepEqual(results.map(r => r.text), ['new recording']); stream.cancel();
});

test('silence during release preserves the draft; mismatched recordings are rejected', async () => {
  let calls = 0;
  const stream = new SpeechStream({ intervalMs: 0, transcribe: async () => { if (calls++) throw new Error('The recording is silent.'); return { text: 'draft' }; }, result: () => {} });
  stream.start(); stream.receive(new Uint8Array(64000)); await tick();
  assert.equal((await stream.finish(pcmWave([new Uint8Array(67200)]))).text, 'draft');
  stream.start(); stream.receive(new Uint8Array(6400));
  await assert.rejects(stream.finish(pcmWave([new Uint8Array(6400).fill(1)])), /same recording/);
});

test('an already-aborted finish cancels pending inference', async () => {
  let pending;
  const stream = new SpeechStream({ intervalMs: 0, transcribe: (audio, options) => new Promise(resolve => { pending = { options, resolve }; }), result: () => assert.fail('Cancelled result') });
  stream.start(); stream.receive(new Uint8Array(64000)); await tick();
  await assert.rejects(stream.finish(pcmWave([new Uint8Array(64000)]), { signal: AbortSignal.abort() }), { name: 'AbortError' });
  assert(pending.options.signal.aborted); pending.resolve({ text: 'stale' }); await tick();
});

test('a result callback can start a new recording without inheriting old committed text', async () => {
  const stream = new SpeechStream({ intervalMs: 0, transcribe: async () => ({ text: 'old' }), result: () => stream.start() });
  stream.start(); stream.receive(new Uint8Array(15 * 32000)); await tick();
  assert.equal(stream.committed, ''); assert.equal(stream.offset, 0); assert.equal(stream.length, 0); stream.cancel();
});

test('incremental audio coalesces while inference is slow; release ignores a late result', async () => {
  const calls = [], results = [];
  const stream = new SpeechStream({ intervalMs: 0, transcribe: (audio, options) => new Promise(resolve => calls.push({ audio, options, resolve })), result: value => results.push(value) });
  stream.start(['Pageborne']); stream.receive(new Uint8Array(12800)); await tick(); assert.equal(calls.length, 0);
  stream.receive(new Uint8Array(35200)); await tick(); assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].options.vocabulary, ['Pageborne']); assert.equal(calls[0].options.partial, true);
  for (let i = 0; i < 20; i++) stream.receive(new Uint8Array(3200));
  await tick(); assert.equal(calls.length, 1, 'No backlog of PCM-frame requests');
  calls[0].resolve({ text: 'first draft', words: [] }); await tick(); assert.equal(results.length, 1); assert.equal(calls.length, 2);
  assert.equal(calls[1].audio.size, 44 + 112000);
  stream.cancel(); assert(calls[1].options.signal.aborted);
  calls[1].resolve({ text: 'late' }); await tick(); assert.equal(results.length, 1);
});

test('long streaming recordings advance bounded windows and keep word offsets valid', async () => {
  const calls = [], results = [];
  const stream = new SpeechStream({ intervalMs: 0, transcribe: async audio => {
    calls.push(audio.size); return { text: 'word', words: [{ start: 0, end: 4, confidence: .5 }] };
  }, result: value => results.push(value) });
  stream.start(); stream.receive(new Uint8Array(36 * 32000));
  for (let i = 0; i < 15 && calls.length < 3; i++) await tick();
  assert.equal(calls.length, 3); assert(calls.every(size => size <= 44 + 15 * 32000));
  assert.equal(results.at(-1).text, 'word word word');
  assert.deepEqual(results.at(-1).words.map(w => w.start), [0, 5, 10]); stream.cancel();
});

test('a cancelled preload does not overwrite a new recording; silence does not fail capture', async () => {
  const calls = [], results = [], failures = [];
  const stream = new SpeechStream({ intervalMs: 0, transcribe: () => new Promise((resolve, reject) => calls.push({ resolve, reject })), result: r => results.push(r), failure: e => failures.push(e) });
  stream.start(); stream.receive(new Uint8Array(64000)); await tick();
  stream.start(); stream.receive(new Uint8Array(64000)); await tick();
  calls[0].resolve({ text: 'stale' }); calls[1].reject(new Error('The recording is silent.')); await tick();
  assert.deepEqual(results, []); assert.deepEqual(failures, []); assert(stream.active); stream.cancel();
});

test('PCM frames are delivered incrementally, copied, and bounded by the recording limit', async () => {
  const chunks = []; const mic = new PcmMicrophone(async () => true, () => {}, bytes => chunks.push(bytes));
  mic.receive(new Uint8Array([1, 2])); assert.equal(chunks.length, 0);
  await mic.start(); const input = new Uint8Array([1, 2, 3, 4]); mic.receive(input); input[0] = 99;
  assert.deepEqual([...chunks[0]], [1, 2, 3, 4]); await mic.stop(); mic.receive(input); assert.equal(chunks.length, 1);
});

test('browser PCM resampling preserves duration across fractional chunk boundaries and flushes the tail', () => {
  for (const rate of [16000, 44100, 48000]) {
    const chunks = [], resampler = new PcmResampler(rate, bytes => chunks.push(bytes));
    const input = new Float32Array(rate + 123).fill(.5);
    for (let i = 0; i < input.length; i += 128) resampler.push([input.subarray(i, i + 128)]);
    resampler.flush();
    const count = chunks.reduce((sum, bytes) => sum + bytes.length / 2, 0);
    assert.equal(count, Math.floor(input.length * 16000 / rate));
    assert(chunks.every(bytes => bytes.length <= 3200));
    assert.equal(new DataView(chunks.at(-1).buffer).getInt16(0, true), 16384);
  }
});


test('words reach the caller before decode completes without rewinding on the next pass', async () => {
  const calls = [], results = [];
  const stream = new SpeechStream({ intervalMs: 0, transcribe: (audio, options) => new Promise(resolve => calls.push({ resolve, options })), result: value => results.push(value) });
  stream.start(); stream.receive(new Uint8Array(16000)); await tick();
  assert.equal(calls.length, 1, 'start with half a second of audio');
  calls[0].options.onPartial({ text: 'Hello', words: [{ start: 0, end: 5, confidence: .4 }] });
  assert.equal(results.at(-1).text, 'Hello'); assert.equal(results.at(-1).words[0].confidence, .4);
  calls[0].options.onPartial({ text: 'Hello there', words: [] });
  assert.equal(results.at(-1).text, 'Hello there'); assert.equal(stream.completedEnd, 0);
  stream.receive(new Uint8Array(16000)); calls[0].resolve({ text: 'Hello there', words: [] }); await tick();
  const count = results.length;
  calls[1].options.onPartial({ text: 'Hello', words: [] }); assert.equal(results.length, count, 'no shrinking prefix');
  calls[1].options.onPartial({ text: 'Hello there again', words: [] }); assert.equal(results.at(-1).text, 'Hello there again');
  stream.cancel(); calls[1].options.onPartial({ text: 'This stale result must not show', words: [] });
  calls[1].resolve({ text: 'stale' }); await tick(); assert.equal(results.at(-1).text, 'Hello there again');
});

test('streamed words after a committed window have global confidence offsets', async () => {
  let calls = 0; const results = [];
  const stream = new SpeechStream({ intervalMs: 0, transcribe: async (audio, options) => {
    const text = calls++ ? 'tail' : 'First';
    const words = [{ start: 0, end: text.length, text, confidence: .9 }];
    options.onPartial({ text, words }); return { text, words };
  }, result: value => results.push(value) });
  stream.start(); stream.receive(new Uint8Array(16 * 32000));
  for (let i = 0; i < 10 && calls < 2; i++) await tick();
  const partial = results.find(value => value.partial && value.text === 'First tail');
  assert.deepEqual(partial.words.map(word => word.start), [0, 6]);
  assert(partial.words.every(word => partial.text.slice(word.start, word.end) === word.text)); stream.cancel();
});

test('half-window overlap keeps full acoustic passes and accepts a clipped opening', async () => {
  const calls = [];
  const stream = new SpeechStream({ overlapSeconds: 7.5, intervalMs: 0, transcribe: async audio => {
    calls.push({ start: stream.offset / 32000, end: stream.lastEnd / 32000, seconds: (audio.size - 44) / 32000 });
    return { text: calls.length === 1 ? 'The beginning stays. We walked across the old stone bridge' : 'clipped noise old stone bridge before sunset.' };
  }, result: () => {} });
  const mic = new PcmMicrophone(async () => true, () => assert.fail('No recording cap'), bytes => stream.receive(bytes));
  stream.start(); await mic.start({ retainAudio: false });
  mic.receive(tone(15)); await tick();
  assert.equal(stream.offset, 7.5 * 32000); assert.equal(stream.base, stream.offset);
  mic.receive(tone(7.5)); await tick();
  const result = await stream.finish(await mic.stop());
  assert.equal(result.text, 'The beginning stays. We walked across the old stone bridge before sunset.');
  assert.deepEqual(calls, [{ start: 0, end: 15, seconds: 15 }, { start: 7.5, end: 22.5, seconds: 15 }]);
});

test('unmatched overlap falls back to new-only audio without erasing the previous words', async () => {
  const lengths = [];
  const stream = new SpeechStream({ overlapSeconds: 7.5, intervalMs: 0, transcribe: async audio => {
    lengths.push((audio.size - 44) / 32000);
    return { text: ['Keep every previous word.', 'unrelated overlap', 'The new words.'][lengths.length - 1] };
  }, result: () => {} });
  stream.start(); const mic = new PcmMicrophone(async () => true, () => {}, bytes => stream.receive(bytes));
  await mic.start({ retainAudio: false }); mic.receive(tone(15)); await tick(); mic.receive(tone(7.5)); await tick();
  assert.equal((await stream.finish(await mic.stop())).text, 'Keep every previous word. The new words.');
  assert.deepEqual(lengths, [15, 15, 7.5]);
});

test('multi-minute stream-only capture rolls storage, preserves every phrase and flushes final PCM', async () => {
  let index = 0, peak = 0; const calls = [];
  const stream = new SpeechStream({ overlapSeconds: 7.5, intervalMs: 0, transcribe: async audio => {
    calls.push(audio.size); const text = `Phrase${++index}`; return { text, words: [{ start: 0, end: text.length, text, confidence: .9 }] };
  }, result: () => {} });
  let mic;
  mic = new PcmMicrophone(async open => { if (!open) mic.receive(tone(.2), true); return true; }, () => assert.fail('No 60 second cap'), bytes => stream.receive(bytes));
  stream.start(); await mic.start({ retainAudio: false });
  for (let i = 0; i < 100; i++) {
    mic.receive(tone(2)); mic.receive(new Uint8Array(16000)); await tick();
    peak = Math.max(peak, stream.bytes.byteLength); assert.equal(mic.chunks.length, 0);
  }
  const receipt = await mic.stop(), result = await stream.finish(receipt);
  assert.equal(receipt.seconds, 250.2); assert.equal(result.seconds, 250.2);
  assert.equal(result.text, Array.from({ length: 101 }, (_, i) => `Phrase${i + 1}`).join(' '));
  assert(result.words.every(w => result.text.slice(w.start, w.end) === w.text));
  assert(peak <= 30 * 32000); assert(calls.every(size => size <= 44 + 15 * 32000));
});

test('missing flushed audio or an overrun is reported rather than silently discarded', async () => {
  const errors = []; let backlog = 0;
  const stream = new SpeechStream({ intervalMs: 10000, transcribe: async () => ({ text: 'unused' }), result: () => {}, failure: e => errors.push(e), backlog: () => backlog++ });
  stream.start(); stream.receive(tone(1));
  await assert.rejects(stream.finish({ kind: 'pcm-stream', bytes: 32002, checksum: stream.checksum }), /same recording/);
  stream.start(); stream.receive(new Uint8Array(61 * 32000)); assert.equal(backlog, 1);
  assert.throws(() => stream.receive(new Uint8Array(60 * 32000)), /fell too far behind/);
  assert.equal(errors.length, 1); assert.equal(stream.active, false);
});

test('earlier repeated sentences outside the adjacent audio window do not invalidate a later overlap', async () => {
  const passages = ['Opening phrase. We crossed the old stone bridge', 'old stone bridge before reaching the river bank.',
    'reaching the river bank. We crossed the old stone bridge', 'old stone bridge before going home.'];
  let calls = 0;
  const stream = new SpeechStream({ overlapSeconds: 7.5, intervalMs: 0, transcribe: async () => ({ text: passages[calls++] }), result: () => {} });
  const mic = new PcmMicrophone(async () => true, () => {}, b => stream.receive(b));
  stream.start(); await mic.start({ retainAudio: false }); mic.receive(tone(15)); await tick();
  for (let i = 0; i < 3; i++) { mic.receive(tone(7.5)); await tick(); }
  assert.equal((await stream.finish(await mic.stop())).text, 'Opening phrase. We crossed the old stone bridge before reaching the river bank. We crossed the old stone bridge before going home.');
  assert.equal(calls, 4, 'do not fall back just because a prior window mentioned the same bridge');
});

test('cancelling an ambiguous-overlap fallback cannot replace a new recording', async () => {
  const pending = [], updates = [];
  const stream = new SpeechStream({ overlapSeconds: 7.5, intervalMs: 0, transcribe: (audio, options) => new Promise(resolve => pending.push({ resolve, options })), result: v => updates.push(v.text) });
  stream.start(); stream.receive(tone(15)); await tick(); pending[0].resolve({ text: 'Keep the previous complete words.' }); await tick();
  stream.receive(tone(7.5)); await tick(); pending[1].resolve({ text: 'An unrelated partial.' }); await tick();
  assert.equal(pending.length, 3); stream.cancel(); assert(pending[2].options.signal.aborted);
  stream.start(); stream.receive(tone(1)); await tick();
  pending[2].resolve({ text: 'Stale fallback.' }); pending[3].resolve({ text: 'The new recording.' }); await tick();
  assert.deepEqual(updates, ['Keep the previous complete words.', 'The new recording.']); stream.cancel();
});
