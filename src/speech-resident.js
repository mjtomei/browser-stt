import { LocalSpeech } from './local-speech.js';

// A caller may leave Ask while a shared model is still loading. Abort only its
// wait, never the app-session preload that another paper/question will reuse.
function waitForModel(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new DOMException('Cancelled', 'AbortError'));
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(new DOMException('Cancelled', 'AbortError')); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

export class ResidentSpeech {
  constructor({ refinement = true, confidence, base, create = () => new LocalSpeech({ idleMs: 0, retainOnCancel: true, confidence, ...(base ? { base } : {}) }), changed = () => {}, failure = () => {},
    prepareModel = (entry, options) => entry.local.prepare(entry.backend, options) } = {}) {
    Object.assign(this, { create, changed, failure, prepareModel }); this.generation = 0;
    this.entries = Object.fromEntries([['fast', 'wasm'], ...(refinement ? [['refine', 'webgpu']] : [])].map(([model, backend]) =>
      [model, { model, backend, local: create(), generation: 0, state: 'idle', progress: '', ready: null, loading: null, error: null }]));
  }
  prepare(model, { retry = false } = {}) {
    const entry = this.entries[model];
    if (!entry) return Promise.reject(new Error('Unknown speech model.'));
    if (entry.loading) return entry.loading;
    if (entry.ready && entry.local.worker) return Promise.resolve(entry.ready);
    if (entry.error && !retry) return Promise.reject(entry.error);
    const generation = this.generation, entryGeneration = entry.generation;
    entry.state = 'loading'; entry.error = null; entry.ready = null; entry.progress = 'Loading…';
    const active = () => generation === this.generation && entryGeneration === entry.generation;
    const loading = this.prepareModel(entry, { model, retry, progress: text => {
      if (active()) { entry.progress = text; this.changed(); }
    } });
    entry.loading = loading.then(result => {
      if (active()) { entry.state = 'ready'; entry.ready = result; entry.progress = ''; }
      return result;
    }, error => {
      if (active()) { entry.state = 'error'; entry.error = error; entry.progress = ''; this.failure(error, entry.backend, model); }
      throw error;
    }).finally(() => { if (active()) { entry.loading = null; this.changed(); } });
    this.changed(); return entry.loading;
  }
  open({ refine = true, retry = false } = {}) {
    // Start both now; a missing GPU must not prevent the CPU draft from loading.
    return Promise.allSettled(['fast', ...(refine && this.entries.refine ? ['refine'] : [])].map(model => this.prepare(model, { retry })));
  }
  wait(model, { signal, retry = false } = {}) {
    signal?.throwIfAborted();
    return waitForModel(this.prepare(model, { retry }), signal);
  }
  async transcribe(model, audio, { signal, progress = () => {}, vocabulary = [], partial = false, onPartial, confidence, chunkSeconds } = {}) {
    const entry = this.entries[model];
    if (!entry) throw new Error('Unknown speech model.');
    signal?.throwIfAborted();
    if (entry.state !== 'ready') progress(model === 'fast' ? 'Loading CPU voice model…' : 'Loading GPU correction model…');
    await waitForModel(this.prepare(model), signal); signal?.throwIfAborted();
    try { return await entry.local.transcribe(entry.backend, audio, { signal, progress, model, vocabulary, partial, onPartial, confidence, chunkSeconds }); }
    catch (error) {
      if (error.name !== 'AbortError' && !entry.local.worker) { entry.ready = null; entry.state = 'error'; entry.error = error; this.changed(); }
      throw error;
    }
  }
  close(model) {
    if (model !== undefined && !this.entries[model]) throw new Error('Unknown speech model.');
    if (model === undefined) this.generation++;
    for (const entry of model === undefined ? Object.values(this.entries) : [this.entries[model]]) {
      entry.generation++;
      entry.local.close(); Object.assign(entry, { state: 'idle', progress: '', ready: null, loading: null, error: null });
    }
    this.changed();
  }
}
