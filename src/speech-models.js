import { correctionsAvailable } from './speech-profile.js';
// Only these pinned, packaged models can be selected by the app worker.
export const speechModels = {
  fast: { name: 'Moonshine Tiny', directory: 'moonshine-tiny', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' } },
  ...(correctionsAvailable ? { refine: { name: 'Whisper Small English', directory: 'whisper-small.en', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' } } } : {}),
};
