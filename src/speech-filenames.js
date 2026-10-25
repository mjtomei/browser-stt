// Filename formatting is opt-in and runs after recognition/voting. Context
// supplies spelling, never permission to invent a name from unrelated speech.
const extensions = new Set('md markdown txt pdf json jsonl yaml yml toml ini cfg conf env lock log csv tsv xml html htm css scss js jsx mjs cjs ts tsx py ipynb sh bash zsh c h cpp hpp rs go java swift kt rb sql vue svelte onnx wasm zip tar gz bz2 rar 7z png jpg jpeg gif svg webp tif tiff bmp mp3 mp4 wav webm doc docx xls xlsx ppt pptx patch diff bat ps1'.split(' '));
const letterNames = { a: ['ay'], b: ['bee'], c: ['cee', 'see'], d: ['dee'], e: ['ee'], f: ['eff', 'ef'], g: ['gee'], h: ['aitch'], i: ['eye'], j: ['jay'], k: ['kay'], l: ['ell', 'el'], m: ['em'], n: ['en'], o: ['oh'], p: ['pee'], q: ['cue'], r: ['ar'], s: ['ess', 'es'], t: ['tee'], u: ['you'], v: ['vee'], w: ['double u'], x: ['ex'], y: ['why'], z: ['zee', 'zed'] };
const letterByName = new Map(Object.entries(letterNames).flatMap(([letter, names]) => names.map(name => [name, letter])));
const extensionNames = new Map([['markdown', 'md'], ['text', 'txt'], ['python', 'py'], ['javascript', 'js'], ['typescript', 'ts'], ['jason', 'json'], ['jay son', 'json']]);
const fold = value => value.normalize('NFKC').toLowerCase();
const basename = name => String(name).split(/[\\/]/).at(-1);
const parts = name => name.replace(/([a-z\d])([A-Z])/g, '$1 $2').replace(/([A-Z])([A-Z][a-z])/g, '$1 $2').match(/[\p{L}\p{N}]+/gu) || [];
const filename = name => name.length <= 180 && /[\p{L}\p{N}]/u.test(name) && /^\.?[\p{L}\p{N}_-][\p{L}\p{N}_. -]*\.[a-zA-Z][a-zA-Z\d]{0,11}$/u.test(name);

export function filenamesInText(value) {
  const text = String(value || '').slice(0, 100000).replace(/(?:https?:\/\/|www\.)[^\s`<>]+/gi, ' ');
  const found = [];
  // Quoted/code filenames may contain spaces or uncommon suffixes. Plain prose
  // needs a recognized extension so abbreviations/domains are not chat hints.
  for (const m of text.matchAll(/`([^`\n]+)`|"([^"\n]+)"|(?:[\p{L}\p{N}_-]+[\\/])*\.?[\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)+/gu)) {
    const quoted = m[1] ?? m[2], name = basename(quoted ?? m[0]);
    if (filename(name) && (quoted != null || extensions.has(fold(name.split('.').at(-1))))) found.push(name);
    else if (quoted != null) found.push(...filenamesInText(quoted));
  }
  return [...new Set(found)];
}

export function filenameVocabulary(filenames = []) {
  const hints = [];
  for (const name of [...new Set(filenames.map(basename))].filter(filename).slice(0, 24)) {
    const segments = name.split('.'), stem = parts(segments.shift()).join(' ').replace(/\breadme\b/gi, 'read me').replace(/\btodo\b/gi, 'to do').replace(/\bchangelog\b/gi, 'change log');
    const suffix = segments.map(s => s.length <= 4 ? [...s].join(' ') : s).join(' dot ');
    hints.push(`${stem} dot ${suffix}`, `${stem} dot ${segments.join(' dot ')}`);
  }
  return [...new Set(hints.filter(Boolean))];
}

function tokens(text) {
  return [...text.matchAll(/[\p{L}\p{N}]+|[._-]/gu)].map(m => ({ text: m[0], key: fold(m[0]), start: m.index, end: m.index + m[0].length }));
}
function extensionAt(words, at, allowed, text) {
  const matches = [];
  // Greedy longest spelling, e.g. p d f, P.D.F., pee dee eff, or pdf.
  let letters = '', phrase = '';
  for (let i = at; i < Math.min(words.length, at + 12); i++) {
    const w = words[i];
    if (i > at && /[^\s.]/u.test(text.slice(words[i - 1].end, w.start))) break;
    if (w.key === '.') { if (letters) continue; break; }
    if (!/^[a-z\d]+$/.test(w.key)) break;
    phrase += (phrase ? ' ' : '') + w.key;
    const named = extensionNames.get(phrase);
    if (allowed.has(w.key) && i === at) matches.push({ value: w.key, end: i });
    if (named && allowed.has(named)) matches.push({ value: named, end: i });
    let letter = w.key.length === 1 ? w.key : letterByName.get(w.key);
    if (w.key === 'double' && ['u', 'you'].includes(words[i + 1]?.key)
      && /^\s+$/.test(text.slice(w.end, words[i + 1].start))) { letter = 'w'; i++; }
    if (letter) letters += letter; else letters += '!';
    if (allowed.has(letters)) matches.push({ value: letters, end: i });
  }
  return matches.sort((a, b) => b.end - a.end)[0];
}

function knownNames(filenames) {
  return [...new Set(filenames.map(basename))].filter(filename).slice(0, 64).map(name => {
    const segments = name.split('.'), suffix = fold(segments.pop());
    const stem = segments.join('.');
    return { name, suffix, stem, key: parts(stem).map(fold).join('') };
  });
}
function stemKey(words, start, end, letters = false) {
  return words.slice(start, end).filter(w => !['-', '_', '.', 'hyphen', 'dash', 'underscore', 'dot'].includes(w.key))
    .map(w => letters ? letterByName.get(w.key) || w.key : w.key).join('');
}

function editsFor(text, filenames) {
  const words = tokens(text), known = knownNames(filenames), edits = [];
  for (let i = 1; i < words.length - 1; i++) {
    const dot = words[i];
    if (dot.key !== 'dot' && dot.key !== '.') continue;
    // A sentence stop is not a dictated dot. Existing joined filenames can
    // still recover their case from context; spaced periods are left alone.
    if (dot.key === '.' && (words[i - 1].end !== dot.start || dot.end !== words[i + 1].start)) continue;
    const allowed = new Set([...extensions, ...known.map(f => f.suffix)]);
    const ext = extensionAt(words, i + 1, allowed, text); if (!ext) continue;
    if (/[^\s]/u.test(text.slice(dot.end, words[i + 1].start))) continue;
    let start = i - 1, replacement;
    const candidates = [];
    for (const file of known.filter(f => f.suffix === ext.value)) {
      for (let j = i - 1; j >= Math.max(0, i - 24); j--) {
        if (/[^\p{L}\p{N}\s_.-]/u.test(text.slice(words[j].start, dot.start))) break;
        if ([stemKey(words, j, i), stemKey(words, j, i, true)].includes(file.key)) candidates.push({ start: j, file });
      }
    }
    candidates.sort((a, b) => a.start - b.start);
    const longest = candidates.filter(c => c.start === candidates[0]?.start);
    if (longest.length === 1) { start = longest[0].start; replacement = longest[0].file.name; }
    else {
      if (dot.key !== 'dot') continue;
      // Unknown names need an explicit spoken dot and a common extension.
      // Only explicit separators can extend the stem past the preceding word.
      if (!extensions.has(ext.value) || !/^[\p{L}\p{N}]+$/u.test(words[start].key)) continue;
      while (start >= 2 && ['hyphen', 'dash', 'underscore', 'dot', '-', '_', '.'].includes(words[start - 1].key)
        && /^[\p{L}\p{N}]+$/u.test(words[start - 2].key)
        && !/[^\s]/u.test(text.slice(words[start - 2].end, words[start - 1].start) + text.slice(words[start - 1].end, words[start].start))) start -= 2;
      const stem = words.slice(start, i).map(w => ({ hyphen: '-', dash: '-', underscore: '_', dot: '.' })[w.key] || w.text).join('');
      replacement = `${stem}.${ext.value}`;
    }
    if (edits.at(-1)?.end > words[start].start) continue;
    let end = ext.end;
    while (['dot', '.'].includes(words[end + 1]?.key)) {
      const joiner = words[end + 1], next = words[end + 2];
      if (!next || /[^\s]/u.test(text.slice(words[end].end, joiner.start) + text.slice(joiner.end, next.start))) break;
      if (joiner.key === '.' && (words[end].end !== joiner.start || joiner.end !== next.start)) break;
      const extra = extensionAt(words, end + 2, allowed, text); if (!extra) break;
      replacement += '.' + extra.value; end = extra.end;
    }
    const exact = known.filter(f => fold(f.name) === fold(replacement));
    if (exact.length === 1) replacement = exact[0].name;
    edits.push({ start: words[start].start, end: words[end].end, text: replacement });
    i = end;
  }
  return edits;
}

export function formatSpokenFilenames(result, filenames = []) {
  const text = String(result.text || ''), edits = editsFor(text, filenames);
  if (!edits.length) return result;
  let cursor = 0, formatted = ''; const words = []; const originals = result.words || [];
  for (const edit of edits) {
    const shift = formatted.length - cursor;
    words.push(...originals.filter(w => w.start >= cursor && w.end <= edit.start).map(w => ({ ...w, start: w.start + shift, end: w.end + shift })));
    formatted += text.slice(cursor, edit.start);
    const source = originals.filter(w => w.start < edit.end && w.end > edit.start);
    if (source.length) {
      const minimum = values => values.every(Number.isFinite) ? Math.min(...values) : null;
      const confidence = minimum(source.map(w => w.confidence));
      const flags = Object.fromEntries([...new Set(source.flatMap(w => Object.keys(w.flags || {})))].map(key => [key,
        source.some(w => w.flags?.[key] === false) ? false : source.every(w => w.flags?.[key] === true) ? true : null]));
      words.push({ start: formatted.length, end: formatted.length + edit.text.length, text: edit.text, confidence,
        confident: source.some(w => w.confident === false) ? false : source.every(w => w.confident === true) ? true : null, flags,
        scores: Object.fromEntries(['minimum', 'mean', 'geometricMean'].map(key => [key, minimum(source.map(w => w.scores ? w.scores[key] : w.confidence))])),
        tokens: source.flatMap(w => w.tokens || []), sources: source.flatMap(w => w.sources || []) });
    }
    formatted += edit.text; cursor = edit.end;
  }
  const shift = formatted.length - cursor;
  words.push(...originals.filter(w => w.start >= cursor).map(w => ({ ...w, start: w.start + shift, end: w.end + shift })));
  return { ...result, text: formatted + text.slice(cursor), ...(result.words ? { words } : {}) };
}
