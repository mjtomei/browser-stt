// Fluid Speech Mini by FluidVoice (CC BY 4.0). The model's reference
// preprocessing/greedy TDT decode is adapted for bounded browser windows.
// Weights are unchanged. See vendor/stt/fluid-mini-NOTICE and README.md.
export function fluidMelFilters(buffer, bins, frequencies) {
  const bytes = new Uint8Array(buffer), view = new DataView(buffer);
  if (bytes.length < 10 || bytes[0] !== 0x93 || new TextDecoder().decode(bytes.subarray(1, 6)) !== 'NUMPY' || bytes[6] !== 1) throw Error('Invalid Fluid mel filter file.');
  const offset = 10 + view.getUint16(8, true), header = new TextDecoder().decode(bytes.subarray(10, offset));
  if (!/'descr':\s*'<f4'/.test(header) || !/'fortran_order':\s*False/.test(header)
    || !new RegExp(`'shape':\\s*\\(${bins},\\s*${frequencies}\\)`).test(header)
    || offset + bins * frequencies * 4 !== bytes.length) throw Error('Unexpected Fluid mel filter shape.');
  return Array.from({ length: bins }, (_, row) => Array.from({ length: frequencies }, (_, column) => view.getFloat32(offset + (row * frequencies + column) * 4, true)));
}

export function fluidTokenizer(tokenizer, config) {
  const pieces = new Map(Object.entries(tokenizer.model.vocab).map(([piece, id]) => [id, piece]));
  const skip = new Set([config.blank_token_id, config.pad_token_id]);
  for (const token of tokenizer.added_tokens || []) { pieces.set(token.id, token.content); if (token.special) skip.add(token.id); }
  const space = tokenizer.decoder?.replacement || '▁';
  return { skip, decode: ids => ids.filter(id => !skip.has(id)).map(id => pieces.get(id) || '').join('').replaceAll(space, ' ').replace(/^ /, '') };
}

export function fluidDecision(logits, config) {
  if (logits.length !== config.vocab_size + config.durations.length) throw Error('Unexpected Fluid decoder output.');
  let token = 0, duration = 0;
  for (let i = 1; i < config.vocab_size; i++) if (logits[i] > logits[token]) token = i;
  for (let i = 1; i < config.durations.length; i++) if (logits[config.vocab_size + i] > logits[config.vocab_size + duration]) duration = i;
  const maximum = logits[token]; let sum = 0;
  for (let i = 0; i < config.vocab_size; i++) sum += Math.exp(logits[i] - maximum);
  if (!Number.isFinite(sum) || sum <= 0) throw Error('Fluid decoder returned invalid scores.');
  let step = config.durations[duration];
  if (token === config.blank_token_id && step === 0) step = 1;
  return { token, step, probability: 1 / sum };
}

// A token may be only the first letter of a word. Live output can safely show
// the preceding words while the decoder finishes the current one. The final
// result always retains the full text and all confidence spans.
export function fluidPartial(value) {
  const boundary = value.text.search(/\s+\S*$/u);
  const text = boundary < 0 ? '' : value.text.slice(0, boundary).trimEnd();
  return { text, words: value.words.filter(word => word.end <= text.length) };
}
