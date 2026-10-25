export type Model = 'fast' | 'refine';
/** Extract bounded filename spellings from prose/code, excluding URLs. */
export function filenamesInText(text: string): string[];
/** Spoken forms for up to 24 filenames, suitable for recognizer vocabulary hints. */
export function filenameVocabulary(filenames?: string[]): string[];
/** Opt-in post-vote formatting. Preserves metadata and remaps word confidence offsets. */
export function formatSpokenFilenames<T extends { text: string; words?: WordConfidence[] }>(result: T, filenames?: string[]): T;
export type Backend = 'wasm' | 'webgpu';
export type ConfidenceMetric = 'minimum' | 'mean' | 'geometricMean';
export interface ConfidenceRule { metric?: ConfidenceMetric; threshold?: number }
export interface ConfidenceOptions extends ConfidenceRule { rules?: Record<string, ConfidenceRule> }
export interface WordConfidence {
  /** UTF-16 character offsets into Transcription.text; end is exclusive. */
  start: number; end: number; text: string;
  tokens: Array<{ token: number; probability: number }>;
  scores: Record<ConfidenceMetric, number | null>;
  confidence: number | null;
  /** >= threshold. null means no usable evidence, not low confidence. */
  confident: boolean | null;
  flags: Record<string, boolean | null>;
}
export interface ModelInfo {
  verified?: boolean;
  verification?: 'saved' | 'tested';
  backend: Backend; model: string; simd: boolean; threads: number; loadMs: number; reused: boolean;
  sessionLoading?: string;
  adapter?: { vendor: string; architecture: string; fallback: boolean };
  download?: { downloadedBytes: number; cachedBytes: number; cacheAvailable: boolean; cacheError?: string };
}
export interface Transcription extends ModelInfo {
  text: string; words: WordConfidence[]; seconds: number; transcribeMs: number;
  partial: boolean; vocabularyTerms: number; vocabularyCandidates: number; vocabularyTokens: number;
  segments?: Array<{ seconds: number; tokens: number; tokenLimit: number }>;
}
export interface TranscribeOptions {
  signal?: AbortSignal; progress?: (message: string) => void;
  /** Provisional complete words from the current decoding pass; replacements, not deltas. */
  onPartial?: (result: Pick<Transcription, 'text' | 'words' | 'partial'>) => void;
  vocabulary?: string[]; partial?: boolean; confidence?: ConfidenceOptions;
  /** Experimental Tiny decode limit, 2–60 seconds; default 15. */
  chunkSeconds?: number;
}
export class LocalSpeech {
  constructor(options?: { base?: string; createWorker?: () => Worker; idleMs?: number; retainOnCancel?: boolean; confidence?: ConfidenceOptions });
  prepare(backend: Backend, options?: TranscribeOptions & { model?: Model }): Promise<ModelInfo>;
  transcribe(backend: Backend, audio: Blob, options?: TranscribeOptions & { model?: Model }): Promise<Transcription>;
  close(error?: Error): void;
}
export interface ModelEntry {
  model: Model; backend: Backend; state: 'idle' | 'loading' | 'ready' | 'error';
  progress: string; error: Error | null; ready: ModelInfo | null;
}
export class ResidentSpeech {
  constructor(options?: { refinement?: boolean; base?: string; confidence?: ConfidenceOptions; create?: () => LocalSpeech; changed?: () => void; failure?: (error: Error, backend: Backend, model: Model) => void;
    prepareModel?: (entry: { model: Model; backend: Backend; local: LocalSpeech; generation: number }, options: { model: Model; retry: boolean; progress: (text: string) => void }) => Promise<ModelInfo> });
  entries: { fast: ModelEntry; refine?: ModelEntry };
  open(options?: { refine?: boolean; retry?: boolean }): Promise<PromiseSettledResult<ModelInfo>[]>;
  prepare(model: Model, options?: { retry?: boolean }): Promise<ModelInfo>;
  wait(model: Model, options?: { retry?: boolean; signal?: AbortSignal }): Promise<ModelInfo>;
  transcribe(model: Model, audio: Blob, options?: TranscribeOptions): Promise<Transcription>;
  close(model?: Model): void;
}
export interface PcmReceipt { kind: 'pcm-stream'; bytes: number; seconds: number; checksum: number }
export class PcmMicrophone {
  constructor(control: (open: boolean) => boolean | Promise<boolean>, onLimit?: () => void, onChunk?: (pcm: Uint8Array) => void);
  bytes: number; capturing: boolean;
  start(options?: { retainAudio?: boolean }): Promise<boolean>; receive(bytes: Uint8Array, bufferedTail?: boolean): void; stop(): Promise<Blob | PcmReceipt>;
}
export class BrowserMicrophone extends PcmMicrophone {
  constructor(onLimit?: () => void, onChunk?: (pcm: Uint8Array) => void, options?: { base?: string });
}
export class SpeechRecording {
  constructor(microphone: () => PcmMicrophone, changed?: () => void);
  readonly active: boolean;
  start(signal: AbortSignal, progress: (message: string) => void): Promise<Blob>;
  stop(): void; chunk(): void;
}
export class SpeechStream {
  constructor(options: { transcribe: (audio: Blob, options: TranscribeOptions) => Promise<Transcription>; prepare?: (options: { signal: AbortSignal }) => Promise<unknown>; result: (result: Pick<Transcription, 'text' | 'words'>) => void; failure?: (error: Error) => void; backlog?: () => void; intervalMs?: number; minAudioMs?: number; firstAudioMs?: number; firstIntervalMs?: number; overlapSeconds?: number; windowSeconds?: number; commitOnPause?: boolean; confidence?: ConfidenceOptions });
  start(vocabulary?: string[]): void; receive(bytes: Uint8Array): void; cancel(): void;
  /** Drain pending work after the same microphone's stop() has flushed all PCM. */
  finish(audio: Blob | PcmReceipt, options?: { signal?: AbortSignal }): Promise<Transcription>;
}
export class SpeechRefinement {
  constructor(options: { transcribe: (audio: Blob, signal: AbortSignal) => Promise<Transcription>; current: () => string; replace: (text: string, result: Transcription) => void; status: (message: string) => void; result?: (result: Transcription) => void; failure?: (error: Error) => void });
  start(audio: Blob, original: string): Promise<void>; cancel(): void; finished?: () => void;
}
export const SPEECH_RATE: 16000;
export const MAX_SPEECH_SECONDS: 60;
export const SPEECH_CONFIDENCE_THRESHOLD: 0.9;
export const DEFAULT_CONFIDENCE: Readonly<Required<ConfidenceRule>>;
export const speechModels: Record<Model, { name: string; directory: string; dtype: Record<string, string> }>;
export function pcmWave(chunks: Uint8Array[]): Blob;
export function pcmChecksum(bytes: Uint8Array, hash?: number): number;
export function waveSamples(buffer: ArrayBuffer): Float32Array;
export function samplesWave(samples: Float32Array): Blob;
export function normalizeRecording(blob: Blob, options?: { truncate?: boolean }): Promise<Blob>;
export function confidenceOptions(options?: ConfidenceOptions): Required<ConfidenceRule> & { rules: Record<string, Required<ConfidenceRule>> };
export function confidenceWords(text: string, scores: Array<{ token: number; probability: number }>, decode: (ids: number[]) => string, options?: ConfidenceOptions): WordConfidence[];
export function classifyWords(words: WordConfidence[], options?: ConfidenceOptions): WordConfidence[];
export function uncertainWords(text: string, words?: WordConfidence[], threshold?: number): WordConfidence[];

export interface StreamingSampleResult {
  text: string; words: WordConfidence[]; backend: Backend; model: string;
  audioMs: number; recordingMs: number; firstWordMs: number | null; releaseMs: number; totalMs: number;
  inferenceMs: number; calls: number; updates: Array<{ ms: number; text: string }>;
  textAtRelease: string; backlog: Array<{ ms: number; audioMs: number; completedAudioMs: number; backlogMs: number }>;
  backlogAtReleaseMs: number; backlogP95Ms: number; backlogEarlyMs: number; backlogLateMs: number;
  updateCount: number; maxUpdateGapMs: number | null; revisions: number; maxFeedDelayMs: number; timingValid: boolean;
}
export interface StreamingProgress { text: string; elapsedMs: number; durationMs: number; backlogMs: number; finishing: boolean }
export interface StreamingBenchmarkSample { id: string; label: string; reference: string; noisy?: boolean; audio: (signal: AbortSignal) => Promise<Blob> }
export interface SpeechScore { errors: number; referenceWords: number; wer: number; substitutions: number; deletions: number; insertions: number; wrong: boolean[]; extras: number[] }
export type StreamingBenchmarkResult = (StreamingSampleResult & { score: SpeechScore | null; releaseScore: SpeechScore | null }) | { error: string };
export interface StreamingBenchmarkRun {
  id: string; label: string; reference: string; noisy: boolean; fast?: StreamingBenchmarkResult; refine?: StreamingBenchmarkResult;
  changes?: { fixed: number; introduced: number } | null;
}
export interface StreamingBenchmarkReport {
  kind: 'streaming'; completed: boolean; cadence: { feedMs: number; minAudioMs: number; intervalMs: number };
  prepared: Partial<Record<Model, (ModelInfo & { alreadyReady: boolean; waitMs: number }) | { error: string }>>;
  warmup: Partial<Record<Model, { ms: number; backend: Backend } | { error: string }>>;
  runs: StreamingBenchmarkRun[];
  active: (Partial<StreamingProgress> & { model: Model; label: string; text: string; elapsedMs: number }) | null;
}
export function streamSpeechSample(options: { audio: Blob; transcribe: (audio: Blob, options: TranscribeOptions) => Promise<Transcription>;
  signal?: AbortSignal; update?: (progress: StreamingProgress) => void }): Promise<StreamingSampleResult>;
export function runStreamingSpeechBenchmark(options: { samples: StreamingBenchmarkSample[]; models: ResidentSpeech; signal?: AbortSignal;
  progress?: (text: string, stage: 'prepare' | 'warmup' | 'stream') => void; update?: (report: StreamingBenchmarkReport) => void }): Promise<StreamingBenchmarkReport>;
export function summarizeStreamingSpeech(runs: StreamingBenchmarkRun[]): Record<Model, { count: number; timedCount: number;
  wer: number | null; firstWordMs: number | null; releaseMs: number | null; updateCount: number | null; revisions: number | null;
  backlogP95Ms: number | null; backlogAtReleaseMs: number | null; backlogEarlyMs: number | null; backlogLateMs: number | null; maxUpdateGapMs: number | null }>;

export type EnsembleModelId = 'conformer' | 'zipformer' | 'moonshine';
export interface EnsembleAsset { file: string; bytes: number; sha256: string; url?: string; text?: string }
export interface EnsembleManifest { id: EnsembleModelId; name: string; directory: string; files: EnsembleAsset[] }
export const ensembleModels: readonly EnsembleManifest[];
export interface ModelKeyValue { get(key: string): Promise<string | null | undefined>; set(key: string, value: string): Promise<unknown> }
export class EnsembleModelStore {
  constructor(options?: { kv?: ModelKeyValue | Promise<ModelKeyValue> | (() => Promise<ModelKeyValue>); fetch?: typeof fetch });
  stats: { downloadedBytes: number; cachedBytes: number };
  ensure(file: EnsembleAsset, progress?: (bytes: number, cached?: boolean) => void): Promise<void>;
  read(file: EnsembleAsset): Promise<Response>; cancel(): void;
  beginPreparation(model: Pick<EnsembleManifest, 'id' | 'name'>, options?: { retry?: boolean }): Promise<() => Promise<void>>;
}
export interface EnsembleEntry { verified?: boolean; model: EnsembleManifest; state: 'idle' | 'downloading' | 'loading' | 'ready' | 'error'; progress: string; downloadBytes: number; totalBytes: number; setup: { stage: 'waiting' | 'runtime' | 'loading' | 'initializing' | 'checking' | 'ready'; loadedBytes: number; totalBytes: number; file?: string; component?: string; fileLoadedBytes?: number; fileBytes?: number; startedAt?: number; stageStartedAt?: number; lastProgressAt?: number }; error?: Error; ready?: ModelInfo }
export class EnsembleSpeech {
  constructor(options?: { base?: string; store?: EnsembleModelStore; changed?: () => void; failure?: (error: Error, backend: Backend, model: string) => void; checkpoint?: () => void | Promise<void>; verificationDevice?: string });
  entries: Record<EnsembleModelId, EnsembleEntry>;
  restoreVerification(): Promise<boolean>;
  store: EnsembleModelStore;
  setStorage(kv: ModelKeyValue): void;
  open(options?: { retry?: boolean }): Promise<PromiseSettledResult<ModelInfo>[]>;
  prepare(id: EnsembleModelId, options?: { retry?: boolean; signal?: AbortSignal }): Promise<ModelInfo>;
  transcribe(id: EnsembleModelId, audio: Blob, options?: TranscribeOptions): Promise<Transcription>;
  close(): void;
}
export interface EnsembleTranscription extends Transcription { models: EnsembleModelId[]; unavailableModels: EnsembleModelId[] }
export class EnsembleStream {
  constructor(options: { models: Pick<EnsembleSpeech, 'entries' | 'transcribe'> & Partial<Pick<EnsembleSpeech, 'prepare'>>; result: (result: EnsembleTranscription) => void; failure?: (error: Error) => void; backlog?: () => void; confidence?: ConfidenceOptions; streamOptions?: { intervalMs?: number; minAudioMs?: number; firstAudioMs?: number; firstIntervalMs?: number; commitOnPause?: boolean } });
  active: boolean; finishing: boolean; latest: EnsembleTranscription | null;
  start(vocabulary?: string[], options?: { filenames?: string[] }): void; receive(bytes: Uint8Array): void; cancel(): void;
  finish(audio: Blob | PcmReceipt, options?: { signal?: AbortSignal }): Promise<EnsembleTranscription>;
}
export function voteSpeech(hypotheses: Array<Pick<Transcription, 'text' | 'words'> & { id: string }>, options?: { final?: boolean; confidence?: ConfidenceOptions; vocabulary?: string[]; filenames?: string[] }): { text: string; words: WordConfidence[]; models: string[] };
export interface EnsembleCache { match(key: string): Promise<Response | undefined>; put(key: string, response: Response): Promise<void>; delete(key: string): Promise<unknown>; close(): void }
export function nativeModelCache(kv: ModelKeyValue): EnsembleCache;
export function alignPanel<A, B>(a: A[], b: B[], equal: (a: A, b: B) => boolean): Array<[number, number]>;
