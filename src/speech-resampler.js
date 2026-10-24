// Integrate samples across fractional input/output boundaries. Carries state
// across render quanta so 44.1/48 kHz input has no per-chunk rounding drift.
export class PcmResampler {
  constructor(rate, emit, frames = 1600) {
    this.ratio = rate / 16000; this.emit = emit; this.frames = frames;
    this.sum = this.weight = this.at = 0; this.output = new Int16Array(frames);
  }
  push(channels) {
    if (!channels.length) return;
    for (let i = 0; i < channels[0].length; i++) {
      let sample = 0; for (const channel of channels) sample += channel[i] / channels.length;
      let remaining = 1;
      while (remaining > 1e-9) {
        const part = Math.min(remaining, this.ratio - this.weight);
        this.sum += sample * part; this.weight += part; remaining -= part;
        if (this.weight >= this.ratio - 1e-9) {
          const value = Math.max(-1, Math.min(1, this.sum / this.weight));
          this.output[this.at++] = Math.round(value * (value < 0 ? 32768 : 32767));
          this.sum = this.weight = 0;
          if (this.at === this.frames) this.flush();
        }
      }
    }
  }
  flush() {
    if (!this.at) return;
    const bytes = new Uint8Array(this.at * 2), view = new DataView(bytes.buffer);
    for (let i = 0; i < this.at; i++) view.setInt16(i * 2, this.output[i], true);
    this.at = 0; this.emit(bytes);
  }
}
