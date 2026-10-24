// A review draft owns its refinement. Cancellation invalidates the result even
// if a worker/provider completes after abort; nothing here submits a question.
export class SpeechRefinement {
  constructor({ transcribe, current, replace, status, result = () => {}, failure = () => {} }) {
    Object.assign(this, { transcribe, current, replace, status, result, failure });
  }
  cancel() {
    const job = this.job; this.job = null; job?.abort.abort();
    if (job) this.status('');
  }
  async start(audio, original) {
    this.cancel();
    const job = this.job = { abort: new AbortController(), original };
    const active = () => this.job === job && !job.abort.signal.aborted && this.current() === original;
    this.status('Refining… You can send now.');
    try {
      const result = await this.transcribe(audio, job.abort.signal);
      if (!active()) return;
      this.result(result);
      const text = String(result.text || '').trim().slice(0, 4000);
      if (!text) { this.status('Kept first transcription.'); return; }
      if (text !== original) { this.replace(text, result); this.status('Transcription updated.'); }
      else this.status('Transcription checked.');
    } catch (error) {
      if (!active()) return;
      this.failure(error); this.status('Kept first transcription.');
    } finally { if (this.job === job) { this.job = null; this.finished?.(); } }
  }
}
