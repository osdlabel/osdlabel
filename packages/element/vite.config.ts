import { defineConfig } from 'vite';
import solidPlugin from 'vite-plugin-solid';
import { resolve } from 'path';

// Same shape as @osdlabel/solid's build: one ES module per source file, every
// dependency external, so a host bundler dedupes solid-js / fabric / OSD.
export default defineConfig({
  plugins: [solidPlugin()],
  build: {
    lib: {
      entry: {
        index: resolve(__dirname, 'src/index.ts'),
        'solid-element-variant': resolve(__dirname, 'src/solid-element-variant.tsx'),
      },
      formats: ['es'],
    },
    rollupOptions: {
      external: [
        'solid-js',
        'solid-js/web',
        'solid-js/store',
        'solid-element',
        'fabric',
        'openseadragon',
        'osdlabel',
        /^osdlabel\//,
        /^@osdlabel\//,
      ],
      output: {
        preserveModules: true,
        dir: 'dist',
        entryFileNames: '[name].js',
      },
    },
  },
});
