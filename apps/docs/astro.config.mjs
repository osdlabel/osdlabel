import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import sitemap from '@astrojs/sitemap';
import solidJs from '@astrojs/solid-js';
import starlightTypeDoc, { typeDocSidebarGroup } from 'starlight-typedoc';

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
          entryPoints: [
            '../../packages/annotation',
            '../../packages/viewer-api',
            '../../packages/annotation-context',
            '../../packages/validation',
            '../../packages/fabric-annotations',
            '../../packages/fabric-osd',
            '../../packages/osd-helper',
            '../../packages/decoration',
            '../../packages/osdlabel',
            '../../packages/solid',
            '../../packages/react',
          ],
          tsconfig: '../../packages/annotation/tsconfig.json',
          output: 'api/reference',
          typeDoc: {
            entryPointStrategy: 'packages',
            excludePrivate: true,
            excludeInternal: true,
            readme: 'none',
          },
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
            { label: 'Keyboard Shortcuts', slug: 'guides/keyboard-shortcuts' },
            { label: 'Viewer Grid', slug: 'guides/viewer-grid' },
            { label: 'Annotation Contexts', slug: 'guides/annotation-contexts' },
            { label: 'Serialization', slug: 'guides/serialization' },
            { label: 'Components', slug: 'guides/components' },
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
    optimizeDeps: {
      include: [
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
  },
});
