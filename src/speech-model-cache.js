// IndexedDB chunks avoid WebView CacheStorage inconsistencies and a second
// full-size model buffer. A file becomes visible only after its verified stream
// reaches EOF. Unfinished downloads are never used as model weights.
// Preserve the original namespace so existing consumers reuse verified weights.
export const SPEECH_CACHE = 'pageborne-speech-weights-v1';
const CHUNK_BYTES = 4 * 1024 * 1024;
const request = value => new Promise((resolve, reject) => { value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error); });
const complete = transaction => new Promise((resolve, reject) => {
  transaction.oncomplete = () => resolve(); transaction.onabort = transaction.onerror = () => reject(transaction.error || new Error('Model cache transaction failed'));
});
export const speechModelStorage = {
  async open(name = SPEECH_CACHE) {
    const opening = indexedDB.open(name, 1);
    opening.onupgradeneeded = () => { opening.result.createObjectStore('files'); opening.result.createObjectStore('chunks'); };
    const db = await request(opening);
    db.onversionchange = () => db.close();
    const get = (store, key) => request(db.transaction(store).objectStore(store).get(key));
    const mutate = async (stores, run) => { const transaction = db.transaction(stores, 'readwrite'); const done = complete(transaction); run(transaction); await done; };
    const removeChunks = (transaction, file) => {
      if (file) for (let index = 0; index < file.chunks; index++) transaction.objectStore('chunks').delete(`${file.id}:${index}`);
    };
    // Recover space after a terminated worker. Leave recent orphan chunks alone
    // because a different tab may still be downloading them.
    const transaction = db.transaction(['files', 'chunks'], 'readwrite'), swept = complete(transaction);
    const filesRequest = transaction.objectStore('files').getAll();
    filesRequest.onsuccess = () => {
      const live = new Set(filesRequest.result.map(file => file.id));
      const cursor = transaction.objectStore('chunks').openKeyCursor();
      cursor.onsuccess = () => {
        const item = cursor.result; if (!item) return;
        const key = String(item.key), id = key.slice(0, key.lastIndexOf(':'));
        if (!live.has(id) && Number(id.split(':')[0]) < Date.now() - 3600000) transaction.objectStore('chunks').delete(item.key);
        item.continue();
      };
    };
    await swept;
    return {
      async match(url) {
        const file = await get('files', url); if (!file) return undefined;
        let index = 0;
        return new Response(new ReadableStream({ async pull(sink) {
          try {
            if (index === file.chunks) { sink.close(); return; }
            const chunk = await get('chunks', `${file.id}:${index++}`);
            if (!chunk) throw new Error('Model cache is incomplete');
            sink.enqueue(chunk);
          } catch (error) { sink.error(error); }
        } }, { highWaterMark: 0 }), { headers: file.headers });
      },
      async put(url, response) {
        const id = `${Date.now()}:${crypto.randomUUID()}`, reader = response.body.getReader();
        let index = 0, offset = 0, buffer = new Uint8Array(CHUNK_BYTES);
        const write = async bytes => { const key = `${id}:${index++}`; await mutate(['chunks'], tx => tx.objectStore('chunks').put(bytes, key)); };
        try {
          while (true) {
            const { value, done } = await reader.read(); if (done) break;
            let start = 0;
            while (start < value.length) {
              const size = Math.min(buffer.length - offset, value.length - start);
              buffer.set(value.subarray(start, start + size), offset); start += size; offset += size;
              // IndexedDB has committed its structured clone by this point.
              // Reuse the 4 MiB staging buffer rather than leaving one large
              // allocation per chunk waiting for WebKit's garbage collector.
              if (offset === buffer.length) { await write(buffer); offset = 0; }
            }
          }
          if (offset) await write(buffer.subarray(0, offset));
          await mutate(['files', 'chunks'], tx => {
            const store = tx.objectStore('files'), old = store.get(url);
            old.onsuccess = () => { removeChunks(tx, old.result); store.put({ id, chunks: index, headers: Object.fromEntries(response.headers) }, url); };
          });
        } catch (error) {
          // Release the network stream promptly after a quota/write failure.
          void reader.cancel().catch(() => {});
          await mutate(['chunks'], tx => removeChunks(tx, { id, chunks: index })).catch(() => {});
          throw error;
        }
      },
      async delete(url) {
        await mutate(['files', 'chunks'], tx => {
          const store = tx.objectStore('files'), old = store.get(url);
          old.onsuccess = () => { removeChunks(tx, old.result); store.delete(url); };
        });
        return true;
      },
      close() { db.close(); },
    };
  },
};
