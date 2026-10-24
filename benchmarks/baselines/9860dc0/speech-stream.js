import { pcmWave, pcmChecksum } from './pcm-microphone.js';
import { waveSamples } from './speech-audio.js';
import { mergeSpeechOverlap } from './speech-overlap.js';
import { safeTimeout, cancelTimeout } from './timers.js';
import { speechWindowSeconds } from './speech-window.js';

const RATE = 32000; // PCM16 bytes per second
const MAX_PENDING = 120 * RATE;

// Commit a natural pause only after the complete phrase has been decoded.
function phraseEnd(view, start, end, completedEnd) {
  const frame = 640;
  let peak = 0, quiet = 0, heard = false;
  for (let at = start; at < end; at += frame) {
    const size = Math.min(frame, end - at);
    let energy = 0;
    for (let i = at; i < at + size; i += 2) energy += view.getInt16(i, true) ** 2;
    const rms = Math.sqrt(energy / (size / 2)) / 32768;
    peak = Math.max(peak, rms);
    const floor = Math.max(.0005, Math.min(.006, peak * .04));
    if (rms > floor) {
      if (quiet >= RATE * .4 && at - start >= RATE && at >= completedEnd) return at;
      heard = true; quiet = 0;
    } else if (heard) quiet += size;
  }
  return quiet >= RATE * .4 && end - start >= RATE && end >= completedEnd ? end : 0;
}
function append(prefix, value) {
  const text = String(value?.text || '').trim();
  if (!text) return { text: prefix.text, words: prefix.words };
  const offset = prefix.text ? prefix.text.length + 1 : 0;
  return { text: (prefix.text ? prefix.text + ' ' : '') + text,
    words: [...prefix.words, ...(value.words || []).map(word => ({ ...word, start: offset + word.start, end: offset + word.end }))] };
}

// One growing-window decode at a time. Audio positions are absolute, while
// storage rolls only after a completed full-window pass. Overlap is optional
// for existing consumers; Pageborne enables half-window overlap.
export class SpeechStream {
  constructor({ transcribe, result, failure = () => {}, backlog = () => {}, intervalMs = 100, minAudioMs = 500, overlapSeconds = 0, windowSeconds = 15, commitOnPause = true, confidence }) {
    this.windowSeconds = speechWindowSeconds(windowSeconds);
    this.windowBytes = Math.round(this.windowSeconds * RATE / 2) * 2;
    Object.assign(this, { transcribe, result, failure, backlog, intervalMs, confidence, commitOnPause }); this.active = false;
    this.minAudioBytes = RATE * Math.max(100, Math.min(15000, Number(minAudioMs) || 500)) / 1000;
    this.overlapBytes = Math.round(Math.max(0, Math.min(this.windowSeconds / 2, Number(overlapSeconds) || 0)) * RATE / 2) * 2;
  }
  start(vocabulary = []) {
    this.cancel(); this.active = true; this.vocabulary = vocabulary;
    this.bytes = new Uint8Array(30 * RATE); this.base = this.length = this.offset = this.lastEnd = 0;
    this.checksum = pcmChecksum(new Uint8Array()); this.backlogged = false;
    this.committed = ''; this.words = []; this.job = null; this.overlap = null;
    this.epoch = new AbortController(); this.finishing = false; this.completedEnd = 0;
    this.visible = ''; this.latest = null; this.windowResult = null; this.error = null; this.transcribeMs = 0;
  }
  receive(bytes) {
    if (!this.active || this.finishing) return;
    const count = bytes.length - bytes.length % 2;
    const needed = this.length - this.base + count;
    // An overloaded recognizer must fail explicitly, never silently drop PCM.
    if (needed > MAX_PENDING) {
      const error = this.error = new Error('Speech recognition fell too far behind. Stop recording and retry after the model is ready.');
      this.cancel(); this.failure(error); throw error;
    }
    if (needed > this.bytes.length) {
      const grown = new Uint8Array(Math.min(MAX_PENDING, Math.max(needed, this.bytes.length * 2)));
      grown.set(this.bytes.subarray(0, this.length - this.base)); this.bytes = grown;
    }
    const chunk = bytes.subarray(0, count);
    this.bytes.set(chunk, this.length - this.base); this.length += count;
    this.checksum = pcmChecksum(chunk, this.checksum);
    this.schedule();
    if (this.length - this.completedEnd >= 60 * RATE && !this.backlogged) { this.backlogged = true; this.backlog(); }
  }
  schedule() {
    if (!this.active || this.finishing || this.job || this.timer || this.length - this.lastEnd < this.minAudioBytes) return;
    this.timer = safeTimeout(() => { this.timer = null; void this.run(); }, this.intervalMs);
  }
  audio(start, end) {
    const bytes = this.bytes.slice(start - this.base, end - this.base);
    const padded = new Uint8Array(Math.max(3200, bytes.length)); padded.set(bytes);
    return pcmWave([padded]);
  }
  run(final = false) {
    if (this.job) return this.job.done;
    if (!this.active || this.length <= this.completedEnd || this.length - this.offset < (final ? 1 : this.minAudioBytes)) return;
    let end = Math.min(this.length, this.offset + this.windowBytes);
    const view = new DataView(this.bytes.buffer);
    const pause = this.commitOnPause && phraseEnd(view, this.offset - this.base, end - this.base, this.completedEnd - this.base);
    const commit = !!pause || end - this.offset >= this.windowBytes;
    if (pause) end = pause + this.base;
    if (commit && !pause && !this.overlapBytes) {
      let lowest = Infinity;
      for (let at = end - 2 * RATE; at < this.offset + this.windowBytes; at += 3200) {
        if (at + 1600 < this.completedEnd) continue;
        let energy = 0; for (let i = at; i < at + 3200; i += 2) energy += view.getInt16(i - this.base, true) ** 2;
        if (energy < lowest) { lowest = energy; end = at + 1600; }
      }
    }
    this.lastEnd = end;
    const job = this.job = new AbortController();
    job.done = this.decode(job, end, commit, !pause, final);
    return job.done;
  }
  combine(value) {
    if (!this.overlap) return { ...append({ text: this.committed, words: this.words }, value), windowStart: this.committed ? this.committed.length + 1 : 0 };
    // Only the preceding acoustic window can overlap. Earlier occurrences of
    // the same sentence elsewhere in a long recording are unrelated evidence.
    const start = this.overlap.textStart;
    const previous = { text: this.committed.slice(start), words: this.words.filter(w => w.start >= start).map(w => ({ ...w, start: w.start - start, end: w.end - start })) };
    const merged = mergeSpeechOverlap(previous, value);
    if (!merged) return null;
    const prefix = { text: this.committed.slice(0, start).trimEnd(), words: this.words.filter(w => w.end <= start) };
    return { ...append(prefix, merged), windowStart: start + merged.overlapStart };
  }
  advance(end, forced, merged) {
    const allowOverlap = !!merged?.text;
    this.offset = forced && allowOverlap ? end - this.overlapBytes : end;
    this.overlap = this.offset < end ? { end, textStart: merged.windowStart || 0 } : null;
    this.bytes.copyWithin(0, this.offset - this.base, this.length - this.base);
    this.base = this.offset; this.windowResult = null;
  }
  async decode(job, end, commit, forced, final) {
    const live = () => this.active && this.job === job;
    const prefix = { text: this.committed, words: this.words };
    try {
      const options = { signal: job.signal, vocabulary: this.vocabulary, partial: !final, chunkSeconds: this.windowSeconds,
        ...(this.confidence ? { confidence: this.confidence } : {}) };
      let response;
      try {
        response = await this.transcribe(this.audio(this.offset, end), { ...options, onPartial: value => {
          if (!live()) return;
          const merged = this.combine(value);
          if (!merged?.text || merged.text.length <= this.visible.length) return;
          this.visible = merged.text; this.result({ ...value, ...merged, partial: true });
        } });
      } catch (error) {
        if (!/silent|No speech/.test(error.message)) throw error;
        response = { text: '', words: [] };
      }
      if (!live()) return;
      this.transcribeMs += response.transcribeMs || 0;
      let merged = response.text?.trim() ? this.combine(response) : null;
      if (!merged && this.overlap) {
        // An ambiguous/missing anchor cannot justify a text splice. Recognize
        // only newly captured audio with the previous transcript left intact.
        // No PCM is discarded until this pass has completed as well.
        try { response = await this.transcribe(this.audio(this.overlap.end, end), options); }
        catch (error) { if (!/silent|No speech/.test(error.message)) throw error; response = { text: '', words: [] }; }
        if (!live()) return;
        this.transcribeMs += response.transcribeMs || 0;
        if (response.text?.trim()) merged = { ...append(prefix, response), windowStart: prefix.text ? prefix.text.length + 1 : 0 };
      }
      merged ||= this.windowResult;
      this.completedEnd = end;
      if (merged?.text) {
        this.windowResult = merged;
        this.latest = { ...response, ...merged, seconds: end / RATE, transcribeMs: this.transcribeMs };
      }
      if (commit) {
        if (merged?.text) { this.committed = merged.text; this.words = merged.words; }
        this.advance(end, forced, merged);
      }
      if (merged?.text) { this.visible = this.latest.text; this.result(this.latest); }
    } catch (error) {
      if (live() && error.name !== 'AbortError') { this.error = error; this.cancel(); this.failure(error); }
    } finally {
      if (this.job === job) { this.job = null; this.schedule(); }
    }
  }
  async finish(audio, { signal } = {}) {
    const epoch = this.epoch;
    const check = () => {
      signal?.throwIfAborted();
      if (this.error && this.epoch === epoch) throw this.error;
      if (!epoch || epoch.signal.aborted || this.epoch !== epoch) throw new DOMException('Transcription cancelled.', 'AbortError');
    };
    if (signal?.aborted) { this.cancel(); signal.throwIfAborted(); }
    check(); this.finishing = true; cancelTimeout(this.timer); this.timer = null;
    const abort = () => { if (this.epoch === epoch) this.cancel(); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      if (audio?.kind === 'pcm-stream') {
        if (audio.bytes !== this.length || audio.checksum !== this.checksum) throw new Error('Finish with the same recording passed to receive().');
      } else {
        // Legacy whole-WAV callers can flush a tail here. A stream-only mic
        // delivers its final worklet chunks before returning a checked receipt.
        const samples = waveSamples(await audio.arrayBuffer()); check();
        const bytes = new Uint8Array(samples.length * 2), view = new DataView(bytes.buffer);
        for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, samples[i] * 32768, true);
        if (bytes.length < this.length || pcmChecksum(bytes.subarray(0, this.length)) !== this.checksum) throw new Error('Finish with the same recording passed to receive().');
        this.finishing = false; this.receive(bytes.subarray(this.length)); this.finishing = true;
        cancelTimeout(this.timer); this.timer = null;
      }
      if (this.job) await this.job.done;
      check();
      while (this.completedEnd < this.length) { await this.run(true); check(); }
      if (!this.latest?.text) throw new Error('No speech was recognized. Try again or type on the phone.');
      return { ...this.latest, seconds: this.length / RATE, partial: false };
    } finally {
      signal?.removeEventListener('abort', abort);
      if (this.epoch === epoch) this.cancel();
    }
  }
  cancel() {
    this.active = false; cancelTimeout(this.timer); this.timer = null;
    this.epoch?.abort(); this.job?.abort(); this.job = null; this.bytes = null;
  }
}
