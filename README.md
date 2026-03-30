# osdlabel

Web-based image annotation library with rich drawing controls, customizable annotation contexts, and built-in serialization.

Powered by [OpenSeaDragon](https://openseadragon.github.io/) for deep zoom tiled image support, [Fabric.js](http://fabricjs.com/) v7 for interactive canvas rendering, and [SolidJS](https://www.solidjs.com/) for reactive UI. Draw rectangles, circles, lines, points, and freehand paths on gigapixel images with smooth pan and zoom.

## Features

- **Deep Zoom support** — annotate gigapixel images served as DZI tiles, or plain image files
- **Multi-image grid** — view and annotate up to 16 images simultaneously in a configurable grid layout
- **Annotation tools** — rectangle, circle, line, point, and freehand path drawing
- **Context system** — define multiple annotation contexts with per-tool constraints (max count, count scope)
- **Serialization** — export and import annotations as JSON with a versioned document format
- **Keyboard shortcuts** — fully configurable hotkeys for tools, grid navigation, and drawing actions
- **Framework-agnostic core** — annotation model, serialization, and constraint logic have zero UI framework dependencies
- **Tree-shakeable** — ESM sub-path exports let you import only what you need

## Installation

```bash
npm install osdlabel
```

## Quick Start

```tsx
import { render } from 'solid-js/web';
import { Annotator, createImageId, createAnnotationContextId } from 'osdlabel';
import type { ImageSource, AnnotationContext } from 'osdlabel';

const images: ImageSource[] = [
  {
    id: createImageId('slide-1'),
    tileSource: 'https://example.com/slides/slide-1.dzi',
    label: 'Slide 1',
  },
];

const contexts: AnnotationContext[] = [
  {
    id: createAnnotationContextId('review'),
    label: 'Review',
    tools: [
      { type: 'rectangle', maxCount: 5, countScope: 'per-image' },
      { type: 'circle' },
      { type: 'point' },
    ],
  },
];

function App() {
  return (
    <div style={{ width: '100vw', height: '100vh' }}>
      <Annotator
        images={images}
        contexts={contexts}
        showFilmstrip={true}
        showGridControls={true}
        showContextSwitcher={true}
        onAnnotationsChange={(annotations) => console.log(annotations)}
      />
    </div>
  );
}

render(() => <App />, document.getElementById('app')!);
```

## Composable API

For more control, use the individual components and provider directly:

```tsx
import {
  AnnotatorProvider,
  useAnnotator,
  Toolbar,
  StatusBar,
  GridView,
  Filmstrip,
  GridControls,
  serialize,
  deserialize,
} from 'osdlabel';
```

Wrap your UI in `<AnnotatorProvider>`, call `useAnnotator()` for access to state and actions, then compose `Toolbar`, `GridView`, `Filmstrip`, `StatusBar`, and `GridControls` however you like.

## Sub-path Imports

Import from specific modules to minimize bundle size:

```ts
import { Annotator } from 'osdlabel/components';
import { createAnnotationStore } from 'osdlabel/state';
import { FabricOverlay } from 'osdlabel/overlay';
import { useConstraints } from 'osdlabel/hooks';
import type { Annotation, Geometry } from 'osdlabel/core';
```

## Annotation Contexts

Contexts let you define separate annotation tasks with their own tool sets and constraints:

```ts
const context: AnnotationContext = {
  id: createAnnotationContextId('tumor-detection'),
  label: 'Tumor Detection',
  imageIds: [createImageId('slide-1')], // optional: scope to specific images
  tools: [
    { type: 'path', maxCount: 3 }, // max 3 paths globally
    { type: 'rectangle', maxCount: 2, countScope: 'per-image' }, // max 2 per image
    { type: 'point' }, // unlimited
  ],
};
```

## Keyboard Shortcuts

Default shortcuts (configurable via `keyboardShortcuts` prop):

| Action                | Key                    |
| --------------------- | ---------------------- |
| Select tool           | `v`                    |
| Rectangle tool        | `r`                    |
| Circle tool           | `c`                    |
| Line tool             | `l`                    |
| Point tool            | `p`                    |
| Path tool             | `d`                    |
| Delete annotation     | `Delete` / `Backspace` |
| Cancel / Deselect     | `Escape`               |
| Grid cell 1-9         | `1`-`9`                |
| Increase grid columns | `=` / `+`              |
| Decrease grid columns | `-`                    |
| Increase grid rows    | `]`                    |
| Decrease grid rows    | `[`                    |
| Finish path           | `Enter`                |
| Close path            | `c`                    |
| Cancel path           | `Escape`               |

## Serialization

```ts
import { serialize, deserialize } from 'osdlabel';

// Export
const doc = serialize(annotationState, images);
const json = JSON.stringify(doc);

// Import
const parsed = JSON.parse(json);
const byImage = deserialize(parsed);
actions.loadAnnotations(byImage);
```

## Development

This is a pnpm workspace monorepo using Turborepo:

```
packages/osdlabel/   # the publishable library
apps/dev/            # development app with HMR
apps/docs/           # documentation site (Astro + Starlight)
```

### Prerequisites

- Node.js 18+
- pnpm 10+

### Commands

```bash
pnpm install          # install dependencies
pnpm dev              # start dev server with HMR
pnpm build            # build the library
pnpm typecheck        # type-check all packages
pnpm test             # run unit tests (Vitest)
pnpm test:e2e         # run E2E tests (Playwright)
pnpm lint             # lint all packages
pnpm format           # format with Prettier
```

## Tech Stack

| Layer        | Technology          |
| ------------ | ------------------- |
| UI Framework | SolidJS 1.9         |
| Canvas       | Fabric.js 7         |
| Tile Viewer  | OpenSeaDragon 5     |
| Language     | TypeScript 5        |
| Bundler      | Vite 6              |
| Tests        | Vitest + Playwright |
| Monorepo     | pnpm + Turborepo    |

## License

[BSD-3-Clause](./LICENSE)
