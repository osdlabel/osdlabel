import { defineConfig } from 'vite';
import solidPlugin from 'vite-plugin-solid';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 5191;

export default defineConfig({
  server: { port: PORT },
  plugins: [solidPlugin()],
  // The dev apps' committed sample images, served at the root.
  publicDir: resolve(__dirname, '../dev/sample-data'),
  build: { target: 'esnext' },
  resolve: {
    alias: {
      'osdlabel-leptos-wasm': resolve(__dirname, 'pkg/osdlabel_leptos.js'),
    },
  },
});
