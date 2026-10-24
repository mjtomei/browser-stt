import { classifyWords } from './speech-confidence.js';
const normalize = text => text.normalize('NFKC').toLowerCase().replaceAll('’', "'");
function words(result) {
  const scored = new Map((result.words || []).map(w => [w.start, w]));
  const matches = [...result.text.matchAll(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)];
  return matches.map((m, i) => {
    const score = scored.get(m.index), end = matches[i + 1]?.index ?? result.text.length;
    const separator = result.text.slice(m.index + m[0].length, end);
    return { key: normalize(m[0]), text: m[0], suffix: separator.trimEnd(),
      boundary: /^[.,!?;:…。！？、，；：]+(?:\s+|$)$/u.test(separator) && (i === matches.length - 1 || /\s$/u.test(separator)),
      confidence: Number.isFinite(score?.confidence) ? score.confidence : .5, measured: Number.isFinite(score?.confidence), original: score };
  });
}
// A band bounds both time and trace memory for long dictation. It includes the
// length difference, so a slower model's unrecognized tail is still alignable.
export function alignPanel(a, b, equal) {
  const n = a.length, m = b.length, band = Math.max(48, Math.abs(n - m) + 16), stride = band * 2 + 1;
  const trace = new Uint8Array((n + 1) * stride);
  let previous = new Float64Array(stride).fill(Infinity); for (let j = 0; j <= Math.min(m, band); j++) { previous[j + band] = j; trace[j + band] = 3; }
  for (let i = 1; i <= n; i++) {
    const next = new Float64Array(stride).fill(Infinity);
    for (let j = Math.max(0, i - band); j <= Math.min(m, i + band); j++) {
      const slot = j - i + band;
      const diagonal = j ? previous[slot] + Number(!equal(a[i - 1], b[j - 1])) : Infinity;
      const del = (previous[slot + 1] ?? Infinity) + 1, ins = j ? (next[slot - 1] ?? Infinity) + 1 : Infinity;
      next[slot] = Math.min(diagonal, del, ins); trace[i * stride + slot] = next[slot] === diagonal ? 1 : next[slot] === del ? 2 : 3;
    }
    previous = next;
  }
  let i = n, j = m; const pairs = [];
  while (i || j) {
    const move = trace[i * stride + j - i + band];
    if (move === 1) pairs.push([--i, --j]); else if (move === 2) pairs.push([--i, -1]); else if (move === 3) pairs.push([-1, --j]); else throw Error('Speech alignment failed.');
  }
  return pairs.reverse();
}
export function voteSpeech(hypotheses, { final = false, confidence } = {}) {
  if (!hypotheses.length) return { text: '', words: [], models: [] };
  const inputs = hypotheses.map(h => ({ id: h.id, words: words(h) }));
  // Equal old prefixes need no quadratic realignment on each partial result.
  let prefix = 0, limit = Math.max(0, Math.min(...inputs.map(h => h.words.length)) - 96);
  while (prefix < limit && inputs.every(h => h.words[prefix].key === inputs[0].words[prefix].key)) prefix++;
  const fixed = Array.from({ length: prefix }, (_, i) => inputs.map(h => ({ ...h.words[i], id: h.id })));
  let network = [], sources = [];
  for (const h of inputs) {
    const values = h.words.slice(prefix).map(w => ({ ...w, id: h.id }));
    const gap = id => ({ key: null, confidence: .5, measured: true, id });
    if (!sources.length) network = values.map(v => [v]);
    else {
      const pairs = alignPanel(network, values, (column, w) => column.some(v => v.key === w.key));
      const lastI = pairs.findLastIndex(([, j]) => j >= 0), lastJ = pairs.findLastIndex(([i]) => i >= 0);
      network = pairs.map(([i, j], k) => i < 0 ? [...(final || k <= lastJ ? sources.map(gap) : []), values[j]]
        : j < 0 ? [...network[i], ...(final || k <= lastI ? [gap(h.id)] : [])] : [...network[i], values[j]]);
    }
    sources.push(h.id);
  }
  const decisions = [...fixed, ...network].map(column => {
    const sums = new Map();
    for (const v of column) sums.set(v.key, (sums.get(v.key) || 0) + v.confidence);
    const winner = [...sums].sort((a, b) => b[1] - a[1])[0];
    return { column, sums, winner, moonshine: column.find(v => v.id === 'moonshine') };
  });
  const agrees = i => decisions[i]?.winner?.[0] != null && decisions[i].moonshine?.key === decisions[i].winner[0];
  let text = ''; const output = [];
  for (const [i, { column, sums, winner, moonshine }] of decisions.entries()) {
    if (!winner || winner[0] === null) continue;
    const supporting = column.filter(v => v.key === winner[0]);
    // Prefer the generative model's punctuation when it agrees on the word.
    const spelling = supporting.find(v => v.id === 'moonshine') || supporting[0];
    // A voted substitution need not erase the sentence boundary. Only borrow
    // simple punctuation with matching neighbours (two preceding words at EOF).
    // Keep gaps/lagging tails and numeric or other within-word separators out.
    const anchored = agrees(i - 1) && (agrees(i + 1) || i === decisions.length - 1 && agrees(i - 2));
    const suffix = !spelling.suffix && moonshine?.boundary && anchored ? moonshine.suffix : spelling.suffix;
    if (text) text += ' '; const start = text.length; text += spelling.text; const end = text.length; text += suffix;
    const total = [...sums.values()].reduce((a, b) => a + b, 0);
    const acoustic = supporting.reduce((n, v) => n + v.confidence, 0) / supporting.length;
    const score = Math.min(acoustic, total ? winner[1] / total : 0);
    output.push({ start, end, text: spelling.text, confidence: score, tokens: spelling.original?.tokens || [],
      scores: { minimum: score, mean: score, geometricMean: score }, votes: supporting.length,
      sources: column.map(v => ({ model: v.id, word: v.key, confidence: v.measured ? v.confidence : null })) });
  }
  return { text, words: classifyWords(output, confidence), models: hypotheses.map(h => h.id) };
}
