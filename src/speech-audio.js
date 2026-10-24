import { pcmWave } from './pcm-microphone.js';

export const SPEECH_RATE = 16000;
export const MAX_SPEECH_SECONDS = 60;

// Glasses audio is already PCM16/16 kHz/mono. Decode it without creating an
// AudioContext (which may require foreground user activation on iOS).
export function waveSamples(buffer) {
  const view = new DataView(buffer);
  const tag = at => at + 4 <= view.byteLength ? String.fromCharCode(...new Uint8Array(buffer, at, 4)) : '';
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Choose a WAV recording.');
  let format; let data;
  for (let at = 12; at + 8 <= view.byteLength;) {
    const size = view.getUint32(at + 4, true); const start = at + 8;
    if (start + size > view.byteLength) throw new Error('The WAV recording is incomplete.');
    if (tag(at) === 'fmt ' && size >= 16) format = { type: view.getUint16(start, true), channels: view.getUint16(start + 2, true), rate: view.getUint32(start + 4, true), bits: view.getUint16(start + 14, true) };
    if (tag(at) === 'data') data = { start, size };
    at = start + size + size % 2;
  }
  if (!format || !data || format.type !== 1 || format.channels !== 1 || format.bits !== 16 || format.rate !== SPEECH_RATE) throw new Error('Use a mono, 16 kHz, 16-bit PCM WAV recording.');
  if (data.size % 2 || data.size < 3200) throw new Error('No speech was recorded. Speak for at least a moment.');
  if (data.size > SPEECH_RATE * MAX_SPEECH_SECONDS * 2) throw new Error('Keep recordings to 60 seconds or less.');
  const samples = new Float32Array(data.size / 2);
  for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(data.start + i * 2, true) / 32768;
  return samples;
}

export function samplesWave(samples) {
  const bytes = new Uint8Array(samples.length * 2); const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, Math.round(Math.max(-1, Math.min(1, samples[i])) * (samples[i] < 0 ? 32768 : 32767)), true);
  return pcmWave([bytes]);
}

export async function normalizeRecording(blob, { truncate = false } = {}) {
  const buffer = await blob.arrayBuffer();
  // The glasses take this path, without any browser microphone/audio API.
  try { waveSamples(buffer); return blob; } catch {}
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(buffer);
    if (!truncate && decoded.duration > MAX_SPEECH_SECONDS) throw new Error('Keep recordings to 60 seconds or less.');
    const frames = Math.min(MAX_SPEECH_SECONDS * SPEECH_RATE, Math.ceil(decoded.duration * SPEECH_RATE));
    if (frames < 1600) throw new Error('The recording is too short.');
    const offline = new OfflineAudioContext(1, frames, SPEECH_RATE);
    const source = offline.createBufferSource(); source.buffer = decoded; source.connect(offline.destination); source.start();
    return samplesWave((await offline.startRendering()).getChannelData(0));
  } finally { await context.close(); }
}
