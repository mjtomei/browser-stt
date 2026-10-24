export function vocabularyWords(value) {
  const seen = new Set();
  // The array form carries manual + ranked source terms to the workers.
  // Bound input size, not term count; never reapply the custom-field limit.
  const text = Array.isArray(value) ? value.join('\n').slice(0, 16000) : String(value || '').slice(0, 4000);
  return text.split(/[,;\n]/).map(term => term.normalize('NFKC').replace(/’/g, "'").replace(/[^\p{L}\p{N} '’.-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 60))
    .filter(term => /\p{L}/u.test(term) && !seen.has(term.toLowerCase()) && seen.add(term.toLowerCase()));
}

// Moonshine has no Whisper-style context prompt. Soft bias only plausible
// vocabulary continuations; never force a token or rewrite recognized text.
export function vocabularyBias(tokenizer, vocabulary) {
  const special = new Set(tokenizer.all_special_ids || []);
  const sequences = vocabulary.flatMap(term => [' ' + term, term].map(value => tokenizer.encode(value, { add_special_tokens: false }).map(Number)))
    .filter(ids => ids.length && !ids.some(id => special.has(id)));
  return (inputIds, logits) => {
    const ids = (Array.isArray(inputIds[0]) ? inputIds[0] : inputIds).map(Number), boosts = new Map();
    let max = -Infinity; for (const value of logits.data) max = Math.max(max, value);
    for (const sequence of sequences) {
      let matched = 0;
      for (let n = Math.min(ids.length, sequence.length - 1); n > 0; n--) {
        if (sequence.slice(0, n).every((token, i) => token === ids[ids.length - n + i])) { matched = n; break; }
      }
      const token = sequence[matched];
      if (logits.data[token] >= max - 3) boosts.set(token, Math.max(boosts.get(token) || 0, matched ? 1.2 : .6));
    }
    return boosts;
  };
}

// The installed Transformers.js accepts decoder_input_ids, but does not
// implement prompt_ids. Build Whisper's previous-text prefix explicitly and
// strip it from generated output; it must never appear as dictated speech.
export function whisperVocabularyPrompt(tokenizer, config, vocabulary, contextLength = 448) {
  // Match Whisper's previous-text allowance (half the text context minus
  // sot_prev). The remaining half is reserved for the spoken transcription.
  const tokenBudget = Math.max(0, Math.floor(contextLength / 2) - 1);
  const special = new Set(tokenizer.all_special_ids || []), ids = [], terms = [];
  if (!Number.isInteger(config.prev_sot_token_id)) return { prefix: null, terms, tokenBudget };
  for (const term of vocabulary) {
    const next = tokenizer.encode(' ' + term + '.', { add_special_tokens: false }).map(Number);
    if (!next.length || next.some(id => special.has(id)) || ids.length + next.length > tokenBudget) continue;
    ids.push(...next); terms.push(term);
    if (ids.length === tokenBudget) break;
  }
  return { prefix: ids.length ? [config.prev_sot_token_id, ...ids, config.decoder_start_token_id, config.no_timestamps_token_id] : null, terms, tokenBudget };
}
