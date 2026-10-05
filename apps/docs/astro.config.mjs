import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import sitemap from '@astrojs/sitemap';
import solidJs from '@astrojs/solid-js';
import starlightTypeDoc, { typeDocSidebarGroup } from 'starlight-typedoc';
import mdx from '@astrojs/mdx';
import typeDocOptions from './typedoc.config.mjs';

const { entryPoints: typeDocEntryPoints, tsconfig: typeDocTsconfig, ...typeDoc } = typeDocOptions;

export default defineConfig({
  site: 'https://guyo13.github.io',
  base: '/osdlabel',
  legacy: { collections: true },
  integrations: [
    starlight({
      title: 'osdlabel',
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
    // Starlight adds `mdx({ optimize: true })` itself unless the config already
    // contains an `@astrojs/mdx` integration — we add it here only to set
    // `gfm`, and must therefore restate `optimize`. It has to sit *after*
    // `starlight()`, which splices its own integrations (including the
    // expressive-code one that must precede mdx) in right behind itself.
    //
    // Unless its own `gfm` option is set, `@astrojs/mdx` v5 falls back to
    // `markdown.gfm`, which Astro 6 deprecated and now leaves *undefined* by
    // default (the real default moved into the markdown processor). `.md` pages still get GFM from that
    // processor default, but every `.mdx` page silently lost it — tables
    // rendered as literal pipe-and-dash text, along with strikethrough,
    // autolinks and task lists. Setting it on the integration fixes MDX without
    // touching the deprecated `markdown.*` keys (whose suggested `unified({…})`
    // replacement MDX does not read).
    mdx({ optimize: true, gfm: true }),
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
