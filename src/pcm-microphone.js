export function pcmWave(chunks) {
  const length = chunks.reduce((n, chunk) => n + chunk.byteLength, 0);
  const data = new Uint8Array(44 + length); const view = new DataView(data.buffer);
  for (const [offset, text] of [[0, 'RIFF'], [8, 'WAVE'], [12, 'fmt '], [36, 'data']]) for (let i = 0; i < text.length; i++) data[offset + i] = text.charCodeAt(i);
  view.setUint32(4, 36 + length, true); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); view.setUint32(40, length, true);
  let at = 44; for (const chunk of chunks) { data.set(chunk, at); at += chunk.byteLength; }
  return new Blob([data], { type: 'audio/wav' });
}

// A receipt checks that every PCM chunk (including the final worklet flush)
// reached the stream without retaining the complete recording in memory.
export function pcmChecksum(bytes, hash = 2166136261) {
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
  return hash;
}

// A release/cancel can arrive while audioControl(true) is still pending.
// Always finish that call and then stop, without losing the paired release.
export class PcmMicrophone {
  constructor(control, onLimit = () => {}, onChunk = () => {}) { this.control = control; this.onLimit = onLimit; this.onChunk = onChunk; this.pending = null; this.capturing = false; }
  async start({ retainAudio = true } = {}) {
    if (this.pending || this.capturing) return false;
    this.chunks = []; this.bytes = 0; this.capturing = true; this.retainAudio = retainAudio;
    this.checksum = pcmChecksum(new Uint8Array());
    this.pending = Promise.resolve().then(() => this.control(true));
    try {
      if (!await this.pending) throw new Error('Microphone unavailable. Check microphone permissions.');
      return true;
    } catch (error) { this.capturing = false; throw error; }
    finally { this.pending = null; }
  }
  receive(bytes, bufferedTail = false) {
    if ((!this.capturing && !bufferedTail) || !(bytes instanceof Uint8Array)) return;
    const limit = this.retainAudio ? 60 * 32000 : Infinity;
    const count = Math.min(bytes.length - bytes.length % 2, limit - this.bytes);
    if (count > 0) {
      const chunk = bytes.slice(0, count);
      if (this.retainAudio) this.chunks.push(chunk);
      this.bytes += count; this.checksum = pcmChecksum(chunk, this.checksum);
      if (this.capturing || !this.retainAudio) this.onChunk(chunk);
    }
    if (this.bytes >= limit && this.capturing) { this.capturing = false; this.onLimit(); }
  }
  async stop() {
    if (this.stopping) return this.stopping;
    this.capturing = false;
    this.stopping = (async () => {
      try { if (this.pending) await this.pending; } catch {}
      try { await this.control(false); }
      finally { clearTimeout(this.timer); }
      const value = this.retainAudio !== false ? pcmWave(this.chunks || [])
        : { kind: 'pcm-stream', bytes: this.bytes, checksum: this.checksum, seconds: this.bytes / 32000 };
      this.chunks = []; this.bytes = 0;
      return value;
    })();
    try { return await this.stopping; } finally { this.stopping = null; }
  }
}
