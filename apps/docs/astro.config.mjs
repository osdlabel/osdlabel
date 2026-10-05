import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import sitemap from '@astrojs/sitemap';
import solidJs from '@astrojs/solid-js';
import starlightTypeDoc, { typeDocSidebarGroup } from 'starlight-typedoc';
import typeDocOptions from './typedoc.config.mjs';

const { entryPoints: typeDocEntryPoints, tsconfig: typeDocTsconfig, ...typeDoc } = typeDocOptions;

export default defineConfig({
  site: 'https://guyo13.github.io',
  base: '/osdlabel',
  integrations: [
    starlight({
      title: 'osdlabel',
      // src/pages/404.astro replaces Starlight's 404 route; see the note there.
      disable404Route: true,
      description:
        'Web-based image annotation library with rich controls, customization, and serialization',
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/guyo13/osdlabel',
        },
      ],
      editLink: {
        baseUrl: 'https://github.com/guyo13/osdlabel/edit/main/apps/docs/',
      },
      customCss: ['./src/styles/custom.css'],
      plugins: [
        starlightTypeDoc({
          entryPoints: typeDocEntryPoints,
          tsconfig: typeDocTsconfig,
          output: 'api/reference',
          typeDoc,
          sidebar: {
            label: 'Package Reference',
            collapsed: true,
          },
        }),
      ],
      sidebar: [
        {
          label: 'Getting Started',
          items: [
            { label: 'Installation', slug: 'getting-started/installation' },
            { label: 'Quick Start', slug: 'getting-started/quick-start' },
            { label: 'Core Concepts', slug: 'getting-started/concepts' },
          ],
        },
        {
          label: 'Guides',
          items: [
            { label: 'Packages & Architecture', slug: 'guides/packages-and-architecture' },
            { label: 'Basic Controls', slug: 'guides/basic-controls' },
            { label: 'Custom Drag Controls', slug: 'guides/custom-controls' },
            { label: 'Keyboard Shortcuts', slug: 'guides/keyboard-shortcuts' },
            { label: 'Viewer Grid', slug: 'guides/viewer-grid' },
            { label: 'Annotation Contexts', slug: 'guides/annotation-contexts' },
            { label: 'Serialization', slug: 'guides/serialization' },
            { label: 'Components', slug: 'guides/components' },
            { label: 'React & SSR', slug: 'guides/react-and-ssr' },
            { label: 'State & Hooks', slug: 'guides/state-and-hooks' },
            { label: 'Coordinate Systems', slug: 'guides/coordinate-systems' },
            { label: 'Decorations', slug: 'guides/decorations' },
            { label: 'Measurements', slug: 'guides/measurements' },
            { label: 'OSD-Fabric Integration', slug: 'guides/osd-fabric-integration' },
          ],
        },
        {
          label: 'API Reference',
          items: [typeDocSidebarGroup],
        },
        {
          label: 'Examples',
          items: [
            { label: 'Minimal Viewer', slug: 'examples/minimal-viewer' },
            { label: 'Multiple Annotation Contexts', slug: 'examples/multiple-contexts' },
            { label: 'Custom Toolbar', slug: 'examples/custom-toolbar' },
            { label: 'Decorations & Measurements', slug: 'examples/decorations' },
            { label: 'Interactive Demo', link: '/demo/' },
          ],
        },
      ],
    }),
    sitemap(),
    solidJs(),
  ],
  vite: {
    ssr: {
      noExternal: [
        'osdlabel',
        '@osdlabel/annotation',
        '@osdlabel/annotation-context',
        '@osdlabel/viewer-api',
        '@osdlabel/validation',
        '@osdlabel/fabric-annotations',
        '@osdlabel/fabric-osd',
        '@osdlabel/solid',
        '@osdlabel/react',
        'fabric',
        'openseadragon',
      ],
    },
    // Only this app's own dependencies: Vite resolves these from apps/docs, so
    // a package it reaches only through another one (fabric, openseadragon,
    // the fabric-* and validation packages) cannot be listed here. Each such
    // entry only printed "Failed to resolve dependency" and was skipped.
    optimizeDeps: {
      include: [
        'osdlabel',
        '@osdlabel/annotation',
        '@osdlabel/annotation-context',
        '@osdlabel/viewer-api',
        '@osdlabel/solid',
        '@osdlabel/react',
      ],
    },
    build: {
      rollupOptions: {
        output: {
          // The demo islands pull in Fabric and OpenSeadragon. Bundled with
          // the island they made one ~630 kB chunk, over Vite's 500 kB
          // warning; on their own they stay under it and are cached across
          // pages.
          manualChunks(id) {
            if (id.includes('/node_modules/fabric/')) return 'fabric';
            if (id.includes('/node_modules/openseadragon/')) return 'openseadragon';
            return undefined;
          },
        },
      },
    },
  },
});
