let reporter = () => {};
export function setSessionLoadReporter(callback) { reporter = callback; }

// ONNX Runtime Web copies the model into its own WASM memory before create()
// resolves. Drop our standalone staging buffer immediately, rather than keeping
// it alive in Promise.all/initialization closures until an eventual collection.
export function releaseModelBuffer(value) {
  if (!(value instanceof Uint8Array) || value.byteOffset !== 0 || value.byteLength !== value.buffer.byteLength) return;
  const buffer = value.buffer;
  if (!(buffer instanceof ArrayBuffer) || !buffer.byteLength) return;
  if (typeof buffer.transfer === 'function') buffer.transfer(0);
  else if (typeof structuredClone === 'function') structuredClone(buffer, { transfer: [buffer] });
}

// This is used only by our built speech worker, not other Transformers users.
// Keep download/read + session creation in one lane: serializing create alone
// still allows every model file to occupy a full JS buffer while it waits.
export async function loadSpeechSessions(names, getSession, createSession) {
  const sessions = {};
  try {
    for (const name of names) {
      await reporter(name, 'reading');
      const data = await getSession(name);
      try {
        await reporter(name, 'initializing');
        sessions[name] = await createSession(data);
      } finally {
        releaseModelBuffer(data.buffer_or_path);
      }
      await reporter(name, 'ready');
    }
    return sessions;
  } catch (error) {
    await Promise.allSettled(Object.values(sessions).map(session => Promise.resolve().then(() => session.release())));
    throw error;
  }
}
