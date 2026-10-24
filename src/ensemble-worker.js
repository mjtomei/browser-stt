import { moonshineRecognizer } from './ensemble-moonshine.js';
import { waveSamples } from './speech-audio.js';
import { vocabularyWords } from './speech-vocabulary.js';
import { decodeCtc, tokenTable, piecesResult } from './ctc-context.js';
import speechRuntimeSource from '../vendor/ensemble-runtime/pageborne-speech.mjs?raw';
import { releaseModelBuffer } from './speech-session-loader.js';
import { modelFileBuffer } from './model-file-buffer.js';

let runtime, engine, model, tokens, base, serial = 0, tail = Promise.resolve();
let reportSetup = () => {}, loadedBytes = 0, lastProgress = 0, modelComponent = '';
const waiting = new Map(), cancelled = new Set();
const rpc = (action, data) => new Promise((resolve, reject) => {
  const request = ++serial; waiting.set(request, { resolve, reject }); self.postMessage({ cache: { request, action, ...data } });
});
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const checkpoint = async progress => { reportSetup(progress); await rpc('checkpoint', {}); };
async function readFile(file) {
  let fileLoadedBytes = 0;
  const progress = () => {
    // Transformers reads generation metadata alongside the encoder session.
    // That small JSON response must not overwrite the active model phase or
    // its durable checkpoint while allocation/initialization is pending.
    if (modelComponent && !file.file.endsWith('.onnx')) return;
    reportSetup({ stage: 'loading', loadedBytes, file: file.file, fileLoadedBytes, fileBytes: file.bytes });
  };
  progress();
  const handle = await rpc('open', { file: file.file });
  const headers = { 'content-length': String(file.bytes), 'content-type': 'application/octet-stream' };
  if (model.id === 'moonshine' && file.file.endsWith('.onnx')) {
    const response = new Response(null, { headers }); let consumed = false;
    response.arrayBuffer = () => {
      if (consumed) return Promise.reject(new TypeError('Model response already consumed.'));
      consumed = true;
      return modelFileBuffer(file.bytes, async () => {
        const value = await rpc('read', { handle });
        if (value.done) progress();
        else {
          loadedBytes += value.bytes.byteLength; fileLoadedBytes += value.bytes.byteLength;
          if (performance.now() - lastProgress > 150) { lastProgress = performance.now(); progress(); }
        }
        return value;
      }, () => rpc('cancel', { handle }));
    };
    return response;
  }
  const response = new Response(new ReadableStream({ async pull(sink) {
    try {
      const value = await rpc('read', { handle });
      if (value.done) { progress(); sink.close(); }
      else {
        loadedBytes += value.bytes.byteLength; fileLoadedBytes += value.bytes.byteLength;
        if (performance.now() - lastProgress > 150) { lastProgress = performance.now(); progress(); }
        sink.enqueue(new Uint8Array(value.bytes));
      }
    }
    catch (error) { sink.error(error); }
  }, cancel: () => rpc('cancel', { handle }) }, { highWaterMark: 0 }), { headers });
  response.arrayBuffer = async () => {
    // The serial session loader checkpoints before starting the model read.
    // Metadata files can load concurrently, so do not create competing
    // diagnostic barriers for each small tokenizer/configuration response.
    const bytes = new Uint8Array(file.bytes), reader = response.body.getReader(); let at = 0;
    try {
      for (;;) { const value = await reader.read(); if (value.done) break; bytes.set(value.value, at); at += value.value.length; releaseModelBuffer(value.value); }
      if (at !== bytes.length) throw Error('Incomplete model file.');
      return bytes.buffer;
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  };
  return response;
}
async function prepare(data) {
  model = data.model; base = data.base;
  reportSetup = progress => self.postMessage({ id: data.id, progress });
  loadedBytes = 0; reportSetup({ stage: 'runtime', loadedBytes });
  if (model.id === 'moonshine') {
    engine = await moonshineRecognizer(base, async input => {
      const pathname = new URL(typeof input === 'string' ? input : input.url, base).pathname;
      const file = model.files.find(f => pathname.endsWith('/moonshine/' + f.file));
      if (file) return readFile(file);
      const url = new URL(typeof input === 'string' ? input : input.url, base);
      if (url.origin === new URL(base).origin && url.pathname.startsWith(new URL(base).pathname) && /ort-wasm.*\.(mjs|wasm)$/.test(url.pathname)) return fetch(url);
      return new Response('', { status: 404 });
    }, progress => {
      modelComponent = progress.component;
      return checkpoint({ ...progress, loadedBytes, file: '', fileLoadedBytes: 0, fileBytes: 0 });
    });
  } else {
    // The Even host may serve .mjs as a generic file rather than JavaScript.
    // Bundle this trusted source and supply its module MIME type explicitly,
    // as Transformers already does for the Moonshine runtime. WASM remains a
    // separate local asset; no model download or cached weight is changed.
    const runtimeUrl = URL.createObjectURL(new Blob([speechRuntimeSource], { type: 'text/javascript' }));
    try {
      const module = await import(/* @vite-ignore */ runtimeUrl);
      runtime = await module.default({ locateFile: file => new URL('ensemble/' + file, base).href, print: () => {}, printErr: () => {} });
    } catch (error) { throw Error(`Could not start ${model.name} runtime: ${error.message}`); }
    finally { URL.revokeObjectURL(runtimeUrl); }
    runtime.FS.mkdir('/models');
    for (const file of model.files) {
      const destination = file.file.startsWith('encoder-') ? 'encoder.onnx' : file.file.startsWith('decoder-') ? 'decoder.onnx' : file.file.startsWith('joiner-') ? 'joiner.onnx' : file.file === 'model.int8.onnx' ? 'model.onnx' : file.file;
      const response = await readFile(file), reader = response.body.getReader();
      const stream = runtime.FS.open('/models/' + destination, 'w'); let position = 0;
      try {
        for (;;) { const value = await reader.read(); if (value.done) break; runtime.FS.write(stream, value.value, 0, value.value.length, position); position += value.value.length; releaseModelBuffer(value.value); }
      } finally { runtime.FS.close(stream); await reader.cancel().catch(() => {}); reader.releaseLock(); }
    }
    if (model.id === 'conformer') tokens = tokenTable(runtime.FS.readFile('/models/tokens.txt', { encoding: 'utf8' }));
    reportSetup({ stage: 'initializing', loadedBytes, file: '', component: 'model' });
    if (!runtime._pb_init(model.id === 'zipformer' ? 0 : 1)) throw Error('Speech model could not initialize.');
    for (const file of runtime.FS.readdir('/models')) if (file !== '.' && file !== '..') runtime.FS.unlink('/models/' + file);
  }
}
async function transcribe(data, partial) {
  const audio = waveSamples(data.audio), vocabulary = vocabularyWords(data.vocabulary || []);
  if (audio.length > 16 * 16000) throw Error('Ensemble windows must be at most 15 seconds.');
  let energy = 0; for (const sample of audio) energy += sample * sample;
  if (Math.sqrt(energy / audio.length) < .0001) return { text: '', words: [] };
  if (engine) return engine.transcribe(audio, { vocabulary, confidence: data.confidence, partial, cancelled: () => cancelled.has(data.id) });
  const ptr = runtime._malloc((audio.length + 4800) * 4);
  try {
    runtime.HEAPF32.set(audio, ptr / 4);
    if (model.id === 'conformer') {
      const out = runtime._pb_ctc_run(ptr, audio.length), frames = runtime._pb_ctc_frames(), width = runtime._pb_ctc_vocab();
      try { return decodeCtc(runtime.HEAPF32.subarray(out / 4, out / 4 + frames * width), frames, tokens, vocabulary, data.confidence); }
      finally { runtime._pb_ctc_release(); }
    }
    runtime.ccall('pb_zip_start', null, ['string'], [vocabulary.map(s => s.toUpperCase().replaceAll('/', ' ')).join('/')]);
    const result = () => {
      const r = JSON.parse(runtime.UTF8ToString(runtime._pb_zip_result()));
      if (r.tokens.length !== r.ys_probs.length) throw Error('Zipformer confidence is unavailable.');
      return piecesResult(r.tokens.map((s, i) => ({ text: s.replaceAll('▁', ' '), probability: Math.exp(Math.min(0, r.ys_probs[i])) })), data.confidence);
    };
    let text = '';
    for (let at = 0; at < audio.length; at += 1600) {
      runtime._pb_zip_accept(ptr + at * 4, Math.min(1600, audio.length - at));
      while (runtime._pb_zip_ready()) runtime._pb_zip_decode();
      const value = result(); if (value.text !== text) { text = value.text; partial(value); }
      await tick(); if (cancelled.has(data.id)) throw new DOMException('Cancelled', 'AbortError');
    }
    runtime.HEAPF32.fill(0, ptr / 4 + audio.length, ptr / 4 + audio.length + 4800);
    runtime._pb_zip_accept(ptr + audio.length * 4, 4800); runtime._pb_zip_end();
    while (runtime._pb_zip_ready()) runtime._pb_zip_decode();
    return result();
  } finally { runtime._free(ptr); }
}
self.onmessage = ({ data }) => {
  if (data.cacheReply) {
    const item = waiting.get(data.request); if (!item) return; waiting.delete(data.request);
    if (data.error) item.reject(Error(data.error)); else item.resolve(data.value); return;
  }
  if (data.operation === 'cancel') { cancelled.add(data.id); return; }
  tail = tail.then(async () => {
    const { id } = data, start = performance.now();
    try {
      if (cancelled.has(id)) return;
      if (data.operation === 'prepare') {
        await prepare(data);
        if (!data.reuseVerification) {
        reportSetup({ stage: 'checking', loadedBytes });
        // Bundled public-domain speech exercises the real encoder and decoder;
        // silent audio would bypass inference and falsely certify readiness.
        const response = await fetch(new URL('ensemble-check.wav', base));
        if (!response.ok) throw Error('The bundled voice check could not be opened.');
        const checked = await transcribe({ id, audio: await response.arrayBuffer(), vocabulary: [] }, () => {});
        const anchors = ['apostle', 'middle', 'gospel'].filter(word => checked.text?.toLowerCase().includes(word));
        if (anchors.length < 2 || checked.words?.length < 5 || !checked.words.every(word => Number.isFinite(word.confidence))) throw Error('The model could not transcribe the voice check. Retry setup.');
        }
        self.postMessage({ id, result: { backend: 'wasm', model: model.name, simd: true, verified: true, verification: data.reuseVerification ? 'saved' : 'tested', wasmBytes: runtime?.HEAPU8.byteLength, loadMs: performance.now() - start } });
      } else {
        const value = await transcribe(data, value => { if (!cancelled.has(id)) self.postMessage({ id, partial: value }); });
        if (!cancelled.has(id)) self.postMessage({ id, result: { ...value, backend: 'wasm', model: model.name, seconds: waveSamples(data.audio).length / 16000, transcribeMs: performance.now() - start } });
      }
    } catch (error) { if (!cancelled.has(id)) self.postMessage({ id, error: error?.message || String(error), errorName: error?.name, errorStack: error?.stack }); }
    finally { cancelled.delete(id); }
  });
};
