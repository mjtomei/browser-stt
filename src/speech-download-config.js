import model from '../vendor/stt/refinement-model.json' with { type: 'json' };
import { correctionsAvailable } from './speech-profile.js';

// Only these immutable, checksum-pinned weights may be downloaded at runtime.
// Tokenizers/configuration and the fast CPU model remain in the package.
export const speechDownloads = correctionsAvailable ? model.files.filter(entry => entry.file.endsWith('.onnx')).map(entry => ({
  ...entry,
  local: `${model.directory}/${entry.file}`,
  url: `https://huggingface.co/${model.repository}/resolve/${model.revision}/${entry.file}`,
})) : [];
export const speechDownloadOrigins = ['https://huggingface.co', 'https://us.aws.cdn.hf.co'];
