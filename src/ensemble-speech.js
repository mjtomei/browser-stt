import manifests from '../vendor/stt/ensemble-models.json' with { type: 'json' };
import { EnsembleModelStore } from './ensemble-cache.js';
import { ensembleVerificationKey, savedEnsembleVerification, saveEnsembleVerification } from './ensemble-verification.js';
import { safeTimeout as setTimeout, cancelTimeout as clearTimeout } from './timers.js';

export const ensembleModels = Object.freeze(manifests);
const abort = () => new DOMException('Transcription cancelled.', 'AbortError');
const wait = (promise, signal) => {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cancel = () => { signal.removeEventListener('abort', cancel); reject(abort()); };
    signal.addEventListener('abort', cancel, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
  });
};
class ModelWorker {
  constructor(model, store, base, checkpoint) {
    this.model = model; this.store = store; this.serial = 0; this.pending = new Map(); this.readers = new Map();
    this.checkpoint = checkpoint;
    this.worker = new Worker(new URL('ensemble-worker.js', base), { type: 'module' });
    this.worker.onmessage = ({ data }) => {
      if (data.cache) { void this.cache(data.cache); return; }
      const job = this.pending.get(data.id); if (!job) return;
      job.touch();
      if (data.progress) { this.setup = data.progress; job.progress?.(data.progress); return; }
      if (data.partial) { job.partial?.(data.partial); return; }
      this.pending.delete(data.id); job.cleanup();
      if (data.error) {
        const error = Error(data.error); if (data.errorName) error.name = data.errorName;
        if (data.errorStack) error.stack = data.errorStack;
        job.reject(error);
      } else job.resolve(data.result);
    };
    this.worker.onerror = event => { event.preventDefault(); this.close(Error(`${this.model.name} worker could not run: ${event.message || 'worker stopped'}. Retry setup.`)); };
  }
  async cache({ request, action, file, handle }) {
    try {
      let value;
      if (action === 'checkpoint') {
        await this.checkpoint?.(); value = true;
      } else if (action === 'open') {
        const entry = this.model.files.find(f => f.file === file); if (!entry) throw Error('Unknown model asset.');
        const response = await this.store.read(entry); value = ++this.serial;
        if (this.closed) { await response.body.cancel(); return; }
        this.readers.set(value, response.body.getReader());
      } else {
        const reader = this.readers.get(handle); if (!reader) throw Error('Model stream closed.');
        if (action === 'cancel') { await reader.cancel(); this.readers.delete(handle); }
        else if (action === 'read') {
          const next = await reader.read(); value = { done: next.done };
          if (next.done) { reader.releaseLock(); this.readers.delete(handle); }
          else value.bytes = next.value.byteOffset === 0 && next.value.byteLength === next.value.buffer.byteLength
            ? next.value.buffer : next.value.slice().buffer;
        } else throw Error('Unknown cache operation.');
      }
      if (!this.closed) this.worker.postMessage({ cacheReply: true, request, value }, value?.bytes ? [value.bytes] : []);
    } catch (error) { if (!this.closed) this.worker.postMessage({ cacheReply: true, request, error: error.message }); }
  }
  async request(operation, data, { signal, onPartial, onProgress } = {}) {
    signal?.throwIfAborted(); if (this.closed) throw Error('Speech worker closed. Retry voice.');
    return new Promise((resolve, reject) => {
      const id = ++this.serial;
      const cancel = () => { this.pending.delete(id); cleanup(); this.worker.postMessage({ operation: 'cancel', id }); reject(abort()); };
      let timer;
      const touch = () => {
        if (operation !== 'prepare') return;
        clearTimeout(timer);
        timer = setTimeout(() => this.close(Error(`${this.model.name} setup stopped responding (${this.setup?.stage || 'starting'}${this.setup?.file || this.setup?.component ? ': ' + (this.setup.file || this.setup.component) : ''}). Retry setup.`)), 120000);
      };
      const cleanup = () => { signal?.removeEventListener('abort', cancel); clearTimeout(timer); };
      this.pending.set(id, { resolve, reject, cleanup, touch, partial: onPartial, progress: onProgress });
      touch();
      signal?.addEventListener('abort', cancel, { once: true });
      this.worker.postMessage({ operation, id, ...data }, data.audio ? [data.audio] : []);
    });
  }
  close(error = abort()) {
    this.closed = true; this.worker.terminate();
    for (const item of this.pending.values()) { item.cleanup(); item.reject(error); }
    this.pending.clear(); for (const reader of this.readers.values()) void reader.cancel().catch(() => {}); this.readers.clear();
  }
}

// Models stay resident until close(). Initializations are serial to avoid three
// simultaneous peak allocations; inference runs independently in three workers.
export class EnsembleSpeech {
  constructor({ base = new URL('./stt/', document.baseURI).href, store = new EnsembleModelStore(), changed = () => {}, failure = () => {}, checkpoint, verificationDevice } = {}) {
    Object.assign(this, { base, store, changed, failure, checkpoint, verificationDevice }); this.generation = 0; this.loading = Promise.resolve();
    this.entries = Object.fromEntries(ensembleModels.map(model => [model.id, { model, state: 'idle', progress: '',
      downloadBytes: 0, totalBytes: model.files.reduce((n, f) => n + (f.text === undefined ? f.bytes : 0), 0),
      setup: { stage: 'waiting', loadedBytes: 0, totalBytes: model.files.reduce((n, f) => n + f.bytes, 0) } }]));
  }
  setStorage(kv) {
    if (Object.values(this.entries).some(e => e.state !== 'idle')) throw Error('Configure speech storage before opening voice.');
    this.store = new EnsembleModelStore({ kv });
  }
  async restoreVerification() {
    for (const entry of Object.values(this.entries)) {
      entry.verified = await savedEnsembleVerification(this.store, entry.model, ensembleVerificationKey(entry.model, this.verificationDevice));
    }
    this.changed();
    return Object.values(this.entries).every(entry => entry.verified);
  }
  open({ retry = false } = {}) {
    const models = [...ensembleModels].sort((a, b) => Number(b.id === 'moonshine') - Number(a.id === 'moonshine'));
    const jobs = new Map(models.map(m => [m.id, this.prepare(m.id, { retry })]));
    return Promise.allSettled(ensembleModels.map(m => jobs.get(m.id)));
  }
  prepare(id, { retry = false, signal } = {}) {
    // Cancellation stops this caller's wait, never another recording's shared
    // initialization. Select the audio window only after this wait completes.
    if (signal) { signal.throwIfAborted(); return wait(this.prepare(id, { retry }), signal); }
    const entry = this.entries[id]; if (!entry) return Promise.reject(Error('Unknown speech model.'));
    if (entry.state === 'ready' && !entry.client?.closed) return Promise.resolve(entry.ready);
    if (entry.promise) return entry.promise;
    if (entry.state === 'error' && !retry) return Promise.reject(entry.error);
    const generation = this.generation;
    const check = () => { if (generation !== this.generation) throw abort(); };
    entry.state = 'downloading'; entry.error = null; entry.progress = 'Waiting to download'; this.changed();
    const task = this.loading.catch(() => {}).then(async () => {
      check(); const total = entry.totalBytes; let complete = 0;
      const signature = ensembleVerificationKey(entry.model, this.verificationDevice);
      const reuseVerification = !retry && await savedEnsembleVerification(this.store, entry.model, signature);
      for (const file of entry.model.files) {
        if (file.text !== undefined) continue;
        check(); await this.store.ensure(file, bytes => { if (generation !== this.generation) return; entry.downloadBytes = complete + bytes; const now = performance.now(); if (now - (entry.notified || 0) < 150 && bytes !== file.bytes) return; entry.notified = now; entry.progress = `${((complete + bytes) / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB`; this.changed(); }); complete += file.bytes;
      }
      check(); entry.downloadBytes = total; entry.state = 'loading'; entry.progress = 'Preparing';
      Object.assign(entry.setup, { stage: 'runtime', loadedBytes: 0, file: '', component: '', fileLoadedBytes: 0, fileBytes: 0,
        startedAt: Date.now(), stageStartedAt: Date.now(), lastProgressAt: Date.now() }); this.changed();
      const clearPreparation = await this.store.beginPreparation(entry.model, { retry });
      let ready;
      try {
        check(); entry.client?.close(); entry.client = new ModelWorker(entry.model, this.store, this.base, this.checkpoint);
        ready = await entry.client.request('prepare', { model: entry.model, base: this.base, reuseVerification }, { onProgress: progress => {
          if (generation !== this.generation) return;
          const now = Date.now();
          if (progress.stage !== entry.setup.stage || progress.file !== undefined && progress.file !== entry.setup.file
            || progress.component !== undefined && progress.component !== entry.setup.component) entry.setup.stageStartedAt = now;
          entry.setup.lastProgressAt = now;
          Object.assign(entry.setup, progress);
          entry.progress = ({ runtime: 'Starting runtime', loading: 'Loading saved files', initializing: 'Initializing model', checking: 'Checking transcription' })[progress.stage] || 'Preparing';
          this.changed();
        } }); check();
        if (ready.verified !== true) throw Error('Model transcription check did not pass. Retry setup.');
      } catch (error) {
        // Terminate before touching storage again. A failed native cache read
        // can leave the bridge blocked: clearing its marker here used to hide
        // the original error forever. Keep the marker until an explicit retry.
        entry.client?.close(); throw error;
      }
      await clearPreparation();
      if (!reuseVerification) await saveEnsembleVerification(this.store, entry.model, signature);
      check(); entry.verified = true;
      entry.state = 'ready'; entry.ready = ready; entry.progress = ''; entry.setup.stage = 'ready'; this.changed(); return ready;
    }).catch(error => {
      if (generation === this.generation) { entry.client?.close(); entry.verified = false; entry.state = 'error'; entry.error = error; entry.progress = ''; this.changed(); this.failure(error, 'wasm', entry.model.name); }
      throw error;
    }).finally(() => { if (generation === this.generation) entry.promise = null; });
    entry.promise = task; this.loading = task; return task;
  }
  async transcribe(id, audio, options = {}) {
    const generation = this.generation;
    options.signal?.throwIfAborted(); await wait(this.prepare(id), options.signal); options.signal?.throwIfAborted();
    const bytes = await audio.arrayBuffer(); options.signal?.throwIfAborted();
    if (generation !== this.generation) throw abort();
    const entry = this.entries[id], client = entry.client;
    try { return await client.request('transcribe', { audio: bytes, vocabulary: options.vocabulary, confidence: options.confidence }, options); }
    catch (error) {
      if (error.name !== 'AbortError' && entry.client === client) {
        client.close(); entry.state = 'error'; entry.error = error; entry.progress = ''; this.changed(); this.failure(error, 'wasm', entry.model.name);
      }
      throw error;
    }
  }
  close() {
    this.generation++; this.store.cancel?.();
    for (const entry of Object.values(this.entries)) { entry.client?.close(); entry.client = null; entry.promise = null; entry.ready = null; entry.state = 'idle'; entry.progress = ''; entry.setup.stage = 'waiting'; }
    this.changed();
  }
}
