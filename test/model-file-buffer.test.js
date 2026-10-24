import test from 'node:test';
import assert from 'node:assert/strict';
import { modelFileBuffer } from '../src/model-file-buffer.js';

test('direct model reads wait for verified EOF, preserve all bytes and detach copied chunks', async () => {
  const chunks = [new Uint8Array([1, 2]), new Uint8Array([3, 4, 5])];
  let index = 0, cancelled = false, finish;
  const result = modelFileBuffer(5, async () => {
    if (index < chunks.length) return { bytes: chunks[index++].buffer };
    return new Promise(resolve => { finish = () => resolve({ done: true }); });
  }, () => { cancelled = true; });
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  assert(chunks.every(chunk => chunk.byteLength === 0));
  let settled = false; void result.then(() => { settled = true; });
  await Promise.resolve(); assert.equal(settled, false);
  finish(); assert.deepEqual([...new Uint8Array(await result)], [1, 2, 3, 4, 5]);
  assert.equal(cancelled, false, 'EOF has already released the cache handle');
});

test('integrity failure at EOF is propagated even after the expected byte count', async () => {
  const failure = Error('Model integrity check failed'); let reads = 0, cancelled = false;
  await assert.rejects(modelFileBuffer(2, async () => {
    if (reads++) throw failure;
    return { bytes: new Uint8Array([1, 2]).buffer };
  }, () => { cancelled = true; return new Promise(() => {}); }), error => error === failure);
  await Promise.resolve(); assert(cancelled, 'cleanup cannot delay the integrity error');
});

test('truncated and oversized model data are rejected without keeping transferred chunks', async () => {
  await assert.rejects(modelFileBuffer(3, async () => ({ done: true }), () => assert.fail('EOF is closed')), /Incomplete/);
  const chunk = new Uint8Array(4); let cancelled = false;
  await assert.rejects(modelFileBuffer(3, async () => ({ bytes: chunk.buffer }), () => { cancelled = true; }), /exceeds/);
  assert.equal(chunk.byteLength, 0); await Promise.resolve(); assert(cancelled);
});
