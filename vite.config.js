import { bundledNotices } from './scripts/bundled-notices.mjs';
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { serialSpeechSessions } from './scripts/serial-speech-sessions.mjs';

export default defineConfig(({ mode }) => ({
  base: './',
  define: { __STT_CPU_ONLY__: JSON.stringify(mode === 'cpu') },
  // Avoid emitting the unused asyncify/GPU binary in the CPU artifact.
  resolve: { alias: mode === 'cpu' ? [{ find: 'onnxruntime-web/webgpu', replacement: 'onnxruntime-web/wasm' }, { find: '../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm?url', replacement: fileURLToPath(new URL('./node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm', import.meta.url)) + '?url' }] : [] },
  plugins: [bundledNotices(), serialSpeechSessions()],
  build: {
    target: 'esnext', outDir: mode === 'cpu' ? 'dist/cpu' : 'dist', assetsInlineLimit: 0,
    rollupOptions: {
      input: Object.fromEntries(['speech-worker', 'ensemble-worker', 'speech-capture-worklet'].map(name => [name, fileURLToPath(new URL(`./src/${name}.js`, import.meta.url))])),
      output: { entryFileNames: '[name].js', chunkFileNames: 'chunks/[name]-[hash].js', assetFileNames: 'assets/[name]-[hash][extname]' },
    },
  },
}));
