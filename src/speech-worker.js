import { speechModels } from './speech-models.js';
import { correctionsAvailable } from './speech-profile.js';
import { speechDownloader } from './speech-download.js';
import { setSessionLoadReporter } from './speech-session-loader.js';
import { AutoTokenizer, AutoProcessor, MoonshineForConditionalGeneration, WhisperForConditionalGeneration, AutomaticSpeechRecognitionPipeline, TextStreamer, InterruptableStoppingCriteria, LogitsProcessorList, env } from '@huggingface/transformers';
import { simd } from 'wasm-feature-detect';
import { waveSamples, SPEECH_RATE } from './speech-audio.js';
import { confidenceWords } from './speech-confidence.js';
import { speechWindowSeconds } from './speech-window.js';
import { vocabularyWords, vocabularyBias, whisperVocabularyPrompt } from './speech-vocabulary.js';
import cpuWasm from '../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm?url';
import gpuWasm from '../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm?url';

let transcriber; let info;
let tail = Promise.resolve();
const requests = new Map();
const report = (id, message) => self.postMessage({ id, progress: message });
self.onmessage = ({ data }) => {
  if (data.operation === 'cancel') { requests.get(data.id)?.interrupt(); return; }
  const stopping = new InterruptableStoppingCriteria(); requests.set(data.id, stopping);
  tail = tail.then(async () => {
    const { id, operation, backend, base, audio, model: modelId = 'fast' } = data;
    const vocabulary = vocabularyWords(data.vocabulary || []);
    let inference = false, downloads;
    try {
      if (stopping.interrupted) return;
      const chunkSeconds = speechWindowSeconds(data.chunkSeconds);
      if (modelId !== 'fast' && chunkSeconds !== 15) throw new Error('Experimental speech windows are only supported by Tiny.');
      if (!correctionsAvailable && (modelId !== 'fast' || backend !== 'wasm')) throw new Error('This speech worker supports Tiny CPU only.');
      const profile = speechModels[modelId];
      if (!profile) throw new Error('Unknown speech model.');
      const reused = !!transcriber;
      if (!transcriber) {
        if (!await simd()) throw new Error('WebAssembly SIMD is unavailable on this device.');
        let adapterInfo;
        if (correctionsAvailable && backend === 'webgpu') {
          const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
          if (!adapter) throw new Error('WebGPU is unavailable in this app. CPU voice drafts still work; GPU corrections need a supported browser.');
          if (adapter.info?.isFallbackAdapter) throw new Error('Hardware WebGPU is unavailable. CPU voice drafts still work; GPU corrections are unavailable.');
          env.backends.onnx.webgpu.adapter = adapter;
          adapterInfo = { vendor: adapter.info?.vendor || '', architecture: adapter.info?.architecture || '', fallback: !!adapter.info?.isFallbackAdapter };
        }
        report(id, 'Loading local speech model…');
        env.allowRemoteModels = false; env.allowLocalModels = true; env.localModelPath = new URL(base).pathname;
        env.useBrowserCache = false;
        downloads = correctionsAvailable && modelId === 'refine' ? speechDownloader({ base, progress: message => report(id, message) }) : null;
        if (downloads) env.fetch = downloads.fetch;
        // Single threaded SIMD works without COOP/COEP in Even's WebView.
        // This worker keeps model work off the phone UI thread.
        env.backends.onnx.wasm.numThreads = 1; env.backends.onnx.wasm.proxy = false;
        env.backends.onnx.wasm.wasmPaths = {
          mjs: `${base}ort-wasm-simd-threaded${correctionsAvailable && backend === 'webgpu' ? '.asyncify' : ''}.mjs`,
          wasm: new URL(correctionsAvailable && backend === 'webgpu' ? gpuWasm : cpuWasm, self.location.href).href,
        };
        const start = performance.now();
        setSessionLoadReporter((name, phase) => {
          if (modelId !== 'refine') return;
          const component = name.includes('decoder') ? 'decoder' : 'encoder';
          if (phase === 'initializing') report(id, `Initializing corrections · ${component}…`);
          else if (phase === 'reading') report(id, `Reading correction weights · ${component}…`);
        });
        const options = {
          device: backend, dtype: profile.dtype,
          // Avoid startup graph rewrites/prepacked constants duplicating Small's
          // weights. WebGPU still compiles its kernels; Tiny is unchanged.
          ...(modelId === 'refine' ? { session_options: { graphOptimizationLevel: 'disabled', enableCpuMemArena: false, extra: { session: { disable_prepacking: '1' } } } } : {}),
          // Our downloader reports progress. A second Transformers callback
          // also triggers metadata GETs for these same large weight files.
          ...(downloads ? {} : { progress_callback: event => { if (event.status === 'progress' && Number.isFinite(event.progress)) report(id, `Loading speech model · ${Math.round(event.progress)}%`); } }),
        };
        // Configuration is bundled. Only the two pinned correction weights
        // use the downloader; repository discovery remains disabled.
        const [tokenizer, processor, model] = await Promise.all([
          AutoTokenizer.from_pretrained(profile.directory, options),
          AutoProcessor.from_pretrained(profile.directory, options),
          (correctionsAvailable && profile.directory.startsWith('whisper') ? WhisperForConditionalGeneration : MoonshineForConditionalGeneration).from_pretrained(profile.directory, options),
        ]);
        transcriber = new AutomaticSpeechRecognitionPipeline({ task: 'automatic-speech-recognition', tokenizer, processor, model });
        info = { backend, simd: true, threads: 1, model: profile.name, loadMs: Math.round(performance.now() - start), sessionLoading: 'serial-release', ...(adapterInfo ? { adapter: adapterInfo } : {}), ...(downloads ? { download: { ...downloads.stats } } : {}) };
      }
      let result = { ...info, loadMs: reused ? 0 : info.loadMs, reused };
      if (operation === 'transcribe') {
        if (stopping.interrupted) return;
        const samples = waveSamples(audio);
        let energy = 0; for (const sample of samples) energy += sample * sample;
        if (Math.sqrt(energy / samples.length) < 0.0001) throw new Error('The recording is silent. Try speaking closer to the microphone.');
        report(id, `Transcribing locally · ${backend === 'webgpu' ? 'WebGPU' : 'SIMD'}…`);
        const start = performance.now();
        // Default remains 15 seconds. Experiments must change this inner limit
        // too, otherwise a larger SpeechStream buffer adds no acoustic context.
        const texts = [], words = [], segments = []; let textLength = 0, offset = 0;
        const whisper = correctionsAvailable && profile.directory.startsWith('whisper');
        const prompt = whisper ? whisperVocabularyPrompt(transcriber.tokenizer, transcriber.model.generation_config, vocabulary, transcriber.model.config.max_target_positions) : null;
        const prefix = prompt?.prefix;
        const bias = !whisper && vocabulary.length ? vocabularyBias(transcriber.tokenizer, vocabulary) : null;
        while (offset < samples.length) {
          if (stopping.interrupted) return;
          let end = Math.min(samples.length, offset + Math.round(chunkSeconds * SPEECH_RATE));
          if (end < samples.length) {
            let lowest = Infinity; const limit = end;
            for (let at = limit - 2 * SPEECH_RATE; at < limit; at += 1600) {
              let sum = 0; for (let i = at; i < at + 1600; i++) sum += samples[i] ** 2;
              if (sum < lowest) { lowest = sum; end = at + 800; }
            }
          }
          const part = samples.subarray(offset, end);
          inference = true;
          const scores = [], special = new Set(transcriber.tokenizer.all_special_ids || []);
          const processors = new LogitsProcessorList();
          processors.push((ids, logits) => {
            const boosts = bias?.(ids, logits);
            let max = -Infinity, selected = -Infinity, token = -1;
            for (let i = 0; i < logits.data.length; i++) {
              max = Math.max(max, logits.data[i]);
              const value = logits.data[i] + (boosts?.get(i) || 0);
              if (value > selected) { selected = value; token = i; }
            }
            if (Number.isFinite(max) && !special.has(token)) {
              let sum = 0; for (const value of logits.data) sum += Math.exp(value - max);
              // Show the acoustic/model score before our vocabulary boost,
              // so a favored spelling cannot manufacture high confidence.
              const score = { token, probability: Math.exp(logits.data[token] - max) / sum };
              scores.push(score);
            }
            for (const [token, amount] of boosts || []) logits.data[token] += amount;
            return logits;
          });
          let streamed = '';
          const decode = ids => transcriber.tokenizer.decode(ids, { skip_special_tokens: true, clean_up_tokenization_spaces: false });
          const streamer = data.stream ? new TextStreamer(transcriber.tokenizer, {
            skip_prompt: true, decode_kwargs: { skip_special_tokens: true, clean_up_tokenization_spaces: false },
            callback_function: piece => {
              if (stopping.interrupted) return;
              streamed += piece;
              const text = streamed.trim(); if (!text) return;
              const prefix = texts.length ? texts.join(' ') + ' ' : '';
              // Scores can include the next incomplete word. Align against the
              // decoded score sequence, then expose only fully emitted words.
              const scored = decode(scores.map(score => score.token)).trim();
              const partialWords = scored.startsWith(text) ? confidenceWords(scored, scores, decode, data.confidence)
                .filter(word => word.end <= text.length).map(word => ({ ...word, start: word.start + prefix.length, end: word.end + prefix.length })) : [];
              self.postMessage({ id, partial: { ...result, text: prefix + text, words: [...words, ...partialWords],
                partial: true, seconds: end / SPEECH_RATE, transcribeMs: Math.round(performance.now() - start) } });
            },
          }) : undefined;
          // 8 tokens/audio second, unchanged for default chunks; allow a full
          // minute's output instead of silently capping long experiments at 180.
          const options = { ...(streamer ? { streamer } : {}), max_new_tokens: Math.min(480, Math.max(8, Math.ceil(part.length / SPEECH_RATE * 8))), do_sample: false, stopping_criteria: [stopping], logits_processor: processors };
          let text;
          if (prefix) {
            const inputs = await transcriber.processor(part);
            const output = await transcriber.model.generate({ inputs: inputs.input_features, decoder_input_ids: prefix, ...options });
            text = transcriber.tokenizer.decode(output.tolist()[0].slice(prefix.length), { skip_special_tokens: true }).trim();
          } else {
            text = (await transcriber(part, options)).text.trim();
          }
          if (text) {
            const start = textLength + (texts.length ? 1 : 0);
            words.push(...confidenceWords(text, scores, ids => transcriber.tokenizer.decode(ids, { skip_special_tokens: true, clean_up_tokenization_spaces: false }), data.confidence)
              .map(word => ({ ...word, start: word.start + start, end: word.end + start })));
            texts.push(text); textLength = start + text.length;
          }
          segments.push({ seconds: part.length / SPEECH_RATE, tokens: scores.length, tokenLimit: options.max_new_tokens });
          offset = end;
        }
        result = { ...result, text: texts.join(' ').trim(), words, segments, vocabularyTerms: prompt ? prompt.terms.length : vocabulary.length,
          vocabularyCandidates: vocabulary.length, vocabularyTokens: prefix ? prefix.length - 3 : 0,
          partial: !!data.partial, seconds: samples.length / SPEECH_RATE, transcribeMs: Math.round(performance.now() - start) };
      }
      if (!stopping.interrupted) self.postMessage({ id, result });
    } catch (error) { if (!stopping.interrupted) self.postMessage({ id, error: String(downloads?.error?.message || error.message || error).slice(0, 1000), fatal: !transcriber || inference }); }
    finally { requests.delete(id); }
  });
};
