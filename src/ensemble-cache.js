import { sha256 } from '@noble/hashes/sha2.js';
import { speechModelStorage } from './speech-model-cache.js';
import { safeTimeout as setTimeout, cancelTimeout as clearTimeout } from './timers.js';

const hex = bytes => Array.from(bytes, n => n.toString(16).padStart(2, '0')).join('');
const prefix = 'pageborne:models:v1:';
const CHUNK = 24000; // 32,000 characters after base64, within the existing SDK value size.
const encode = bytes => bytes.toBase64 ? bytes.toBase64() : btoa(String.fromCharCode(...bytes));
const decode = text => Uint8Array.fromBase64 ? Uint8Array.fromBase64(text) : Uint8Array.from(atob(text), c => c.charCodeAt(0));
// Even's bridge may resolve synchronously. Break long microtask chains so the
// phone can paint progress and process input while storing/checking model bytes.
function paintBudget() {
  let last = performance.now();
  return async () => { if (performance.now() - last < 8) return; await new Promise(resolve => setTimeout(resolve, 0)); last = performance.now(); };
}

// The native host namespace is tied to package_id, not the WebView's random port.
// No application version participates in these keys. Commit the manifest last.
export function nativeModelCache(kv) {
  const breathe = paintBudget();
  const set = async (key, value) => { await kv.set(key, value); await breathe(); };
  return {
    async match(key) {
      const raw = await kv.get(prefix + key); if (!raw) return undefined;
      let file; try { file = JSON.parse(raw); } catch {}
      if (!file || !Number.isSafeInteger(file.chunks) || file.chunks < 1 || file.chunks > 50000 || !/^[\w-]+$/.test(file.id)) { await set(prefix + key, ''); return undefined; }
      let index = 0;
      return new Response(new ReadableStream({ async pull(sink) {
        try {
          if (index === file.chunks) { sink.close(); return; }
          const text = await kv.get(`${prefix}${file.id}:${index++}`);
          if (!text) throw Error('Saved model is incomplete.');
          sink.enqueue(decode(text)); await breathe();
        } catch (error) { sink.error(error); }
      } }, { highWaterMark: 0 }), { headers: file.headers });
    },
    async put(key, response) {
      const id = crypto.randomUUID(), reader = response.body.getReader();
      const replaced = await kv.get(prefix + key);
      let index = 0, offset = 0; const buffer = new Uint8Array(CHUNK);
      const write = async bytes => { await set(`${prefix}${id}:${index++}`, encode(bytes)); };
      // A journal makes an interrupted download recoverable on the next launch.
      const journal = prefix + 'pending:' + key;
      const previous = await kv.get(journal);
      if (previous) {
        let old; try { old = JSON.parse(previous); } catch { old = {}; }
        if (/^[\w-]+$/.test(old.id) && Number.isInteger(old.chunks) && old.chunks <= 50000) {
          for (let i = 0; i <= old.chunks; i++) await set(`${prefix}${old.id}:${i}`, '');
        }
      }
      try {
        // Verified model streams declare their size. Journal the bounded extent
        // once, rather than doubling every one of ~10,400 native chunk writes.
        // Recovery can clear unwritten keys safely after an interrupted save.
        const length = Number(response.headers.get('content-length'));
        const planned = Number.isSafeInteger(length) && length > 0 && Math.ceil(length / CHUNK) <= 50000 ? Math.ceil(length / CHUNK) : 0;
        if (planned) await set(journal, JSON.stringify({ id, chunks: planned }));
        const checkpoint = async () => { if (!planned) await set(journal, JSON.stringify({ id, chunks: index })); };
        for (;;) {
          const { value, done } = await reader.read(); if (done) break;
          for (let at = 0; at < value.length;) {
            const count = Math.min(CHUNK - offset, value.length - at);
            buffer.set(value.subarray(at, at + count), offset); at += count; offset += count;
            if (offset === CHUNK) { await checkpoint(); await write(buffer); offset = 0; }
          }
        }
        if (offset) { await checkpoint(); await write(buffer.subarray(0, offset)); }
        await set(prefix + key, JSON.stringify({ id, chunks: index, headers: Object.fromEntries(response.headers) }));
        await set(journal, '');
        if (replaced) {
          let old; try { old = JSON.parse(replaced); } catch { old = {}; }
          if (/^[\w-]+$/.test(old.id) && Number.isInteger(old.chunks) && old.chunks <= 50000) for (let i = 0; i < old.chunks; i++) await set(`${prefix}${old.id}:${i}`, '');
        }
      } catch (error) {
        await reader.cancel().catch(() => {});
        // Leave the journal for recovery if the host is no longer available.
        throw error;
      } finally { reader.releaseLock(); }
    },
    async delete(key) {
      const raw = await kv.get(prefix + key);
      await set(prefix + key, '');
      if (raw) {
        let file; try { file = JSON.parse(raw); } catch { file = {}; }
        if (/^[\w-]+$/.test(file.id) && Number.isInteger(file.chunks) && file.chunks <= 50000) {
          for (let i = 0; i < file.chunks; i++) await set(`${prefix}${file.id}:${i}`, '');
        }
      }
    },
    close() {},
  };
}

// A model is downloaded once per checksum. Files are streamed to storage before
// any inference allocation, with backpressure and an atomic visibility point.
export class EnsembleModelStore {
  constructor({ kv, fetch = globalThis.fetch.bind(globalThis), open } = {}) {
    this.fetch = fetch; this.pending = new Map(); this.controllers = new Set(); this.stats = { downloadedBytes: 0, cachedBytes: 0 };
    this.open = open || (async () => kv ? nativeModelCache(await (typeof kv === 'function' ? kv() : kv)) : speechModelStorage.open('pageborne-ensemble-weights-v1'));
  }
  cache() { return this.ready ||= this.open().catch(error => { this.ready = null; throw error; }); }
  async verify(response, file, progress = () => {}) {
    const reader = response.body.getReader(), hash = sha256.create(), breathe = paintBudget(); let bytes = 0, chunk, offset = 0;
    return new Response(new ReadableStream({ async pull(sink) {
      try {
        if (!chunk || offset === chunk.length) {
          const next = await reader.read(); chunk = next.value; offset = 0;
          if (next.done) {
          if (bytes !== file.bytes || hex(hash.digest()) !== file.sha256) throw Error('Model integrity check failed. Retry the download.');
          sink.close(); return;
          }
        }
        const part = chunk.subarray(offset, offset + 65536); offset += part.length;
        bytes += part.length;
        if (bytes > file.bytes) throw Error('Unexpected model size.');
        hash.update(part); progress(bytes);
        // A complete chunk can be transferred to the model worker. Stop
        // retaining its view before enqueue: transferring detaches its buffer.
        if (offset === chunk.length) { chunk = null; offset = 0; }
        sink.enqueue(part); await breathe();
      } catch (error) { await reader.cancel().catch(() => {}); sink.error(error); }
    }, cancel: reason => reader.cancel(reason) }, { highWaterMark: 0 }), {
      headers: { 'content-length': String(file.bytes), 'x-pageborne-sha256': file.sha256, 'content-type': 'application/octet-stream' },
    });
  }
  async ensure(file, progress = () => {}) {
    if (file.text !== undefined) return;
    if (this.pending.has(file.sha256)) return this.pending.get(file.sha256);
    const task = (async () => {
      const cache = await this.cache();
      const existing = await cache.match(file.sha256);
      if (existing) { await existing.body.cancel(); progress(file.bytes, true); return; }
      const controller = new AbortController(); this.controllers.add(controller);
      let idle; const refresh = () => { clearTimeout(idle); idle = setTimeout(() => controller.abort(new Error('Model download stalled. Retry when connected.')), 60000); };
      refresh();
      try {
      const response = await this.fetch(file.url, { signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (!response.ok || !response.body) throw Error(`Model download failed (HTTP ${response.status}). Retry when connected.`);
      const verified = await this.verify(response, file, bytes => { refresh(); progress(bytes, false); });
      await cache.put(file.sha256, verified); this.stats.downloadedBytes += file.bytes;
      } finally { clearTimeout(idle); this.controllers.delete(controller); }
    })();
    this.pending.set(file.sha256, task);
    try { await task; } finally { this.pending.delete(file.sha256); }
  }
  async beginPreparation(model, { retry = false } = {}) {
    const cache = await this.cache(), key = 'preparation:' + model.id;
    const previous = await cache.match(key);
    let record; try { record = previous ? await previous.json() : null; } catch { record = null; }
    if (record?.pending && !retry) throw Error(`${model.name} preparation was interrupted. Retry setup to try again.`);
    const id = crypto.randomUUID();
    await cache.put(key, new Response(JSON.stringify({ pending: true, id })));
    return async () => {
      const current = await cache.match(key);
      if (current && (await current.json()).id === id) await cache.delete(key);
    };
  }
  cancel() { for (const controller of this.controllers) controller.abort(); }
  async read(file) {
    if (file.text !== undefined) return this.verify(new Response(file.text), file);
    const cache = await this.cache(), response = await cache.match(file.sha256);
    if (!response) throw Error('Model is not downloaded yet.');
    this.stats.cachedBytes += file.bytes;
    const verified = await this.verify(response, file);
    // Failed integrity is evicted; the next explicit retry redownloads it.
    const reader = verified.body.getReader();
    return new Response(new ReadableStream({ async pull(sink) {
      try { const next = await reader.read(); if (next.done) sink.close(); else sink.enqueue(next.value); }
      catch (error) { await cache.delete(file.sha256).catch(() => {}); sink.error(error); }
    }, cancel: reason => reader.cancel(reason) }, { highWaterMark: 0 }), { headers: verified.headers });
  }
}
