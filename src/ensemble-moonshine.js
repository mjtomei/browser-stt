import { AutoTokenizer, AutoProcessor, MoonshineForConditionalGeneration, AutomaticSpeechRecognitionPipeline, LogitsProcessorList, TextStreamer, InterruptableStoppingCriteria, env } from '@huggingface/transformers';
import { confidenceWords } from './speech-confidence.js';
import { vocabularyBias } from './speech-vocabulary.js';
import { setSessionLoadReporter } from './speech-session-loader.js';
import cpuWasm from '../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm?url';

export async function moonshineRecognizer(base, fetchFile, stage = () => {}) {
  env.allowRemoteModels = false; env.allowLocalModels = true; env.useBrowserCache = false;
  env.localModelPath = new URL('ensemble/', base).pathname;
  env.fetch = fetchFile;
  env.backends.onnx.wasm.numThreads = 1; env.backends.onnx.wasm.proxy = false;
  env.backends.onnx.wasm.wasmPaths = { mjs: new URL('ort-wasm-simd-threaded.mjs', base).href, wasm: new URL(cpuWasm, self.location.href).href };
  const options = { device: 'wasm', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' }, session_options: {
    intraOpNumThreads: 1, interOpNumThreads: 1,
    graphOptimizationLevel: 'disabled', enableCpuMemArena: false,
    extra: { session: { disable_prepacking: '1' } },
  } };
  const tokenizer = await AutoTokenizer.from_pretrained('moonshine', options);
  const processor = await AutoProcessor.from_pretrained('moonshine', options);
  setSessionLoadReporter((name, phase) => {
    if (phase !== 'ready') return stage({ stage: phase === 'reading' ? 'loading' : 'initializing', component: name.includes('decoder') ? 'decoder' : 'encoder' });
  });
  await stage({ stage: 'initializing', component: 'configuration' });
  const model = await MoonshineForConditionalGeneration.from_pretrained('moonshine', options);
  const pipe = new AutomaticSpeechRecognitionPipeline({ task: 'automatic-speech-recognition', tokenizer, processor, model });
  return { async transcribe(audio, { vocabulary, confidence, partial, cancelled }) {
    const scores = [], special = new Set(tokenizer.all_special_ids || []), bias = vocabulary.length ? vocabularyBias(tokenizer, vocabulary) : null;
    const stop = new InterruptableStoppingCriteria(), processors = new LogitsProcessorList();
    const decode = ids => tokenizer.decode(ids, { skip_special_tokens: true, clean_up_tokenization_spaces: false });
    const words = text => confidenceWords(text, scores, decode, confidence);
    processors.push((ids, logits) => {
      if (cancelled()) stop.interrupt();
      const boosts = bias?.(ids, logits); let maximum = -Infinity, selected = -Infinity, token = -1;
      for (let i = 0; i < logits.data.length; i++) {
        maximum = Math.max(maximum, logits.data[i]);
        const score = logits.data[i] + (boosts?.get(i) || 0);
        if (score > selected) { selected = score; token = i; }
      }
      if (!special.has(token) && Number.isFinite(maximum)) {
        let sum = 0; for (const v of logits.data) sum += Math.exp(v - maximum);
        scores.push({ token, probability: Math.exp(logits.data[token] - maximum) / sum });
      }
      for (const [id, amount] of boosts || []) logits.data[id] += amount;
      return logits;
    });
    let streamed = '';
    const streamer = new TextStreamer(tokenizer, { skip_prompt: true, callback_function: piece => {
      streamed += piece; const text = streamed.trim(), scored = decode(scores.map(s => s.token)).trim();
      if (text && !cancelled()) partial({ text, words: scored.startsWith(text) ? words(scored).filter(w => w.end <= text.length) : [] });
    } });
    const result = await pipe(audio, { do_sample: false, max_new_tokens: Math.min(180, Math.max(8, Math.ceil(audio.length / 16000 * 8))), logits_processor: processors, streamer, stopping_criteria: [stop] });
    const text = result.text.trim();
    return { text, words: words(text) };
  } };
}
