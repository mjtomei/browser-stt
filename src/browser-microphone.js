import { PcmMicrophone } from './pcm-microphone.js';
import { safeTimeout, cancelTimeout } from './timers.js';

// Browser preview: capture PCM continuously, matching the glasses' chunk path.
export class BrowserMicrophone extends PcmMicrophone {
  constructor(onLimit, onChunk, { base = new URL('stt/', document.baseURI).href } = {}) {
    super(open => open ? this.openCapture() : this.closeCapture(), onLimit, onChunk);
    this.captureUrl = new URL('speech-capture-worklet.js', base).href;
  }
  async openCapture() {
    if (!navigator.mediaDevices?.getUserMedia || !globalThis.AudioWorkletNode) throw new Error('Microphone streaming requires HTTPS or localhost and Web Audio support.');
    try {
      this.context = new AudioContext(); await this.context.resume();
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      await this.context.audioWorklet.addModule(this.captureUrl);
      this.node = new AudioWorkletNode(this.context, 'browser-stt-capture');
      this.node.port.onmessage = ({ data }) => { if (data.bytes) this.receive(data.bytes, this.flushing); if (data.stopped) this.flushed?.(); };
      this.source = this.context.createMediaStreamSource(this.stream);
      this.source.connect(this.node); this.node.connect(this.context.destination); // Worklet outputs silence.
      return true;
    } catch (error) { await this.closeCapture(); throw error; }
  }
  async closeCapture() {
    try {
      if (this.node && this.context?.state === 'running') {
        this.flushing = true;
        await new Promise(resolve => {
          const timer = safeTimeout(resolve, 300);
          this.flushed = () => { cancelTimeout(timer); resolve(); };
          this.node.port.postMessage('stop');
        });
      }
    } finally {
      this.flushing = false; this.flushed = null; this.node?.disconnect(); this.source?.disconnect();
      this.stream?.getTracks().forEach(track => track.stop()); this.stream = this.node = this.source = null;
      await this.context?.close(); this.context = null;
    }
    return true;
  }
}
