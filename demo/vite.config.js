import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { speechAssets } from '../scripts/assets.mjs';
export default defineConfig({
  root: fileURLToPath(new URL('./', import.meta.url)), base: './',
  plugins: [speechAssets()],
  build: { target: 'esnext', outDir: '../demo-dist', emptyOutDir: true },
  server: { port: 3470, strictPort: true },
});
