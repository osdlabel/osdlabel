import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 5174;

export default defineConfig({
  server: { port: PORT },
  plugins: [react()],
  build: {
    target: 'esnext',
    rollupOptions: {
      // The same pages as `apps/dev`, so every E2E spec runs against both
      // bindings (#152): `annotator.html` mounts the stock <Annotator>,
      // `grid-controls.html` puts <GridControls> in a host slot, and
      // `viewer-cell.html` mounts a lone <ViewerCell>.
      input: {
        main: resolve(__dirname, 'index.html'),
        annotator: resolve(__dirname, 'annotator.html'),
        gridControls: resolve(__dirname, 'grid-controls.html'),
        viewerCell: resolve(__dirname, 'viewer-cell.html'),
      },
    },
  },
});
