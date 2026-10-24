import { sha256 } from '@noble/hashes/sha2.js';
// Advance only when the inference worker/runtime or its verification exercise
// changes. Keep 0.1.16 receipts valid for stream/voting/UI-only releases.
const verificationRuntime = '0.1.16';

// UI/stream releases do not change this identity. Inference/runtime or model
// change do: a receipt certifies a particular inference implementation/device.
export function ensembleVerificationKey(model, device) {
  if (!device) return null;
  const identity = JSON.stringify([1, verificationRuntime, device, model.id, model.directory,
    model.files.map(file => [file.file, file.bytes, file.sha256, file.text])]);
  return Array.from(sha256(new TextEncoder().encode(identity)), n => n.toString(16).padStart(2, '0')).join('');
}

export async function savedEnsembleVerification(store, model, signature) {
  if (!signature) return false;
  const cache = await store.cache();
  try {
    const pending = await cache.match('preparation:' + model.id);
    if (pending && (await pending.json()).pending) return false;
    const saved = await cache.match('verification:' + model.id);
    const receipt = saved && await saved.json();
    if (receipt?.signature !== signature || !Number.isFinite(receipt.passedAt)) return false;
    for (const file of model.files) {
      if (file.text !== undefined) continue;
      const response = await cache.match(file.sha256);
      if (!response) return false;
      await response.body?.cancel();
      // Integrity is still checked as bytes are read into the worker, even
      // when the separate bundled transcription exercise is reused.
      if (response.headers.get('x-pageborne-sha256') !== file.sha256
        || Number(response.headers.get('content-length')) !== file.bytes) return false;
    }
    return true;
  } catch { return false; }
}

export async function saveEnsembleVerification(store, model, signature) {
  if (!signature) return;
  await (await store.cache()).put('verification:' + model.id,
    new Response(JSON.stringify({ signature, passedAt: Date.now() })));
}
