import { waveSamples } from './speech-audio.js';
import { safeTimeout, cancelTimeout } from './timers.js';

// Borrows the same microphone as Ask, so native audioControl calls and browser
// permission requests cannot overlap with a second independent recorder.
export class SpeechRecording {
  constructor(microphone, changed = () => {}) { Object.assign(this, { microphone, changed }); }
  get active() { return !!this.capture; }
  stop() {
    const capture = this.capture;
    if (!capture) return;
    capture.stopped = true; capture.finish();
    if (capture.started && !capture.stopping) {
      capture.stopping = capture.mic.stop();
      // A permission request may still be pending; consume rejection immediately.
      capture.stopping.catch(() => {});
    }
  }
  chunk() {
    const capture = this.capture;
    if (capture && !capture.stopped) capture.progress(`Recording · ${(capture.mic.bytes / 32000).toFixed(1)}s / 60s. Tap Stop recording when finished.`);
  }
  async start(signal, progress) {
    signal.throwIfAborted();
    if (this.capture) throw new Error('The previous recording is still stopping.');
    const capture = { mic: this.microphone(), progress };
    capture.finished = new Promise(resolve => { capture.finish = resolve; });
    this.capture = capture; this.changed();
    const abort = () => this.stop();
    signal.addEventListener('abort', abort, { once: true });
    try {
      if (capture.mic.stopping) await capture.mic.stopping;
      signal.throwIfAborted();
      if (capture.stopped) throw new DOMException('Cancelled', 'AbortError');
      progress('Opening microphone…'); capture.started = true;
      await capture.mic.start(); signal.throwIfAborted();
      if (!capture.stopped) {
        progress('Recording · read the passage below, then tap Stop recording.');
        capture.timer = safeTimeout(() => this.stop(), 60000);
      }
      await capture.finished; this.stop();
      const audio = await capture.stopping; signal.throwIfAborted();
      waveSamples(await audio.arrayBuffer()); signal.throwIfAborted();
      return audio;
    } finally {
      cancelTimeout(capture.timer); signal.removeEventListener('abort', abort);
      this.stop();
      try { await capture.stopping; } catch {}
      if (this.capture === capture) { this.capture = null; this.changed(); }
    }
  }
}
