import * as ort from 'onnxruntime-web/wasm';
import { ParakeetFeatureExtractor } from '@huggingface/transformers';
import cpuWasm from '../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm?url';
import { confidenceWords } from './speech-confidence.js';
import { releaseModelBuffer } from './speech-session-loader.js';
import { fluidMelFilters, fluidTokenizer, fluidDecision } from './fluid-mini-utils.js';

const first = output => Object.values(output)[0];
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const dispose = output => { for (const tensor of Object.values(output || {})) tensor.dispose(); };

export async function fluidMiniRecognizer(base, readFile, stage = () => {}) {
  ort.env.wasm.numThreads = 1; ort.env.wasm.proxy = false;
  const config = await (await readFile('config.json')).json();
  const tokenizer = fluidTokenizer(await (await readFile('tokenizer.json')).json(), config);
  const filters = fluidMelFilters(await (await readFile('mel_filters.npy')).arrayBuffer(), config.num_mel_bins, config.n_fft / 2 + 1);
  const features = new ParakeetFeatureExtractor({ ...config, feature_size: config.num_mel_bins, mel_filters: filters });
  // Even can serve .mjs as application/octet-stream. Import the local loader
  // through an explicitly typed Blob; the WASM URL remains absolute/local.
  const loader = await fetch(new URL('ort-wasm-simd-threaded.mjs', base));
  if (!loader.ok) throw Error(`Could not load the speech runtime (${loader.status}).`);
  const loaderUrl = URL.createObjectURL(new Blob([await loader.text()], { type: 'text/javascript' }));
  ort.env.wasm.wasmPaths = { mjs: loaderUrl, wasm: new URL(cpuWasm, self.location.href).href };
  const sessions = {};
  try {
    // Keep only one set of weight staging buffers at a time. External encoder
    // data remains packed; disable prepacking/arenas to avoid retained peaks.
    for (const name of ['encoder', 'frontend', 'decoder', 'joint']) {
      await stage({ stage: 'loading', component: name });
      let bytes = await (await readFile(name + '.onnx')).arrayBuffer(), external;
      try {
        if (name === 'encoder') external = await (await readFile('encoder.onnx.data')).arrayBuffer();
        await stage({ stage: 'initializing', component: name });
        sessions[name] = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'],
          graphOptimizationLevel: 'disabled', enableCpuMemArena: false, enableMemPattern: false,
          extra: { session: { disable_prepacking: '1' } },
          ...(external ? { externalData: [{ path: 'encoder.onnx.data', data: new Uint8Array(external) }] } : {}) });
      } finally { releaseModelBuffer(bytes); if (external) releaseModelBuffer(external); bytes = external = null; }
    }
  } catch (error) { for (const session of Object.values(sessions)) await session.release(); throw error; }
  finally { URL.revokeObjectURL(loaderUrl); }
  const down = frames => { for (let i = 0; i < config.subsampling_layers; i++) frames = Math.floor((frames - 1) / config.subsampling_stride + 1); return frames; };
  const tensor = (data, dims) => new ort.Tensor(data instanceof Float32Array ? 'float32' : 'int64', data, dims);
  const run = async (session, input) => { try { return await session.run(input); } finally { dispose(input); } };
  return { async transcribe(audio, { confidence, partial = () => {}, cancelled = () => false } = {}) {
    const check = () => { if (cancelled()) throw new DOMException('Transcription cancelled.', 'AbortError'); };
    check(); if (audio.length < config.hop_length * 2) return { text: '', words: [] };
    const extracted = await features(audio), frames = extracted.input_features.dims[1];
    const total = down(frames), valid = down(Math.floor(audio.length / config.hop_length));
    const factor = config.subsampling_stride ** config.subsampling_layers, hiddenSize = config.encoder_hidden_size;
    const hidden = new Float32Array(total * hiddenSize);
    let encoded, decoded;
    try {
      for (let a = 0; a < total; a += config.frontend_chunk_frames) {
        check();
        const b = Math.min(a + config.frontend_chunk_frames, total), s = a ? factor * (a - 1) : 0, e = Math.min(frames, factor * (b + 1));
        const output = await run(sessions.frontend, {
          input_features: tensor(extracted.input_features.data.slice(s * config.num_mel_bins, e * config.num_mel_bins), [1, e - s, config.num_mel_bins]),
          attention_mask: tensor(extracted.attention_mask.data.slice(s, e), [1, e - s]),
        });
        try { const offset = a ? 1 : 0; hidden.set(first(output).data.subarray(offset * hiddenSize, (offset + b - a) * hiddenSize), a * hiddenSize); }
        finally { dispose(output); }
      }
      check();
      encoded = await run(sessions.encoder, { hidden_states: tensor(hidden, [1, total, hiddenSize]), length: tensor(new BigInt64Array([BigInt(valid)]), [1]) });
      const stateShape = [config.decoder_layers, 1, config.decoder_hidden_size], stateSize = config.decoder_layers * config.decoder_hidden_size;
      decoded = Object.values(await run(sessions.decoder, { token: tensor(new BigInt64Array([BigInt(config.blank_token_id)]), [1, 1]), h_in: tensor(new Float32Array(stateSize), stateShape), c_in: tensor(new Float32Array(stateSize), stateShape) }));
      const scores = [], ids = []; let t = 0, lastPartial = 0;
      const result = () => { const text = tokenizer.decode(ids).trim(); return { text, words: confidenceWords(text, scores, tokenizer.decode, confidence) }; };
      for (let i = 0; i < config.max_symbols_per_step * total - 1; i++) {
        check();
        // decoder_out is reused on a blank; dispose only the frame here.
        const frame = tensor(first(encoded).data.slice(t * hiddenSize, (t + 1) * hiddenSize), [1, hiddenSize]);
        let output;
        try { output = await sessions.joint.run({ encoder_frame: frame, decoder_out: decoded[0] }); }
        finally { frame.dispose(); }
        let decision; try { decision = fluidDecision(first(output).data, config); } finally { dispose(output); }
        const { token, step, probability } = decision;
        ids.push(token); if (!tokenizer.skip.has(token)) scores.push({ token, probability });
        t += step;
        if (t >= valid || token === config.eos_token_id) return result();
        if (token !== config.blank_token_id) {
          const tokenInput = tensor(new BigInt64Array([BigInt(token)]), [1, 1]);
          let next; try { next = Object.values(await sessions.decoder.run({ token: tokenInput, h_in: decoded[1], c_in: decoded[2] })); }
          finally { tokenInput.dispose(); }
          dispose(decoded); decoded = next;
        }
        if (i % 16 === 0) {
          if (performance.now() - lastPartial > 150) { partial(result()); lastPartial = performance.now(); }
          await tick(); check();
        }
      }
      throw Error('Speech exceeded the decoder limit. Try a shorter phrase.');
    } finally { dispose(encoded); dispose(decoded); extracted.input_features.dispose(); extracted.attention_mask.dispose(); }
  } };
}
