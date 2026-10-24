import { pcmWave } from './pcm-microphone.js';
import { waveSamples } from './speech-audio.js';
import { safeTimeout, cancelTimeout } from './timers.js';

const RATE = 32000; // PCM16 bytes per second

// Finish a phrase after a sustained quiet pause, before a later sentence can
// replace it in a fresh decode of the growing window. Use short RMS frames and
// a conservative relative floor; low energy alone is not a speech detector.
function phraseEnd(view, start, end, completedEnd) {
  const frame = 640; // 20 ms
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
  // Include all available trailing quiet PCM instead of decoding it again as
  // a tiny extra tail after release.
  return quiet >= RATE * .4 && end - start >= RATE && end >= completedEnd ? end : 0;
}

// A provisional transcript of a growing, bounded audio window. Keep just one
// inference in flight and coalesce new audio instead of queuing work per frame.
// Release drains the unfinished window, preserving completed work. Tiny does
// not expose decoder state, so an unfinished window may need another pass.
export class SpeechStream {
  constructor({ transcribe, result, failure = () => {}, intervalMs = 100, minAudioMs = 500, confidence }) {
    Object.assign(this, { transcribe, result, failure, intervalMs, confidence }); this.active = false;
    this.minAudioBytes = RATE * Math.max(100, Math.min(15000, Number(minAudioMs) || 500)) / 1000;
  }
  start(vocabulary = []) {
    this.cancel(); this.active = true; this.vocabulary = vocabulary;
    this.bytes = new Uint8Array(60 * RATE); this.length = this.offset = this.lastEnd = 0;
    this.committed = ''; this.words = []; this.job = null;
    this.epoch = new AbortController(); this.finishing = false; this.completedEnd = 0;
    this.visible = ''; this.latest = null; this.windowResult = null; this.error = null; this.transcribeMs = 0;
  }
  receive(bytes) {
    if (!this.active || this.finishing) return;
    const count = Math.min(bytes.length - bytes.length % 2, this.bytes.length - this.length);
    this.bytes.set(bytes.subarray(0, count), this.length); this.length += count;
    this.schedule();
  }
  schedule() {
    if (!this.active || this.finishing || this.job || this.timer || this.length - this.lastEnd < this.minAudioBytes) return;
    this.timer = safeTimeout(() => { this.timer = null; void this.run(); }, this.intervalMs);
  }
  run(final = false) {
    if (this.job) return this.job.done;
    if (!this.active || this.length - this.offset < (final ? 1 : this.minAudioBytes)) return;
    let end = Math.min(this.length, this.offset + 15 * RATE);
    const view = new DataView(this.bytes.buffer);
    const pause = phraseEnd(view, this.offset, end, this.completedEnd);
    const commit = !!pause || end - this.offset >= 15 * RATE;
    if (pause) end = pause;
    // A low-energy boundary avoids splitting words when advancing the window.
    if (commit && !pause) {
      let lowest = Infinity;
      for (let at = end - 2 * RATE; at < this.offset + 15 * RATE; at += 3200) {
        // Never replace a draft with an earlier slice of the same recording.
        if (at + 1600 < this.completedEnd) continue;
        let energy = 0; for (let i = at; i < at + 3200; i += 2) energy += view.getInt16(i, true) ** 2;
        if (energy < lowest) { lowest = energy; end = at + 1600; }
      }
    }
    this.lastEnd = end;
    // A final tail under 100 ms still needs to be accounted for. Pad only that
    // tail to the recognizer's minimum input size; never drop captured samples.
    const bytes = this.bytes.slice(this.offset, end);
    const padded = new Uint8Array(Math.max(3200, bytes.length)); padded.set(bytes);
    const audio = pcmWave([padded]);
    const job = this.job = new AbortController();
    job.done = this.decode(job, audio, end, commit, final);
    return job.done;
  }
  async decode(job, audio, end, commit, final) {
    try {
      const response = await this.transcribe(audio, { signal: job.signal, vocabulary: this.vocabulary, partial: !final, onPartial: response => {
        if (!this.active || this.job !== job) return;
        const prefix = this.committed ? this.committed + ' ' : '';
        const text = prefix + String(response.text || '').trim();
        // Re-decoding starts at the window's beginning. Do not erase the live
        // tail word by word while that pass catches up with the prior draft.
        if (!text.trim() || text.length <= this.visible.length) return;
        const words = [...this.words, ...(response.words || []).map(word => ({ ...word, start: prefix.length + word.start, end: prefix.length + word.end }))];
        this.visible = text; this.result({ ...response, text, words, partial: true });
      }, ...(this.confidence ? { confidence: this.confidence } : {}) });
      if (!this.active || this.job !== job) return;
      // An empty/silent re-decode must not erase a usable draft when this
      // window advances. This fallback belongs only to the current window.
      const value = String(response.text || '').trim() ? response : this.windowResult;
      const part = String(value?.text || '').trim();
      const prefix = this.committed ? this.committed + ' ' : '';
      const words = [...this.words, ...(value?.words || []).map(word => ({ ...word, start: prefix.length + word.start, end: prefix.length + word.end }))];
      this.completedEnd = end; this.transcribeMs += response.transcribeMs || 0;
      if (part) {
        this.windowResult = value;
        this.latest = { ...value, text: prefix + part, words, seconds: end / RATE, transcribeMs: this.transcribeMs };
      }
      if (commit) { if (part) { this.committed = prefix + part; this.words = words; } this.offset = end; this.windowResult = null; }
      if (part) { this.visible = this.latest.text; this.result(this.latest); }
    } catch (error) {
      if (this.active && this.job === job && error.name !== 'AbortError') {
        // Silence is ordinary while listening. On other failures, stop this
        // stream; the caller can keep the last usable draft for review.
        if (!/silent|No speech/.test(error.message)) { this.error = error; this.failure(error); this.cancel(); return; }
        this.completedEnd = end;
        if (commit) {
          if (this.windowResult) {
            // latest already contains the committed prefix and global offsets.
            this.committed = this.latest.text; this.words = this.latest.words;
          }
          this.offset = end; this.windowResult = null;
        }
      }
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
      // stop() can flush PCM that did not arrive through receive(). Reconcile
      // against the complete recording, without changing already decoded PCM.
      const samples = waveSamples(await audio.arrayBuffer()); check();
      const bytes = new Uint8Array(samples.length * 2), view = new DataView(bytes.buffer);
      for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, samples[i] * 32768, true);
      if (bytes.length < this.length || this.bytes.subarray(0, this.length).some((value, i) => value !== bytes[i])) throw new Error('Finish with the same recording passed to receive().');
      this.bytes.set(bytes); this.length = bytes.length;
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
    this.epoch?.abort();
    this.job?.abort(); this.job = null; this.bytes = null;
  }
}
