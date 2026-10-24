import { confidenceWords } from './speech-confidence.js';

const logadd = (a, b) => a === -Infinity ? b : b === -Infinity ? a : Math.max(a, b) + Math.log1p(Math.exp(-Math.abs(a - b)));
export function tokenTable(text) {
  const tokens = [];
  for (const line of text.trim().split('\n')) { const at = line.lastIndexOf(' '); tokens[Number(line.slice(at + 1))] = line.slice(0, at); }
  return tokens;
}
export function piecesResult(pieces, options) {
  const decode = ids => ids.map(id => pieces[id].text).join('');
  const text = decode(pieces.map((_, i) => i)).trim();
  const scores = pieces.map((piece, token) => ({ token, probability: piece.probability }));
  return { text, words: confidenceWords(text, scores, decode, options) };
}

// Contextual prefix beam search. Hint scores affect path selection only; exposed
// confidence remains the original acoustic posterior. No reference text or LM.
export function decodeCtc(logs, frames, tokens, vocabulary = [], options) {
  const width = logs.length / frames, blank = width - 1;
  const hints = [...new Set(vocabulary.map(s => String(s).toLowerCase().trim()).filter(Boolean))];
  const hintScore = ids => {
    if (!hints.length) return 0;
    const text = ids.map(id => tokens[id]?.replaceAll('▁', ' ') || '').join('').toLowerCase().trimStart();
    let completed = 0, partial = 0;
    for (const term of hints) {
      // Reward completed terms; a prefix provides a small search aid, removed
      // when it stops matching. Bound strength so hints cannot dictate speech.
      let at = text.indexOf(term);
      while (at >= 0) {
        if ((at === 0 || text[at - 1] === ' ') && (at + term.length === text.length || text[at + term.length] === ' ')) completed += 1.5;
        at = text.indexOf(term, at + term.length);
      }
      const tail = text.slice(text.lastIndexOf(' ') + 1);
      if (tail && term.startsWith(tail)) partial = Math.max(partial, .5 * tail.length / term.length);
    }
    return completed + partial;
  };
  let selected;
  if (!hints.length) {
    selected = []; let last = -1;
    for (let t = 0; t < frames; t++) {
      let id = 0; for (let j = 1; j < width; j++) if (logs[t * width + j] > logs[t * width + id]) id = j;
      const probability = Math.exp(Math.min(0, logs[t * width + id]));
      if (id !== blank) {
        if (id === last) selected.at(-1).probability = Math.max(selected.at(-1).probability, probability);
        else selected.push({ id, probability });
      }
      last = id;
    }
  } else {
    let beams = [{ ids: [], pb: 0, pnb: -Infinity, score: 0 }];
    for (let t = 0; t < frames; t++) {
      const row = logs.subarray(t * width, (t + 1) * width);
      const candidates = Array.from({ length: width }, (_, id) => id).sort((a, b) => row[b] - row[a]).slice(0, 16);
      if (!candidates.includes(blank)) candidates.push(blank);
      const next = new Map();
      const get = ids => {
        const key = ids.join(',');
        if (!next.has(key)) next.set(key, { ids, pb: -Infinity, pnb: -Infinity, score: hintScore(ids) });
        return next.get(key);
      };
      for (const beam of beams) {
        const total = logadd(beam.pb, beam.pnb), same = get(beam.ids);
        same.pb = logadd(same.pb, total + row[blank]);
        for (const id of candidates) {
          if (id === blank) continue;
          if (id === beam.ids.at(-1)) same.pnb = logadd(same.pnb, beam.pnb + row[id]);
          const expanded = get([...beam.ids, id]);
          expanded.pnb = logadd(expanded.pnb, (id === beam.ids.at(-1) ? beam.pb : total) + row[id]);
        }
      }
      beams = [...next.values()].sort((a, b) => (logadd(b.pb, b.pnb) + b.score) - (logadd(a.pb, a.pnb) + a.score)).slice(0, 8);
    }
    const ids = beams[0].ids;
    // Forced CTC alignment to recover scores without including contextual boosts.
    const states = [blank]; for (const id of ids) states.push(id, blank);
    const n = states.length, back = new Uint8Array(frames * n);
    let prev = new Float64Array(n).fill(-Infinity); prev[0] = 0;
    for (let t = 0; t < frames; t++) {
      const next = new Float64Array(n).fill(-Infinity);
      for (let s = 0; s < n; s++) {
        let best = prev[s], step = 0;
        if (s > 0 && prev[s - 1] > best) { best = prev[s - 1]; step = 1; }
        if (s > 1 && states[s] !== blank && states[s] !== states[s - 2] && prev[s - 2] > best) { best = prev[s - 2]; step = 2; }
        next[s] = best + logs[t * width + states[s]]; back[t * n + s] = step;
      }
      prev = next;
    }
    let s = n > 1 && prev[n - 2] > prev[n - 1] ? n - 2 : n - 1;
    selected = ids.map(id => ({ id, probability: 0 }));
    for (let t = frames - 1; t >= 0; t--) {
      if (s % 2) selected[(s - 1) / 2].probability = Math.max(selected[(s - 1) / 2].probability, Math.exp(Math.min(0, logs[t * width + states[s]])));
      s -= back[t * n + s];
    }
  }
  return piecesResult(selected.map(p => ({ text: (tokens[p.id] || '').replaceAll('▁', ' '), probability: p.probability })), options);
}
