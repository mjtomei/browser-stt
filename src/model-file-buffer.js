import { releaseModelBuffer } from './speech-session-loader.js';

// The cache worker already provides a verified, backpressured read protocol.
// Buffer ONNX files directly from it, without adding a second ReadableStream
// and a reader-cancellation step between EOF and session initialization.
export async function modelFileBuffer(size, read, cancel) {
  let bytes, complete = false, at = 0;
  try {
    bytes = new Uint8Array(size);
    for (;;) {
      const value = await read();
      if (value.done) { complete = true; break; }
      const chunk = new Uint8Array(value.bytes);
      try {
        if (chunk.length > bytes.length - at) throw Error('Model file exceeds its expected size.');
        bytes.set(chunk, at); at += chunk.length;
      } finally { releaseModelBuffer(chunk); }
    }
    if (at !== bytes.length) throw Error('Incomplete model file.');
    return bytes.buffer;
  } catch (error) {
    releaseModelBuffer(bytes);
    throw error;
  } finally {
    // EOF releases the handle on the cache side. A failed read must not hide
    // its original error behind a second, potentially unresponsive cache call.
    if (!complete) void Promise.resolve().then(cancel).catch(() => {});
  }
}
