import test from 'node:test';
import assert from 'node:assert/strict';
import { EnsembleSpeech } from '../src/ensemble-speech.js';
import { ensembleVerificationKey } from '../src/ensemble-verification.js';
const delay = ms => new Promise(r => setTimeout(r, ms));
test('stream-only releases accept the existing 0.1.16 receipt identity', () => {
  const model = { id: 'fixture', directory: 'test', files: [{ file: 'model', bytes: 3, sha256: 'abc' }] };
  assert.equal(ensembleVerificationKey(model, 'same-device'), 'bc66893a72cf250610cd0683f0bd431d90c8c3b15c2840b2275a0a5197f68d6d');
});
test('cancelling a readiness wait is prompt and leaves shared initialization usable', async () => {
  const models = new EnsembleSpeech({ base: 'https://app.test/stt/' });
  let complete;
  const original = models.prepare;
  const shared = new Promise(resolve => { complete = resolve; });
  models.prepare = (id, options) => options?.signal ? original.call(models, id, options) : shared;
  const cancel = new AbortController(), waiting = models.prepare('moonshine', { signal: cancel.signal });
  cancel.abort(); await assert.rejects(waiting, { name: 'AbortError' });
  complete({ verified: true }); assert.deepEqual(await models.prepare('moonshine'), { verified: true });
});
test('initialization is serialized, resident reuse is stable, and cancellation does not cancel shared preparation', async () => {
  const previous = globalThis.Worker; let active = 0, peak = 0, prepared = 0, created = 0, cleared = 0;
  globalThis.Worker = class {
    constructor() { created++; }
    postMessage(data) {
      if (data.operation === 'cancel') return;
      if (data.operation === 'prepare') { active++; peak = Math.max(peak, active); prepared++; }
      setTimeout(() => {
        if (data.operation === 'prepare') active--;
        if (!this.closed) this.onmessage({ data: { id: data.id, result: { text: 'ready', words: [], verified: true, model: data.model?.name, backend: 'wasm' } } });
      }, 15);
    }
    terminate() { this.closed = true; }
  };
  const store = { ensure: async () => {}, beginPreparation: async () => async () => { cleared++; }, cancel() {} };
  const models = new EnsembleSpeech({ base: 'https://app.test/stt/', store });
  try {
    const loading = models.open();
    const abort = new AbortController(); const request = models.transcribe('moonshine', new Blob([]), { signal: abort.signal }); abort.abort();
    await assert.rejects(request, { name: 'AbortError' });
    assert((await loading).every(r => r.status === 'fulfilled')); assert.equal(peak, 1); assert.equal(created, 3); assert.equal(cleared, 3);
    await models.open(); assert.equal(prepared, 3);
    const cancelled = new AbortController(), pending = models.transcribe('conformer', new Blob([]), { signal: cancelled.signal });
    await delay(1); cancelled.abort(); await assert.rejects(pending, { name: 'AbortError' });
    await models.transcribe('conformer', new Blob([])); assert.equal(models.entries.conformer.state, 'ready');
    models.close(); assert(Object.values(models.entries).every(e => e.state === 'idle'));
    await models.open(); assert.equal(created, 6);
  } finally { models.close(); globalThis.Worker = previous; }
});

test('setup exposes byte/stage progress and refuses a worker that did not pass inference', async () => {
  const previous = globalThis.Worker; let verified = false, prepared = 0;
  globalThis.Worker = class {
    postMessage(data) {
      if (data.operation !== 'prepare') return;
      prepared++;
      queueMicrotask(() => {
        this.onmessage({ data: { id: data.id, progress: { stage: 'checking', loadedBytes: 1234 } } });
        this.onmessage({ data: { id: data.id, result: { verified, backend: 'wasm' } } });
      });
    }
    terminate() {}
  };
  const stages = [], store = { ensure: async (file, progress) => progress(file.bytes), beginPreparation: async () => async () => {}, cancel() {} };
  let models;
  models = new EnsembleSpeech({ base: 'https://app.test/stt/', store, changed: () => stages.push(models.entries.conformer.setup.stage) });
  try {
    await assert.rejects(models.prepare('conformer'), /check did not pass/);
    assert.equal(models.entries.conformer.state, 'error'); assert(stages.includes('checking'));
    assert.equal(models.entries.conformer.downloadBytes, models.entries.conformer.totalBytes);
    await assert.rejects(models.prepare('conformer')); assert.equal(prepared, 1);
    verified = true; await models.prepare('conformer', { retry: true });
    assert.equal(models.entries.conformer.setup.stage, 'ready'); assert.equal(models.entries.conformer.ready.verified, true);
  } finally { models.close(); globalThis.Worker = previous; }
});

test('failed setup terminates the worker and exposes its cause without waiting for storage cleanup', async () => {
  const previous = globalThis.Worker; let fail = true, cleanupCalls = 0, closed = 0;
  globalThis.Worker = class {
    postMessage(data) {
      if (data.operation !== 'prepare') return;
      queueMicrotask(() => {
        this.onmessage({ data: { id: data.id, progress: { stage: 'initializing', component: 'decoder', loadedBytes: 500 } } });
        this.onmessage({ data: fail ? { id: data.id, error: 'allocation failed', errorName: 'RangeError', errorStack: 'worker-origin-stack' }
          : { id: data.id, result: { verified: true } } });
      });
    }
    terminate() { closed++; }
  };
  const store = { ensure: async () => {}, beginPreparation: async () => async () => {
    cleanupCalls++; if (fail) await new Promise(() => {});
  } };
  const models = new EnsembleSpeech({ base: 'https://app.test/stt/', store });
  try {
    await assert.rejects(models.prepare('moonshine'), e => e.name === 'RangeError' && e.message === 'allocation failed' && e.stack === 'worker-origin-stack');
    assert(closed > 0); assert.equal(cleanupCalls, 0); assert.equal(models.entries.moonshine.state, 'error');
    assert.equal(models.entries.moonshine.setup.component, 'decoder');
    assert(models.entries.moonshine.setup.stageStartedAt > 0);
    fail = false; await models.prepare('moonshine', { retry: true });
    assert.equal(cleanupCalls, 1); assert.equal(models.entries.moonshine.state, 'ready');
  } finally { models.close(); globalThis.Worker = previous; }
});

test('a stalled setup times out with its model and last file even if storage cleanup would hang', async t => {
  const previous = globalThis.Worker; let terminated = false;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  globalThis.Worker = class {
    postMessage(data) {
      if (data.operation === 'prepare') queueMicrotask(() => this.onmessage({ data: { id: data.id,
        progress: { stage: 'loading', file: 'encoder_model.onnx', loadedBytes: 42 } } }));
    }
    terminate() { terminated = true; }
  };
  const store = { ensure: async () => {}, beginPreparation: async () => () => new Promise(() => {}) };
  const models = new EnsembleSpeech({ base: 'https://app.test/stt/', store });
  try {
    const pending = assert.rejects(models.prepare('moonshine'), /Moonshine Base setup stopped responding \(loading: encoder_model.onnx\)/);
    await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(120000); await pending;
    assert(terminated); assert.equal(models.entries.moonshine.state, 'error');
  } finally { models.close(); globalThis.Worker = previous; }
});

test('saved inference verification survives launches, but not device/model changes, missing files or interrupted setup', async () => {
  const { EnsembleModelStore } = await import('../src/ensemble-cache.js');
  const { ensembleVerificationKey, savedEnsembleVerification } = await import('../src/ensemble-verification.js');
  const previous = globalThis.Worker, prepares = [];
  globalThis.Worker = class {
    postMessage(data) { if (data.operation === 'prepare') { prepares.push(data.reuseVerification); queueMicrotask(() => this.onmessage({ data: { id: data.id, result: { verified: true } } })); } }
    terminate() {}
  };
  const records = new Map();
  const cache = { match: async key => { const r = records.get(key); return r && new Response(r.bytes.slice(0), { headers: r.headers }); }, put: async (key, value) => { records.set(key, { bytes: await value.arrayBuffer(), headers: value.headers }); }, delete: async key => records.delete(key) };
  const store = new EnsembleModelStore({ open: async () => cache });
  store.ensure = async () => {};
  const make = device => new EnsembleSpeech({ base: 'https://app.test/stt/', store, verificationDevice: device });
  let models = make('phone-A');
  try {
    for (const entry of Object.values(models.entries)) for (const f of entry.model.files) if (f.text === undefined) await cache.put(f.sha256, new Response('', { headers: { 'content-length': String(f.bytes), 'x-pageborne-sha256': f.sha256 } }));
    assert.equal(await models.restoreVerification(), false);
    await models.prepare('moonshine'); models.close();
    models = make('phone-A'); await models.restoreVerification();
    assert.equal(models.entries.moonshine.verified, true);
    assert.equal(models.entries.moonshine.state, 'idle', 'saved verification is not a loaded worker');
    await models.prepare('moonshine'); models.close();
    models = make('phone-B'); await models.prepare('moonshine'); models.close();
    assert.deepEqual(prepares, [false, true, false]);
    const model = models.entries.moonshine.model;
    const signature = ensembleVerificationKey(model, 'phone-B');
    assert.equal(await savedEnsembleVerification(store, model, signature), true);
    assert.notEqual(signature, ensembleVerificationKey({ ...model, files: model.files.map((f, i) => i ? f : { ...f, sha256: 'changed' }) }, 'phone-B'));
    const missing = model.files.find(f => f.text === undefined); const original = records.get(missing.sha256); records.delete(missing.sha256);
    assert.equal(await savedEnsembleVerification(store, model, signature), false);
    records.set(missing.sha256, original);
    const clear = await store.beginPreparation(model);
    assert.equal(await savedEnsembleVerification(store, model, signature), false);
    await clear();
    models = make('phone-B'); await models.prepare('moonshine', { retry: true });
    assert.equal(prepares.at(-1), false, 'explicit retry rechecks');
  } finally { models.close(); globalThis.Worker = previous; }
});
