import { defineConfig } from 'vite';
import solidPlugin from 'vite-plugin-solid';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 5173;

export default defineConfig({
  server: { port: PORT },
  plugins: [solidPlugin()],
  build: {
    target: 'esnext',
    rollupOptions: {
      // `annotator.html` mounts the stock <Annotator> (App.tsx composes its own
      // layout), and `grid-controls.html` puts <GridControls> in a host slot,
      // so both layouts have an E2E harness (#147). `viewer-cell.html` mounts
      // a lone <ViewerCell> whose annotation rebuild a spec drives (#160).
      input: {
        main: resolve(__dirname, 'index.html'),
        annotator: resolve(__dirname, 'annotator.html'),
        gridControls: resolve(__dirname, 'grid-controls.html'),
        viewerCell: resolve(__dirname, 'viewer-cell.html'),
      },
    },
  },
  resolve: {
    alias: {
      // During development, resolve the library from its TypeScript source
      // so Vite's HMR picks up changes immediately without a tsc rebuild.
      osdlabel: resolve(__dirname, '../../packages/osdlabel/src/index.ts'),
    },
  },
});
