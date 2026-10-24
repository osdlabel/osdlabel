import { defineConfig } from 'vite';
import solidPlugin from 'vite-plugin-solid';
import vue from '@vitejs/plugin-vue';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 5470;

/** Every host page; the bench and the E2E specs address them by these names. */
export const PAGES = [
  'index',
  'vanilla',
  'vanilla-se',
  'vue',
  'svelte',
  'angular',
  'react-host',
  'solid',
  'lab',
  'theme',
] as const;

// COOP/COEP so the pages are cross-origin isolated like the other PoCs'
// harnesses (finer performance.now()); the sample images are same-origin.
const ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  // The dev app's committed fixtures (local only; see apps/dev/sample-data/README.md).
  publicDir: resolve(__dirname, '../dev/sample-data'),
  server: { port: PORT, strictPort: true, headers: ISOLATION_HEADERS },
  preview: { port: PORT, strictPort: true, headers: ISOLATION_HEADERS },
  plugins: [
    // Solid's JSX transform only for the Solid baseline page (the React host uses createElement).
    solidPlugin({ include: ['src/solid/**/*.tsx'] }),
    vue({
      template: { compilerOptions: { isCustomElement: (tag) => tag.startsWith('osdlabel-') } },
    }),
    svelte(),
  ],
  build: {
    target: 'esnext',
    rollupOptions: {
      input: Object.fromEntries(PAGES.map((p) => [p, resolve(__dirname, `${p}.html`)])),
    },
  },
});
