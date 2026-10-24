import { fileURLToPath } from 'node:url';

// Transformers 4.3.0 serializes ORT create(), but first buffers all model files
// concurrently. A narrow build-time adaptation keeps its dtype/device/KV-cache
// configuration intact while serializing the whole load. Fail the build on an
// upstream source change instead of silently losing this memory bound.
const signature = 'async function constructSessions(pretrained_model_name_or_path, names, options, cache_sessions = void 0)';
const original = `${signature} {
  return Object.fromEntries(
    await Promise.all(
      Object.keys(names).map(async (name) => {
        const cache_config = cache_sessions?.[name] ?? false;
        const { buffer_or_path, session_options, session_config } = await getSession(
          pretrained_model_name_or_path,
          names[name],
          options,
          cache_config,
          name
        );
        const session = await createInferenceSession(buffer_or_path, session_options, session_config);
        return [name, session];
      })
    )
  );
}`;
const replacement = `${signature} {
  return loadSpeechSessions(Object.keys(names), name => getSession(
    pretrained_model_name_or_path, names[name], options, cache_sessions?.[name] ?? false, name,
  ), data => createInferenceSession(data.buffer_or_path, data.session_options, data.session_config));
}`;
export function serialSpeechSessions() {
  let patched = false;
  return { name: 'serial-speech-sessions',
    buildStart() { patched = false; },
    transform(code, id) {
      if (!id.endsWith('/@huggingface/transformers/dist/transformers.web.js')) return;
      if (!code.includes(original)) throw new Error('Transformers session loader changed; review the speech memory adaptation.');
      patched = true;
      return `import { loadSpeechSessions } from ${JSON.stringify(fileURLToPath(new URL('../src/speech-session-loader.js', import.meta.url)))};\n` + code.replace(original, replacement);
    },
    buildEnd(error) { if (!error && !patched) throw new Error('Speech session memory adaptation was not applied.'); },
  };
}
