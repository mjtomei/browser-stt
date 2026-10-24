import { ResidentSpeech, LocalSpeech, BrowserMicrophone, SpeechStream, classifyWords, runStreamingSpeechBenchmark, summarizeStreamingSpeech, type WordConfidence } from '@pageborne/browser-stt';

const speech = new ResidentSpeech({ confidence: { metric: 'mean', threshold: .8, rules: { strict: { threshold: .9 } } } });
const stream = new SpeechStream({
  transcribe: (audio, options) => speech.transcribe('fast', audio, options),
  result: result => { const words: WordConfidence[] = classifyWords(result.words); void words[0]?.confident; },
});
const microphone = new BrowserMicrophone(() => {}, bytes => stream.receive(bytes));
void microphone;
void stream.finish(new Blob(), { signal: new AbortController().signal });
new LocalSpeech({ base: 'https://example.test/stt/', confidence: { threshold: .9 } }).close();

void speech.transcribe('fast', new Blob(), { onPartial: result => { const text: string = result.text; const words: WordConfidence[] = result.words; void [text, words]; } });
void runStreamingSpeechBenchmark({ models: speech, samples: [{ id: 'one', label: 'One', reference: 'hello', audio: async () => new Blob() }],
  update: report => { const ms: number | null = summarizeStreamingSpeech(report.runs).refine.firstWordMs; void ms; } });
void microphone.start({ retainAudio: false }).then(async () => stream.finish(await microphone.stop()));
new SpeechStream({ transcribe: (audio, options) => speech.transcribe('fast', audio, options), result() {}, overlapSeconds: 7.5, backlog() {} });
new SpeechStream({ transcribe: (audio, options) => speech.transcribe('fast', audio, options), result() {}, windowSeconds: 30, overlapSeconds: 15, commitOnPause: false });
void speech.transcribe('fast', new Blob(), { chunkSeconds: 60 }).then(result => { const seconds: number | undefined = result.segments?.[0].seconds; void seconds; });
