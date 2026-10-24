import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSpeechSessions, releaseModelBuffer, setSessionLoadReporter } from '../src/speech-session-loader.js';

test('initialization waits for the durable phase checkpoint and releases staging bytes on checkpoint failure', async () => {
  const calls = []; let release;
  setSessionLoadReporter(async (name, phase) => {
    calls.push(phase);
    if (phase === 'initializing') await new Promise(resolve => { release = resolve; });
  });
  try {
    const loading = loadSpeechSessions(['encoder'], async () => ({ buffer_or_path: new Uint8Array(4) }), async () => { calls.push('create'); return {}; });
    while (!release) await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, ['reading', 'initializing']);
    release(); await loading; assert.deepEqual(calls, ['reading', 'initializing', 'create', 'ready']);
    const buffer = new Uint8Array(4);
    setSessionLoadReporter((name, phase) => { if (phase === 'initializing') throw Error('checkpoint failed'); });
    await assert.rejects(loadSpeechSessions(['encoder'], async () => ({ buffer_or_path: buffer }), () => assert.fail('must not initialize')), /checkpoint failed/);
    assert.equal(buffer.byteLength, 0);
  } finally { setSessionLoadReporter(() => {}); }
});
import { serialSpeechSessions } from '../scripts/serial-speech-sessions.mjs';
import { readFile } from 'node:fs/promises';

test('next weights are not read until the prior session initializes and its staging buffer is detached', async () => {
  let release, first;
  const calls = [], phases = [];
  setSessionLoadReporter((name, phase) => phases.push([name, phase]));
  const loaded = loadSpeechSessions(['encoder', 'decoder'], async name => {
    calls.push(`read:${name}`);
    if (name === 'decoder') assert.equal(first.byteLength, 0);
    const buffer_or_path = new Uint8Array([1, 2, 3]);
    if (name === 'encoder') first = buffer_or_path;
    return { buffer_or_path, name };
  }, async ({ buffer_or_path, name }) => {
    calls.push(`create:${name}`);
    if (name === 'encoder') await new Promise(resolve => { release = resolve; });
    assert.deepEqual([...buffer_or_path], [1, 2, 3], 'buffer survives until runtime consumes it');
    return { name };
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['read:encoder', 'create:encoder']); release();
  assert.deepEqual(Object.keys(await loaded), ['encoder', 'decoder']);
  assert.deepEqual(calls, ['read:encoder', 'create:encoder', 'read:decoder', 'create:decoder']);
  assert.equal(first.byteLength, 0);
  assert.deepEqual(phases, ['encoder', 'decoder'].flatMap(name => ['reading', 'initializing', 'ready'].map(phase => [name, phase])));
  setSessionLoadReporter(() => {});
});
test('initialization failure frees staging and prior sessions, preserving the cause', async () => {
  let released = 0; const buffers = [], failure = new Error('GPU allocation failed');
  await assert.rejects(loadSpeechSessions(['encoder', 'decoder'], async name => {
    const buffer_or_path = new Uint8Array([1]); buffers.push(buffer_or_path); return { name, buffer_or_path };
  }, async data => {
    if (data.name === 'decoder') throw failure;
    return { release() { released++; } };
  }), error => error === failure);
  assert.equal(released, 1); assert(buffers.every(buffer => buffer.byteLength === 0));
});
test('a failed read disposes prior sessions; non-owned buffers and paths are untouched', async () => {
  let released = false;
  await assert.rejects(loadSpeechSessions(['a', 'b'], async name => {
    if (name === 'b') throw new Error('checksum'); return { buffer_or_path: 'local-file' };
  }, async () => ({ release() { released = true; throw new Error('cleanup error'); } })), /checksum/);
  assert(released);
  const full = new Uint8Array(10); releaseModelBuffer(full.subarray(1)); assert.equal(full.byteLength, 10);
  releaseModelBuffer('file');
});
test('pinned Transformers loader is adapted and source changes fail closed', async () => {
  const plugin = serialSpeechSessions(); plugin.buildStart();
  const id = new URL('../node_modules/@huggingface/transformers/dist/transformers.web.js', import.meta.url).pathname;
  const code = await readFile(id, 'utf8'); const output = plugin.transform(code, id);
  assert(output.includes('return loadSpeechSessions(Object.keys(names)')); plugin.buildEnd();
  assert.throws(() => plugin.transform('changed upstream', id), /changed/);
  plugin.buildStart(); assert.throws(() => plugin.buildEnd(), /not applied/);
});
