// Align only a suffix of the previous window with a prefix of the new one.
// Scores are evidence, not calibrated probabilities. Never let a confident
// unmatched word decide where two recordings join.
const normal = text => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
function tokens(value) {
  return [...value.text.matchAll(/\S+/gu)].map(match => {
    const start = match.index, end = start + match[0].length;
    const words = (value.words || []).filter(w => w.start < end && w.end > start);
    const scores = words.map(w => w.confidence).filter(Number.isFinite);
    return { text: match[0], normal: normal(match[0]), words, start, end,
      confidence: scores.length === words.length && scores.length ? Math.min(...scores) : null };
  });
}
function assemble(parts) {
  let text = ''; const words = [];
  for (const part of parts) {
    if (text) text += ' ';
    const offset = text.length - part.start; text += part.text;
    words.push(...part.words.map(word => ({ ...word, start: word.start + offset, end: word.end + offset })));
  }
  return { text, words };
}
function retainDetectedPunctuation(old, fresh) {
  // Confidence selects words, not punctuation. A later window may add a comma
  // or sentence ending without changing the word's acoustic score. Restrict
  // this to identical lexical text; never copy apostrophes/decimal separators.
  const suffix = fresh.text.match(/[.,!?;:…。！？、，；：]+$/u)?.[0];
  if (!suffix || /[.,!?;:…。！？、，；：]$/u.test(old.text)
    || old.text.toLowerCase() !== fresh.text.slice(0, -suffix.length).toLowerCase()) return old;
  // The appended mark has no word score. Existing lexical spans stay intact.
  return { ...old, text: old.text + suffix, end: old.end + suffix.length };
}
export function mergeSpeechOverlap(previous, next) {
  const all = tokens(previous), a = all.slice(-192), b = tokens(next);
  if (a.length < 3 || b.length < 3 || b.length > 384) return null;
  const n = a.length, m = b.length, width = m + 1;
  const scores = new Int32Array((n + 1) * width), moves = new Uint8Array(scores.length);
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) {
    const at = i * width + j, equal = a[i - 1].normal && a[i - 1].normal === b[j - 1].normal;
    const diagonal = scores[at - width - 1] + (equal ? 3 : -2);
    const deletion = scores[at - width] - 3, insertion = scores[at - 1] - 3;
    scores[at] = Math.max(0, diagonal, deletion, insertion);
    moves[at] = scores[at] === 0 ? 0 : scores[at] === diagonal ? 1 : scores[at] === deletion ? 2 : 3;
  }
  const candidates = [];
  for (let end = 3; end <= m; end++) {
    let i = n, j = end; const pairs = [];
    while (j > 0) {
      const move = moves[i * width + j];
      if (!move) break;
      if (move === 1) pairs.push([--i, --j]);
      else if (move === 2) pairs.push([--i, -1]);
      else pairs.push([-1, --j]);
    }
    pairs.reverse();
    const matches = pairs.filter(([x, y]) => x >= 0 && y >= 0 && a[x].normal && a[x].normal === b[y].normal);
    if (matches.length < 3 || pairs.length - matches.length > matches.length / 2 || matches[0][1] > 32 || matches.at(-1)[0] < n - 3) continue;
    if (new Set(matches.map(([x]) => a[x].normal)).size < 2) continue;
    // Require a three-word anchor occurring exactly once on each side. A
    // repeated phrase is not evidence for which occurrence crosses the seam.
    let unique = false, ambiguous = false;
    for (let k = 2; k < matches.length; k++) {
      const [x, y] = matches[k];
      if (matches[k - 2][0] !== x - 2 || matches[k - 2][1] !== y - 2) continue;
      const key = a.slice(x - 2, x + 1).map(t => t.normal).join(' ');
      const count = ts => ts.slice(2).filter((_, at) => ts.slice(at, at + 3).map(t => t.normal).join(' ') === key).length;
      if (count(a) === 1 && count(b) === 1) unique = true; else ambiguous = true;
    }
    if (!unique || ambiguous) continue;
    candidates.push({ pairs, start: i, end, score: scores[n * width + end], matches });
  }
  candidates.sort((x, y) => y.score - x.score);
  const best = candidates[0];
  if (!best || candidates[1]?.score === best.score) return null;
  const parts = all.slice(0, all.length - a.length + best.start);
  const overlapStart = parts.reduce((length, part) => length + part.text.length + 1, 0);
  const first = best.pairs.findIndex(([x, y]) => x >= 0 && y >= 0 && a[x].normal === b[y].normal);
  const last = best.pairs.findLastIndex(([x, y]) => x >= 0 && y >= 0 && a[x].normal === b[y].normal);
  for (let k = 0; k < best.pairs.length; k++) {
    const [x, y] = best.pairs[k], old = a[x], fresh = b[y];
    if (!old) {
      // Keep insertions only inside two matching anchors, never at a cut edge.
      if (k > first && k < last) parts.push(fresh);
    } else if (!fresh) parts.push(old); // do not delete a word on one model vote
    else {
      const oldCutEdge = x >= n - 2 && best.end < b.length;
      const anchored = old.normal === fresh.normal || k > first && (k < last || oldCutEdge);
      parts.push(anchored && fresh.confidence !== null && old.confidence !== null
        && fresh.confidence > old.confidence * (oldCutEdge ? .8 : 1) + .05 ? fresh : retainDetectedPunctuation(old, fresh));
    }
  }
  parts.push(...b.slice(best.end));
  return { ...assemble(parts), overlapStart };
}
