import manifests from '../vendor/stt/ensemble-models.json' with { type: 'json' };
import miniManifest from '../vendor/stt/fluid-mini.json' with { type: 'json' };
import { EnsembleModelStore } from './ensemble-cache.js';
import { ensembleVerificationKey, savedEnsembleVerification, saveEnsembleVerification } from './ensemble-verification.js';
import { safeTimeout as setTimeout, cancelTimeout as clearTimeout } from './timers.js';
import { fluidCpuThreads } from './fluid-runtime.js';

export const ensembleModels = Object.freeze(manifests);
export const fluidSpeechMini = Object.freeze(miniManifest);
const availableModels = [...ensembleModels, fluidSpeechMini];
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
        if (data.speechBackend) error.speechBackend = data.speechBackend;
        if (data.errorStack) error.stack = data.errorStack;
        job.reject(error);
      } else job.resolve(data.result);
    };
    this.worker.onerror = event => { event.preventDefault(); this.close(Object.assign(Error(`${this.model.name} worker could not run: ${event.message || 'worker stopped'}. Retry setup.`), { speechBackend: this.speechBackend })); };
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
        timer = setTimeout(() => this.close(Object.assign(Error(`${this.model.name} setup stopped responding (${this.setup?.stage || 'starting'}${this.setup?.file || this.setup?.component ? ': ' + (this.setup.file || this.setup.component) : ''}). Retry setup.`), { speechBackend: this.speechBackend })), 120000);
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
  constructor({ base = new URL('./stt/', document.baseURI).href, store = new EnsembleModelStore(), modelIds = ensembleModels.map(m => m.id), miniAcceleration = 'wasm', changed = () => {}, failure = () => {}, checkpoint, verificationDevice } = {}) {
    if (!modelIds.length || new Set(modelIds).size !== modelIds.length || modelIds.some(id => !availableModels.some(m => m.id === id))) throw Error('Unknown or duplicate speech model selection.');
    if (!['wasm', 'auto'].includes(miniAcceleration)) throw Error('Unknown Mini acceleration mode.');
    this.models = modelIds.map(id => availableModels.find(m => m.id === id));
    Object.assign(this, { base, store, changed, failure, checkpoint, verificationDevice, miniAcceleration }); this.generation = 0; this.loading = Promise.resolve();
    this.entries = Object.fromEntries(this.models.map(model => [model.id, { model, state: 'idle', progress: '',
      downloadBytes: 0, totalBytes: model.files.reduce((n, f) => n + (f.text === undefined ? f.bytes : 0), 0),
      setup: { stage: 'waiting', loadedBytes: 0, totalBytes: model.files.reduce((n, f) => n + f.bytes, 0) } }]));
  }
  setStorage(kv) {
    if (Object.values(this.entries).some(e => e.state !== 'idle')) throw Error('Configure speech storage before opening voice.');
    this.store = new EnsembleModelStore({ kv });
  }
  async restoreVerification() {
    for (const entry of Object.values(this.entries)) {
      entry.verified = await savedEnsembleVerification(this.store, entry.model, this.verificationKey(entry.model));
    }
    this.changed();
    return Object.values(this.entries).every(entry => entry.verified);
  }
  verificationKey(model) {
    const device = model.id === 'fluid-mini' && this.verificationDevice && this.acceleration === 'auto'
      ? `${this.verificationDevice}:webgpu=ed84438023e7954591b29780bd1f8b8d13b972018527271f83d4da2596ac0935` : this.verificationDevice;
    return ensembleVerificationKey(model, device);
  }
  get acceleration() { return this.miniAcceleration === 'auto' && !this.gpuFailed && fluidCpuThreads() === 1 ? 'auto' : 'wasm'; }
  open({ retry = false } = {}) {
    const models = [...this.models].sort((a, b) => Number(b.id === 'moonshine') - Number(a.id === 'moonshine'));
    const jobs = new Map(models.map(m => [m.id, this.prepare(m.id, { retry })]));
    return Promise.allSettled(this.models.map(m => jobs.get(m.id)));
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
      const signature = this.verificationKey(entry.model);
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
        const onProgress = progress => {
          if (generation !== this.generation) return;
          if (progress.backend) entry.client.speechBackend = progress.backend;
          const now = Date.now();
          if (progress.stage !== entry.setup.stage || progress.file !== undefined && progress.file !== entry.setup.file
            || progress.component !== undefined && progress.component !== entry.setup.component) entry.setup.stageStartedAt = now;
          entry.setup.lastProgressAt = now;
          Object.assign(entry.setup, progress);
          entry.progress = ({ runtime: 'Starting runtime', loading: 'Loading saved files', initializing: 'Initializing model', checking: 'Checking transcription' })[progress.stage] || 'Preparing';
          this.changed();
        };
        const initialize = async (acceleration, verified = reuseVerification) => {
          check(); entry.client?.close(); entry.client = new ModelWorker(entry.model, this.store, this.base, this.checkpoint);
          return entry.client.request('prepare', { model: entry.model, base: this.base, reuseVerification: verified, acceleration }, { onProgress });
        };
        try { ready = await initialize(entry.model.id === 'fluid-mini' ? this.acceleration : 'wasm'); }
        catch (error) {
          check();
          if (error.speechBackend !== 'webgpu' || error.name === 'AbortError') throw error;
          this.gpuFailure = { stage: 'preparation', message: String(error.message).slice(0, 500) };
          // A failed GPU runtime may poison its WASM state too. Retry in a fresh
          // worker with the same checked weights, before accepting any audio.
          this.gpuFailed = true; ready = await initialize('wasm', false);
        }
        if (this.gpuFailed && entry.model.id === 'fluid-mini') {
          ready.accelerationFallback = 'gpu-unavailable'; ready.accelerationFailure = this.gpuFailure;
        }
        check();
        if (ready.verified !== true) throw Error('Model transcription check did not pass. Retry setup.');
      } catch (error) {
        // Terminate before touching storage again. A failed native cache read
        // can leave the bridge blocked: clearing its marker here used to hide
        // the original error forever. Keep the marker until an explicit retry.
        entry.client?.close(); throw error;
      }
      await clearPreparation();
      const actualSignature = this.verificationKey(entry.model);
      if (!reuseVerification || actualSignature !== signature) await saveEnsembleVerification(this.store, entry.model, actualSignature);
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
      if (error.name !== 'AbortError' && generation === this.generation && entry.client === client && entry.ready?.backend === 'webgpu') {
        // Retain the caller's Blob and replay it once on CPU. Partial text is a
        // draft; no captured PCM or final submission is discarded or duplicated.
        this.gpuFailed = true; this.gpuFailure = { stage: 'inference', message: String(error.message).slice(0, 500) };
        client.close(); entry.client = null; entry.ready = null; entry.state = 'idle';
        return this.transcribe(id, audio, options);
      }
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
