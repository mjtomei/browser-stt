import { classifyWords } from './speech-confidence.js';
import { vocabularyWords } from './speech-vocabulary.js';
import { formatSpokenFilenames } from './speech-filenames.js';
const normalize = text => text.normalize('NFKC').toLowerCase().replaceAll('’', "'");
const lexical = text => [...text.matchAll(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)];
const abbreviations = new Set(['mr', 'mrs', 'ms', 'dr', 'st', 'prof', 'jr', 'sr', 'rev']);
function hintMatches(tokens, hints) {
  const matched = new Set();
  for (let i = 0; i < tokens.length; i++) for (const term of hints.get(tokens[i].key) || []) {
    if (term.every((key, j) => tokens[i + j]?.key === key)) for (let j = 0; j < term.length; j++) matched.add(i + j);
  }
  return tokens.map((word, i) => ({ ...word, hinted: matched.has(i) }));
}
function words(result) {
  const scored = new Map((result.words || []).map(w => [w.start, w]));
  const matches = lexical(result.text);
  return matches.map((m, i) => {
    // A formatted filename has one conservative score covering its parts.
    const score = scored.get(m.index) || (result.words || []).find(w => w.start < m.index && w.end >= m.index + m[0].length);
    const end = matches[i + 1]?.index ?? result.text.length;
    const separator = result.text.slice(m.index + m[0].length, end);
    return { key: normalize(m[0]), text: m[0], suffix: separator.trimEnd(),
      joinedNext: /^[._/-]$/.test(separator) && matches[i + 1] ? normalize(matches[i + 1][0]) : null,
      boundary: /^[.,!?;:…。！？、，；：]+(?:\s+|$)$/u.test(separator) && (i === matches.length - 1 || /\s$/u.test(separator))
        && !(separator.trim() === '.' && abbreviations.has(normalize(m[0])) && i < matches.length - 1),
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
export function voteSpeech(hypotheses, { final = false, confidence, vocabulary = [], filenames } = {}) {
  if (!hypotheses.length) return { text: '', words: [], models: [] };
  // Align equivalent filename spellings before voting: "agents dot em dee"
  // and "AGENTS.md" should support each other, not competing word fragments.
  if (filenames) hypotheses = hypotheses.map(h => formatSpokenFilenames(h, filenames));
  const hints = new Map();
  for (const value of vocabularyWords(vocabulary)) {
    const term = lexical(value).map(m => normalize(m[0]));
    if (term.length) hints.set(term[0], [...(hints.get(term[0]) || []), term]);
  }
  const inputs = hypotheses.map(h => ({ id: h.id, words: hintMatches(words(h), hints) }));
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
    let winner = [...sums].sort((a, b) => b[1] - a[1])[0];
    // A small contextual prior can break a close lexical disagreement. Never
    // manufacture a dictionary word, rescue a deletion, or count the boost as
    // acoustic certainty. Weak/unmeasured guesses receive no extra weight.
    if (winner?.[0] != null) {
      const ranked = new Map(sums);
      for (const v of column) if (v.hinted && v.measured && v.confidence >= .35) ranked.set(v.key, ranked.get(v.key) + v.confidence * .25);
      const key = [...ranked].sort((a, b) => b[1] - a[1])[0][0];
      winner = [key, sums.get(key)];
    }
    return { column, sums, winner, moonshine: column.find(v => v.id === 'moonshine') };
  });
  const agrees = i => decisions[i]?.winner?.[0] != null && decisions[i].moonshine?.key === decisions[i].winner[0];
  let text = '', joinedNext = null; const output = [];
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
    if (text && joinedNext !== winner[0]) text += ' ';
    const start = text.length; text += spelling.text; const end = text.length; text += suffix;
    joinedNext = spelling.joinedNext;
    const total = [...sums.values()].reduce((a, b) => a + b, 0);
    const acoustic = supporting.reduce((n, v) => n + v.confidence, 0) / supporting.length;
    const score = Math.min(acoustic, total ? winner[1] / total : 0);
    output.push({ start, end, text: spelling.text, confidence: score, tokens: spelling.original?.tokens || [],
      scores: { minimum: score, mean: score, geometricMean: score }, votes: supporting.length,
      sources: column.map(v => ({ model: v.id, word: v.key, confidence: v.measured ? v.confidence : null })) });
  }
  const result = { text, words: classifyWords(output, confidence), models: hypotheses.map(h => h.id) };
  return filenames ? formatSpokenFilenames(result, filenames) : result;
}
