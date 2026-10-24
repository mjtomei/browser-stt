import { SpeechStream } from './speech-stream.js';
import { voteSpeech } from './ensemble-vote.js';

// One rolling stream per recognizer: there are no shifted-window votes. Each
// model gets the same recording and vocabulary and contributes one hypothesis.
export class EnsembleStream {
  constructor({ models, result, failure = () => {}, backlog = () => {}, confidence, streamOptions = {} }) {
    Object.assign(this, { models, result, failure, backlog, confidence, streamOptions }); this.active = false;
  }
  start(vocabulary = []) {
    this.cancel(); this.active = true; this.finishing = false; this.latest = null; this.error = null;
    this.vocabulary = vocabulary;
    this.epoch = new AbortController(); this.values = new Map(); this.errors = new Map(); this.streams = new Map();
    const epoch = this.epoch;
    for (const id of Object.keys(this.models.entries)) {
      const stream = new SpeechStream({ overlapSeconds: 7.5, firstAudioMs: this.streamOptions.minAudioMs ?? 250, firstIntervalMs: this.streamOptions.intervalMs ?? 0, ...this.streamOptions, confidence: this.confidence,
        prepare: this.models.prepare ? options => this.models.prepare(id, options) : undefined,
        transcribe: (audio, options) => this.models.transcribe(id, audio, options),
        result: value => { if (this.active && this.epoch === epoch) { this.values.set(id, value); this.publish(); } },
        failure: error => {
          if (!this.active || this.epoch !== epoch) return;
          this.errors.set(id, error); this.values.delete(id);
          if (this.errors.size === this.streams.size) { this.error = error; this.failure(error); }
        },
        backlog: () => {
          if (!this.active || this.epoch !== epoch) return;
          const caughtUp = [...this.streams].some(([other, candidate]) => other !== id && !this.errors.has(other) && candidate.completedEnd >= candidate.length - 15 * 32000);
          if (caughtUp) {
            // A downloading/overloaded panel member must not stop a recognizer
            // that is keeping up. It can rejoin on the next recording.
            this.errors.set(id, Error('Recognizer fell behind this recording.')); this.values.delete(id); stream.cancel(); this.publish();
          } else if (!this.backlogged) { this.backlogged = true; this.backlog(); }
        },
      });
      this.streams.set(id, stream); stream.start(vocabulary);
    }
    this.backlogged = false;
  }
  receive(bytes) {
    if (!this.active || this.finishing) return;
    for (const [id, stream] of this.streams) {
      if (this.errors.has(id)) continue;
      try { stream.receive(bytes); } catch (error) { this.errors.set(id, error); this.values.delete(id); }
    }
    if (this.errors.size === this.streams.size) throw this.error || [...this.errors.values()][0];
  }
  publish(final = false) {
    const hypotheses = [...this.streams.keys()].filter(id => this.values.has(id)).map(id => ({ id, ...this.values.get(id) }));
    if (!hypotheses.length) return null;
    const merged = voteSpeech(hypotheses, { final, confidence: this.confidence, vocabulary: this.vocabulary });
    if (!merged.text) return null;
    this.latest = { ...merged, backend: 'wasm', model: 'Conformer + Zipformer + Moonshine Base', partial: !final,
      seconds: Math.max(...hypotheses.map(h => h.seconds || 0)), transcribeMs: Math.max(...hypotheses.map(h => h.transcribeMs || 0)),
      unavailableModels: [...this.errors.keys()] };
    this.result(this.latest); return this.latest;
  }
  async finish(audio, { signal } = {}) {
    signal?.throwIfAborted(); const epoch = this.epoch;
    if (!this.active || !epoch || epoch.signal.aborted) throw new DOMException('Transcription cancelled.', 'AbortError');
    this.finishing = true;
    const cancel = () => { if (this.epoch === epoch) this.cancel(); };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      await Promise.all([...this.streams].map(async ([id, stream]) => {
        if (this.errors.has(id)) return;
        try { const value = await stream.finish(audio, { signal }); if (this.epoch === epoch) this.values.set(id, value); }
        catch (error) { if (this.epoch === epoch) { this.errors.set(id, error); this.values.delete(id); } }
      }));
      signal?.throwIfAborted(); if (!this.active || this.epoch !== epoch) throw new DOMException('Transcription cancelled.', 'AbortError');
      if (!this.values.size) throw this.error || [...this.errors.values()].find(e => !/No speech/.test(e.message)) || Error('No speech was recognized. Try again or type on the phone.');
      const result = this.publish(true); if (!result) throw Error('No speech was recognized. Try again or type on the phone.'); return result;
    } finally { signal?.removeEventListener('abort', cancel); if (this.epoch === epoch) this.cancel(); }
  }
  cancel() { this.active = false; this.finishing = false; this.epoch?.abort(); for (const stream of this.streams?.values() || []) stream.cancel(); }
}
