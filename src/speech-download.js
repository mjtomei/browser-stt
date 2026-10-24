import { sha256 } from '@noble/hashes/sha2.js';
import { speechDownloads } from './speech-download-config.js';
import { speechModelStorage, SPEECH_CACHE } from './speech-model-cache.js';

export { SPEECH_CACHE } from './speech-model-cache.js';
const hex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');

// Transformers consumes weights with response.arrayBuffer(). WebKit's native
// stream conversion can retain all chunks plus multiple full-size copies. Use
// the pinned length to allocate once; keep getReader()/cache writes streaming.
function modelResponse(stream, entry) {
  const response = new Response(stream, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(entry.bytes), 'x-pageborne-sha256': entry.sha256 } });
  response.arrayBuffer = async function () {
    if (this.bodyUsed) throw new TypeError('Model response already consumed');
    const reader = this.body.getReader();
    try {
      const buffer = new Uint8Array(entry.bytes); let offset = 0;
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        if (offset + value.byteLength > buffer.length) throw new Error('Unexpected model size');
        buffer.set(value, offset); offset += value.byteLength;
      }
      if (offset !== buffer.length) throw new Error('Incomplete model buffer');
      return buffer.buffer;
    } catch (error) { await reader.cancel(error).catch(() => {}); throw error; }
    finally { reader.releaseLock(); }
  };
  return response;
}

// Scoped to Transformers' fetch hook in the correction worker. No arbitrary
// remote models, audio uploads or changes to the application's global fetch.
export function speechDownloader({ base, entries = speechDownloads, fetch: fetchFile = globalThis.fetch.bind(globalThis),
  storage = speechModelStorage, progress = () => {}, stallMs = 60000 } = {}) {
  const lookup = new Map(entries.map(entry => [new URL(entry.local, base).href, entry]));
  const loaded = new Map(); const inFlight = new Map();
  const stats = { downloadedBytes: 0, cachedBytes: 0, cacheAvailable: true };
  const cacheFailed = error => { stats.cacheAvailable = false; stats.cacheError = error?.name || 'Unavailable'; };
  const total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  let lastReport = 0, failure = null;
  const fail = message => (failure = new Error(message));
  const report = (force = false) => {
    const now = Date.now(); if (!force && now - lastReport < 250) return; lastReport = now;
    const bytes = [...loaded.values()].reduce((sum, value) => sum + value, 0);
    progress(bytes >= total ? 'Preparing corrections…' : `${stats.downloadedBytes ? 'Downloading' : 'Loading cached'} corrections · ${(bytes / 1e6).toFixed(1)} / ${Math.ceil(total / 1e6)} MB`);
  };
  // Model storage is best effort: quota/private browsing must not break voice.
  const cachePromise = Promise.resolve().then(() => storage?.open(SPEECH_CACHE)).catch(error => { cacheFailed(error); return null; }).then(cache => {
    if (!cache && stats.cacheAvailable) cacheFailed();
    return cache;
  });
  async function modelFile(entry) {
    const cache = await cachePromise;
    let cached;
    try {
      cached = await cache?.match(entry.url);
      if (cached && (cached.headers.get('x-pageborne-sha256') !== entry.sha256 || Number(cached.headers.get('content-length')) !== entry.bytes)) {
        await cache.delete(entry.url); cached = null;
      }
    } catch (error) { cacheFailed(error); }
    const controller = new AbortController(); let timer;
    const arm = () => { clearTimeout(timer); timer = setTimeout(() => controller.abort(), stallMs); };
    let response = cached;
    if (!response) {
      progress(`Downloading corrections · ${Math.ceil(total / 1e6)} MB total. CPU voice stays available.`);
      arm();
      try {
        response = await fetchFile(entry.url, { credentials: 'omit', referrerPolicy: 'no-referrer', signal: controller.signal });
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      } catch {
        clearTimeout(timer);
        throw fail('Could not download GPU corrections. CPU voice still works. Check your connection, then use Prepare / retry voice in Settings.');
      }
    }
    const reader = response.body.getReader(), hash = sha256.create(); let bytes = 0;
    // Hash each chunk, including cache reads. Neither corrupt nor truncated
    // files can reach inference; a failing stream also rejects the cache write.
    const stream = new ReadableStream({
      async pull(sink) {
        try {
          if (!cached) arm();
          const chunk = await reader.read();
          if (chunk.done) {
            clearTimeout(timer);
            if (bytes !== entry.bytes || hex(hash.digest()) !== entry.sha256) throw new Error('Model integrity check failed');
            report(true); sink.close(); return;
          }
          bytes += chunk.value.byteLength;
          if (bytes > entry.bytes) throw new Error('Unexpected model size');
          hash.update(chunk.value); loaded.set(entry.local, Math.max(loaded.get(entry.local) || 0, bytes));
          stats[cached ? 'cachedBytes' : 'downloadedBytes'] += chunk.value.byteLength;
          report(); sink.enqueue(chunk.value);
        } catch {
          clearTimeout(timer); controller.abort(); void reader.cancel().catch(() => {});
          if (cached) void cache.delete(entry.url).catch(() => {});
          sink.error(fail('GPU model download or integrity check failed. CPU voice still works. Use Prepare / retry voice in Settings.'));
        }
      },
      cancel(reason) { clearTimeout(timer); controller.abort(); return reader.cancel(reason); },
    }, { highWaterMark: 0 });
    const verified = modelResponse(stream, entry);
    if (!cached && cache && stats.cacheAvailable) {
      try {
        // Download to disk first, with backpressure. Response.clone/tee can
        // buffer hundreds of MB if inference reads faster than phone storage.
        await cache.put(entry.url, verified);
        if (!await cache.match(entry.url)) throw new Error('Model cache did not retain the file');
      } catch (error) {
        cacheFailed(error); void verified.body.cancel().catch(() => {});
        if (failure) throw failure;
        // A quota/permission failure may have consumed part of the body. Retry
        // without writing storage; voice can still use the model in memory.
      }
      return modelFile(entry);
    }
    return verified;
  }
  async function fetch(input, init) {
    const address = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, base).href;
    const entry = lookup.get(address);
    if (!entry) return fetchFile(input, init);
    // Transformers can request the same decoder for two sessions concurrently.
    // Wait for its verified cache write instead of downloading it twice or
    // retaining another whole-file buffer just to share a Response.
    while (inFlight.has(address)) await inFlight.get(address);
    let finish;
    const pending = new Promise(resolve => { finish = resolve; }); inFlight.set(address, pending);
    const done = () => { inFlight.delete(address); finish(); };
    // A metadata caller may never consume the body. Unlock once the verified
    // disk write is complete, without waiting for that caller to read it.
    try { return await modelFile(entry); }
    finally { done(); }
  }
  return { fetch, stats, get error() { return failure; } };
}
