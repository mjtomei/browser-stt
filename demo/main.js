import { ResidentSpeech, BrowserMicrophone, SpeechRecording, SpeechStream, normalizeRecording, samplesWave, waveSamples, classifyWords, confidenceOptions } from '../src/index.js';
import { runSpeechBenchmark, noisySpeech } from '../src/speech-benchmark.js';
import samples from '../vendor/stt/benchmark-samples.json';

const $ = id => document.getElementById(id);
let job, audio, audioUrl, result, report;
const policy = () => confidenceOptions({ metric: $('metric').value, threshold: Number($('threshold').value) });
const progress = text => { $('progress').textContent = text; };
const models = new ResidentSpeech({ changed: () => {
  $('models').textContent = Object.entries(models.entries).map(([name, entry]) => `${name === 'fast' ? 'Tiny CPU' : 'Small GPU'}: ${entry.progress || entry.error?.message || entry.state}`).join(' · ');
} });
const stream = new SpeechStream({ transcribe: (blob, options) => models.transcribe('fast', blob, { ...options, confidence: policy() }), result: value => { result = value; render(); } });
const microphone = new BrowserMicrophone(() => recorder.stop(), chunk => { recorder.chunk(); stream.receive(chunk); });
const recorder = new SpeechRecording(() => microphone);
function busy(value) {
  for (const id of ['record', 'prepare', 'file', 'samples', 'refine']) $(id).disabled = value;
  for (const id of ['transcribe', 'compare']) $(id).disabled = value || !audio;
  $('cancel').disabled = !value; $('stop').disabled = !recorder.active;
}
async function task(run) {
  if (job) return;
  const current = job = new AbortController(); busy(true);
  try { await run(current.signal); }
  catch (error) { progress(error.name === 'AbortError' ? 'Cancelled.' : error.message); }
  finally { stream.cancel(); if (job === current) { job = null; busy(false); } }
}
function setAudio(blob) {
  if (audioUrl) URL.revokeObjectURL(audioUrl);
  audio = blob; audioUrl = URL.createObjectURL(blob); $('playback').src = audioUrl; $('playback').hidden = false; $('save-audio').disabled = false;
}
function render() {
  if (!result) return;
  const words = classifyWords(result.words || [], policy()), nodes = []; let offset = 0;
  for (const word of words) {
    nodes.push(document.createTextNode(result.text.slice(offset, word.start)));
    const span = document.createElement('span'); span.textContent = result.text.slice(word.start, word.end);
    if (word.confident === false) span.className = 'uncertain';
    span.title = JSON.stringify(word.scores); nodes.push(span); offset = word.end;
  }
  nodes.push(document.createTextNode(result.text.slice(offset))); $('words').replaceChildren(...nodes);
  $('output').textContent = JSON.stringify({ ...result, words }, null, 2);
}
async function transcribe(signal, streaming = false) {
  if (!streaming) stream.cancel();
  result = streaming ? await stream.finish(audio, { signal }) : await models.transcribe('fast', audio, { signal, progress, confidence: policy() }); render();
  progress(`Tiny draft ready in ${result.transcribeMs} ms.`);
  if ($('refine').checked) {
    try {
      const draft = result; const corrected = await models.transcribe('refine', audio, { signal, progress, confidence: policy() });
      result = { ...corrected, draft }; render(); progress(`Small correction ready in ${corrected.transcribeMs} ms.`);
    } catch (error) { signal.throwIfAborted(); progress(`Kept Tiny draft. ${error.message}`); }
  }
}
function save(blob, name) { const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 10000); }
$('prepare').onclick = () => task(async signal => { await models.open({ refine: $('refine').checked, retry: true }); signal.throwIfAborted(); progress('Preparation finished. See model status above.'); });
$('record').onclick = () => task(async signal => {
  void models.open({ refine: $('refine').checked }); stream.start();
  const recording = recorder.start(signal, progress); $('stop').disabled = false;
  const blob = await recording; signal.throwIfAborted(); setAudio(blob); await transcribe(signal, true);
});
$('stop').onclick = () => { recorder.stop(); $('stop').disabled = true; };
$('cancel').onclick = () => { stream.cancel(); job?.abort(); };
$('file').onchange = () => {
  const file = $('file').files[0]; $('file').value = '';
  if (file) void task(async signal => { progress('Reading audio…'); const blob = await normalizeRecording(file); signal.throwIfAborted(); setAudio(blob); progress('Ready to transcribe.'); });
};
$('transcribe').onclick = () => task(transcribe);
$('save-audio').onclick = () => save(audio, 'recording.wav');
for (const id of ['metric', 'threshold']) $(id).onchange = () => { try { policy(); render(); } catch (error) { progress(error.message); } };
async function benchmark(testSamples, signal) {
  report = await runSpeechBenchmark({ samples: testSamples, models, signal,
    progress,
    update: value => { $('summary').textContent = JSON.stringify(value.summary, null, 2); } });
  report.userAgent = navigator.userAgent; $('summary').textContent = JSON.stringify(report.summary, null, 2);
  $('save-report').disabled = false; progress('Benchmark complete.');
}
$('compare').onclick = () => task(signal => benchmark([{ id: 'recording', label: 'Recorded audio', reference: $('reference').value, audio: async () => audio }], signal));
$('samples').onclick = () => task(signal => benchmark(samples.flatMap(sample => [false, true].map(noisy => ({ id: `${sample.file}:${noisy}`, label: noisy ? '10 dB noise' : 'Clean', noisy, reference: sample.reference,
  audio: async () => { const response = await fetch(new URL(`stt/benchmark/${sample.file}`, document.baseURI), { signal }); if (!response.ok) throw new Error('Sample unavailable'); const blob = await response.blob(); return blob; },
}))), signal));
$('save-report').onclick = () => save(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }), 'speech-benchmark.json');
window.addEventListener('pagehide', () => { job?.abort(); stream.cancel(); recorder.stop(); models.close(); if (audioUrl) URL.revokeObjectURL(audioUrl); });
