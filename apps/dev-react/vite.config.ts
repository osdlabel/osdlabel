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
      // `viewer-cell.html` mounts a lone <ViewerCell> for the E2E spec it
      // shares with `apps/dev` (#152).
      input: {
        main: resolve(__dirname, 'index.html'),
        viewerCell: resolve(__dirname, 'viewer-cell.html'),
      },
    },
  },
});
