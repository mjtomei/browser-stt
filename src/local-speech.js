import { speechModels } from './speech-models.js';
import { confidenceOptions } from './speech-confidence.js';
import { speechWindowSeconds } from './speech-window.js';
import { safeTimeout as setTimeout, cancelTimeout as clearTimeout } from './timers.js';

export class LocalSpeech {
  constructor({ base = new URL('stt/', document.baseURI).href, createWorker = () => new Worker(new URL('speech-worker.js', base), { type: 'module' }), idleMs = 60000, retainOnCancel = false, confidence } = {}) {
    Object.assign(this, { createWorker, base, idleMs, retainOnCancel }); this.confidence = confidence; this.serial = 0; this.pending = new Map();
  }
  async run(operation, backend, audio, { signal, progress = () => {}, model = 'fast', vocabulary = [], partial = false, onPartial, chunkSeconds = 15, confidence = this.confidence } = {}) {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    confidence = confidenceOptions(confidence);
    chunkSeconds = speechWindowSeconds(chunkSeconds);
    if (model !== 'fast' && chunkSeconds !== 15) throw new Error('Experimental speech windows are only supported by Tiny.');
    if (!['wasm', 'webgpu'].includes(backend)) throw new Error('Choose a local speech backend.');
    if (!speechModels[model]) throw new Error('Unknown speech model.');
    if (this.pending.size && !this.retainOnCancel) throw new Error('A speech operation is already running.');
    progress(backend === 'webgpu' ? 'Checking WebGPU support…' : 'Starting local speech · SIMD…');
    if (backend !== this.backend || model !== this.model) this.close();
    clearTimeout(this.idleTimer);
    if (!this.worker) {
      this.worker = this.createWorker(); this.backend = backend; this.model = model;
      const worker = this.worker;
      this.worker.onmessage = ({ data }) => {
        if (this.worker !== worker) return;
        const pending = this.pending.get(data.id); if (!pending) return;
        if (data.partial) { pending.onPartial?.(data.partial); return; }
        if (data.progress) { pending.progress(data.progress); return; }
        this.pending.delete(data.id);
        if (data.error) { pending.reject(new Error(data.error)); if (data.fatal !== false) this.close(); }
        else pending.resolve(data.result);
        if (this.worker && this.idleMs > 0 && !this.pending.size) this.idleTimer = setTimeout(() => this.close(), this.idleMs);
      };
      this.worker.onerror = event => { event.preventDefault?.(); if (this.worker === worker) this.close(new Error('Local speech stopped unexpectedly. Retry preparation.')); };
      this.worker.onmessageerror = () => { if (this.worker === worker) this.close(new Error('Could not read the local speech result.')); };
    }
    const id = ++this.serial;
    const cancel = () => {
      const error = new DOMException('Cancelled', 'AbortError');
      if (!this.retainOnCancel) { this.close(error); return; }
      const pending = this.pending.get(id); if (!pending) return;
      this.pending.delete(id); pending.reject(error);
      // The worker stops decoding cooperatively and keeps the loaded weights.
      // Late results carry the cancelled ID and are ignored.
      try { this.worker?.postMessage({ id, operation: 'cancel' }); } catch { this.close(); }
    };
    const timeout = setTimeout(() => this.close(new Error(operation === 'prepare' ? 'Voice preparation timed out. Retry preparation.' : 'Local speech took too long. Try a shorter recording.')), operation === 'prepare' ? 1800000 : 120000);
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      return await new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject, progress, onPartial });
        try { this.worker.postMessage({ id, operation, backend, model, base: this.base, audio, vocabulary, partial, chunkSeconds, stream: typeof onPartial === 'function', confidence }, audio ? [audio] : []); }
        catch (error) { this.close(error); }
      });
    } finally { clearTimeout(timeout); signal?.removeEventListener('abort', cancel); }
  }
  prepare(backend, options) { return this.run('prepare', backend, null, options); }
  async transcribe(backend, audio, options) { return this.run('transcribe', backend, await audio.arrayBuffer(), options); }
  close(error = new DOMException('Cancelled', 'AbortError')) {
    clearTimeout(this.idleTimer); this.worker?.terminate(); this.worker = null; this.backend = null; this.model = null;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
