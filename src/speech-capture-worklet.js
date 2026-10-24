import { PcmResampler } from './speech-resampler.js';

class SpeechCapture extends AudioWorkletProcessor {
  constructor() {
    super(); this.stopped = false;
    this.resampler = new PcmResampler(sampleRate, bytes => this.port.postMessage({ bytes }, [bytes.buffer]));
    this.port.onmessage = ({ data }) => {
      if (data === 'stop') { this.stopped = true; this.resampler.flush(); this.port.postMessage({ stopped: true }); }
    };
  }
  process(inputs) {
    if (this.stopped) return false;
    this.resampler.push(inputs[0] || []); return true;
  }
}
registerProcessor('browser-stt-capture', SpeechCapture);
