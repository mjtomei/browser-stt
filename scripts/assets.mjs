import { readFile, mkdir, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
function dependencyFile(name, file) {
  let directory = path.dirname(require.resolve(name));
  for (;;) {
    try { if (require(path.join(directory, 'package.json')).name === name) return path.join(directory, file); } catch {}
    const parent = path.dirname(directory); if (parent === directory) throw new Error(`Cannot locate ${name}`); directory = parent;
  }
}
async function builtFiles(directory, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const name = prefix + entry.name;
    if (entry.isDirectory() && entry.name !== 'cpu') files.push(...await builtFiles(path.join(directory, entry.name), name + '/'));
    else if (entry.isDirectory()) continue;
    else files.push([`stt/${name}`, path.join(directory, entry.name)]);
  }
  return files;
}
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
export const speechAssetRoot = path.resolve(process.env.BROWSER_STT_CACHE || '.state/stt-assets');
export async function prepareSpeechAssets(manifest = 'model.json', include = () => true, cacheDir = speechAssetRoot) {
  const model = JSON.parse(await readFile(path.join(root, 'vendor/stt', manifest), 'utf8'));
  // Pin both revision and bytes. The fast model is bundled; correction weights
  // are downloaded by the app. Benchmarks can still request all local assets.
  for (const entry of model.files.filter(include)) {
    const file = path.join(cacheDir, model.directory, entry.file);
    const valid = bytes => bytes.length === entry.bytes && createHash('sha256').update(bytes).digest('hex') === entry.sha256;
    try { if (valid(await readFile(file))) continue; } catch {}
    console.log(`Fetching speech model: ${entry.file}`);
    const response = await fetch(`https://huggingface.co/${model.repository}/resolve/${model.revision}/${entry.file}`, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(`Speech model download failed: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!valid(bytes)) throw new Error(`Speech model checksum mismatch: ${entry.file}`);
    await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, bytes);
  }
  return model;
}

export function speechAssets({ cacheDir = speechAssetRoot, benchmarks = true, refinement = true, ensemble = false } = {}) {
  let files;
  return {
    name: 'local-speech-assets',
    async buildStart() {
      const models = ensemble ? [] : await Promise.all([prepareSpeechAssets('model.json', () => true, cacheDir), ...(refinement ? [prepareSpeechAssets('refinement-model.json', entry => !entry.file.endsWith('.onnx'), cacheDir)] : [])]);
      files = models.flatMap((model, index) => model.files.filter(entry => index === 0 || !entry.file.endsWith('.onnx')).map(entry => [`stt/${model.directory}/${entry.file}`, path.join(cacheDir, model.directory, entry.file)]));
      for (const suffix of ['', ...(refinement ? ['.asyncify'] : [])]) files.push([`stt/ort-wasm-simd-threaded${suffix}.mjs`, dependencyFile('onnxruntime-web', `dist/ort-wasm-simd-threaded${suffix}.mjs`)]);
      for (const [name, file] of [['moonshine', 'vendor/stt/moonshine-LICENSE'], ['whisper', 'vendor/stt/whisper-LICENSE'], ['onnxruntime', 'vendor/stt/onnxruntime-LICENSE'], ['transformers.js', dependencyFile('@huggingface/transformers', 'LICENSE')]]) files.push([`licenses/stt/${name}.txt`, path.resolve(root, file)]);
      for (const name of ['jinja', 'tokenizers']) files.push([`licenses/stt/${name}.txt`, dependencyFile(`@huggingface/${name}`, 'LICENSE')]);
      files.push(['licenses/stt/noble-hashes.txt', dependencyFile('@noble/hashes', 'LICENSE')]);
      files.push(['licenses/stt/NOTICE.txt', path.join(root, 'NOTICE')]);
      files.push(...await builtFiles(path.join(root, refinement ? 'dist' : 'dist/cpu')));
      if (ensemble) {
        for (const name of await readdir(path.join(root, 'vendor/ensemble-runtime'))) if (!name.endsWith('.mjs')) files.push([`stt/ensemble/${name}`, path.join(root, 'vendor/ensemble-runtime', name)]);
        files.push(['stt/ensemble-check.wav', path.join(root, 'vendor/stt/phone-benchmark/1272-128104-0000.wav')]);
        files.push(['licenses/stt/librispeech.txt', path.join(root, 'vendor/stt/librispeech-LICENSE.txt')]);
      }
      if (!benchmarks) return;
      const clips = JSON.parse(await readFile(path.join(root, 'vendor/stt/phone-benchmark/assets.json'), 'utf8'));
      for (const clip of clips) {
        const file = path.join(root, 'vendor/stt/phone-benchmark', clip.file), bytes = await readFile(file);
        if (bytes.length !== clip.bytes || createHash('sha256').update(bytes).digest('hex') !== clip.sha256) throw new Error(`Speech fixture checksum mismatch: ${clip.file}`);
        files.push([`stt/benchmark/${clip.file}`, file]);
      }
      if (!ensemble) files.push(['licenses/stt/librispeech.txt', path.join(root, 'vendor/stt/librispeech-LICENSE.txt')]);
      files.push(['licenses/stt/benchmark-samples.json', path.join(root, 'vendor/stt/benchmark-samples.json')]);
    },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const item = files?.find(([name]) => `/${name}` === req.url?.split('?')[0]);
        if (!item) return next();
        try { res.setHeader('Content-Type', /\.m?js$/.test(item[0]) ? 'text/javascript' : item[0].endsWith('.wasm') ? 'application/wasm' : item[0].endsWith('.json') ? 'application/json' : item[0].endsWith('.wav') ? 'audio/wav' : 'application/octet-stream'); res.end(await readFile(item[1])); }
        catch (error) { next(error); }
      });
    },
    async generateBundle() {
      for (const [fileName, file] of files) this.emitFile({ type: 'asset', fileName, source: await readFile(file) });
    },
  };
}
