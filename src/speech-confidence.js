// Token softmax scores are model evidence, not calibrated correctness probabilities.
export const SPEECH_CONFIDENCE_THRESHOLD = 0.9;
export const DEFAULT_CONFIDENCE = Object.freeze({ metric: 'minimum', threshold: SPEECH_CONFIDENCE_THRESHOLD });
const metrics = ['minimum', 'mean', 'geometricMean'];
const wordMatches = text => [...text.matchAll(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)];
const probability = value => Number.isFinite(value) && value >= 0 && value <= 1;

export function confidenceOptions(options = {}) {
  const rule = ({ metric = 'minimum', threshold = SPEECH_CONFIDENCE_THRESHOLD } = {}) => {
    if (!metrics.includes(metric)) throw new TypeError('Confidence metric must be minimum, mean, or geometricMean.');
    if (!probability(threshold)) throw new RangeError('Confidence threshold must be between 0 and 1.');
    return { metric, threshold };
  };
  const rules = Object.fromEntries(Object.entries(options.rules || {}).map(([name, value]) => [name, rule(value)]));
  return { ...rule(options), rules };
}

// Can be reapplied to a saved result without rerunning inference. true means
// >= threshold; false means below threshold; null means evidence is unavailable.
export function classifyWords(words, options) {
  const config = confidenceOptions(options);
  return words.map(word => {
    const values = word.scores || { minimum: word.confidence };
    const decide = rule => probability(values[rule.metric]) ? values[rule.metric] >= rule.threshold : null;
    return { ...word, confidence: probability(values[config.metric]) ? values[config.metric] : null,
      confident: decide(config), flags: Object.fromEntries(Object.entries(config.rules).map(([name, rule]) => [name, decide(rule)])) };
  });
}

export function confidenceWords(text, scores, decode, options) {
  // Validate even if alignment fails or the utterance contains no words.
  confidenceOptions(options);
  const ids = [], spans = []; let decoded = '';
  for (const score of scores) {
    ids.push(score.token); const next = decode(ids);
    // Byte fallback can revise partial Unicode. Don't guess word offsets.
    if (!next.startsWith(decoded)) return [];
    spans.push({ start: decoded.length, end: next.length, ...score }); decoded = next;
  }
  const source = wordMatches(decoded), target = wordMatches(text);
  if (source.length !== target.length || source.some((word, i) => word[0] !== target[i][0])) return [];
  return classifyWords(target.map((word, i) => {
    const original = source[i];
    const tokens = spans.filter(span => span.start < original.index + original[0].length && span.end > original.index)
      .map(({ token, probability }) => ({ token, probability }));
    const valid = tokens.length && tokens.every(token => probability(token.probability));
    const probabilities = tokens.map(token => token.probability);
    const values = valid ? {
      minimum: Math.min(...probabilities),
      mean: probabilities.reduce((sum, value) => sum + value, 0) / probabilities.length,
      geometricMean: probabilities.includes(0) ? 0 : Math.exp(probabilities.reduce((sum, value) => sum + Math.log(value), 0) / probabilities.length),
    } : { minimum: null, mean: null, geometricMean: null };
    return { start: word.index, end: word.index + word[0].length, text: word[0], tokens, scores: values };
  }), options);
}

export function uncertainWords(text, words = [], threshold = SPEECH_CONFIDENCE_THRESHOLD) {
  return words.filter(word => Number.isInteger(word.start) && Number.isInteger(word.end) && word.start >= 0 && word.end > word.start && word.end <= text.length
    && probability(word.confidence) && word.confidence < threshold);
}
