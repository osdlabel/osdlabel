# osdlabel

Web-based image annotation library with rich drawing controls, customizable annotation contexts, and built-in serialization.

Powered by [OpenSeaDragon](https://openseadragon.github.io/) for deep zoom tiled image support and [Fabric.js](http://fabricjs.com/) v7 for interactive canvas rendering, with official UI bindings for [SolidJS](https://www.solidjs.com/) and [React](https://react.dev/). Draw rectangles, circles, lines, points, and freehand paths on gigapixel images with smooth pan and zoom.

## Features

- **Deep Zoom support** — annotate gigapixel images served as DZI tiles, or plain image files
- **Multi-image grid** — view and annotate up to 16 images simultaneously in a configurable grid layout
- **Annotation tools** — rectangle, circle, line, point, polyline/polygon, and freehand path drawing
- **Vertex editing** — long-press a polygon or polyline to move, insert, and delete individual vertices
- **Geometry conversion** — convert a selected circle to its bounding rectangle
- **Context system** — define multiple annotation contexts with per-tool constraints (max count, count scope)
- **Decorations & measurements** — derived text labels, calibrated area/length/perimeter measurements, and connector lines via composable `DecorationProvider` functions, recomputed at render time (never serialized)
- **View controls** — per-cell rotate, flip, and tonal adjustment (exposure, contrast, invert) with overlay annotations following in lockstep
- **Drag-driven controls** — a `customControl` overlay mode that routes raw pointer input to your own handler, used by the built-in two-axis exposure/contrast gesture
- **Serialization** — export and import annotations as JSON with a versioned document format
- **Keyboard shortcuts** — fully configurable hotkeys for tools, grid navigation, and drawing actions
- **Framework-agnostic core** — annotation model, serialization, and constraint logic have zero UI framework dependencies
- **SolidJS and React** — first-class bindings for both frameworks with identical APIs
- **Tree-shakeable** — ESM sub-path exports let you import only what you need

## Installation

### SolidJS

```bash
npm install @osdlabel/solid
```

### React

```bash
npm install @osdlabel/react
```

## Quick Start

### SolidJS

```tsx
import { render } from 'solid-js/web';
import { Annotator, createImageId, createAnnotationContextId } from '@osdlabel/solid';
import type { ImageSource, AnnotationContext } from '@osdlabel/solid';

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

### React

```tsx
import { createRoot } from 'react-dom/client';
import { Annotator, createImageId, createAnnotationContextId } from '@osdlabel/react';
import type { ImageSource, AnnotationContext } from '@osdlabel/react';

// images and contexts defined the same way as above

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

createRoot(document.getElementById('app')!).render(<App />);
```

The viewer registers the Fabric `id` custom property automatically when it
mounts, so there is no setup call to remember. `initFabricModule()` is still
exported and idempotent for advanced setups that build Fabric objects before any
viewer exists.

## Composable API

For more control, use the individual components and provider directly:

```tsx
// SolidJS — the same names are exported from '@osdlabel/react'
import {
  AnnotatorProvider,
  useAnnotator,
  Toolbar,
  StatusBar,
  GridView,
  Filmstrip,
  GridControls,
  ContextSwitcher,
  ViewControls,
  serialize,
  deserialize,
} from '@osdlabel/solid';
```

Wrap your UI in `<AnnotatorProvider>`, call `useAnnotator()` for access to state and actions, then compose `Toolbar`, `GridView`, `Filmstrip`, `StatusBar`, `GridControls`, `ContextSwitcher`, and `ViewControls` however you like.

## Direct Package Imports

**Import everything from the single umbrella package you already depend on**
(`@osdlabel/solid`, `@osdlabel/react`, or `osdlabel`). Types such as `ImageId`,
`AnnotationId`, and `ImageSource` physically live in lower-level subpackages, so
importing them from those paths only resolves when the subpackage is a _direct_
dependency of your app. The umbrella re-exports them all.

Reach for the granular packages only when building a custom UI layer, and add
them as explicit dependencies:

```ts
import type { Annotation, Geometry } from '@osdlabel/annotation';
import type { ImageSource } from '@osdlabel/viewer-api';
import type { AnnotationContext } from '@osdlabel/annotation-context';
import { serialize, deserialize, applyAnnotationAction } from 'osdlabel';
```

## Annotation Contexts

Contexts let you define separate annotation tasks with their own tool sets and constraints:

```ts
const context: AnnotationContext = {
  id: createAnnotationContextId('tumor-detection'),
  label: 'Tumor Detection',
  imageIds: [createImageId('slide-1')], // optional: scope to specific images
  tools: [
    { type: 'polyline', maxCount: 3 }, // max 3 polylines globally
    { type: 'rectangle', maxCount: 2, countScope: 'per-image' }, // max 2 per image
    { type: 'point' }, // unlimited
  ],
};
```

## Keyboard Shortcuts

Default shortcuts (configurable via `keyboardShortcuts` prop):

### Tools

| Action             | Key                    |
| ------------------ | ---------------------- |
| Select tool        | `v`                    |
| Rectangle tool     | `r`                    |
| Circle tool        | `c`                    |
| Line tool          | `l`                    |
| Point tool         | `p`                    |
| Polyline tool      | `d`                    |
| Freehand path tool | `f`                    |
| Delete annotation  | `Delete` / `Backspace` |
| Cancel / Deselect  | `Escape`               |

### Grid & contexts

| Action                      | Key       |
| --------------------------- | --------- |
| Grid cell 1-9               | `1`-`9`   |
| Increase grid columns       | `=` / `+` |
| Decrease grid columns       | `-`       |
| Increase grid rows          | `]`       |
| Decrease grid rows          | `[`       |
| Next annotation context     | `.`       |
| Previous annotation context | `,`       |

Context cycling steps through the `contexts` array in configured order, wrapping
at both ends and skipping contexts scoped to other images.

### View & tone (active cell, `Shift` + key)

| Action            | Key         |
| ----------------- | ----------- |
| Rotate clockwise  | `Shift`+`R` |
| Rotate counter-CW | `Shift`+`L` |
| Flip horizontally | `Shift`+`H` |
| Flip vertically   | `Shift`+`V` |
| Toggle negative   | `Shift`+`N` |
| Increase exposure | `Shift`+`E` |
| Decrease exposure | `Shift`+`D` |
| Increase contrast | `Shift`+`C` |
| Decrease contrast | `Shift`+`X` |
| Reset view        | `Shift`+`0` |

### Polyline drawing

| Action      | Key      |
| ----------- | -------- |
| Finish path | `Enter`  |
| Close path  | `c`      |
| Cancel path | `Escape` |

## Decorations & Measurements

Decorations are a pure derivation of annotation state — text labels, computed
measurements, and connector lines produced by `DecorationProvider` functions and
recomputed at render time. They are never part of `serialize()` output. Pass
providers to the `Annotator` via `decorationProviders`, and supply
`defaultPixelSpacing` (or per-image `pixelSpacing` on the `ImageSource`) to render
calibrated physical measurements:

```ts
import { createMeasurementProvider, createLabelProvider, composeProviders } from '@osdlabel/solid'; // or '@osdlabel/react'

// composeProviders takes an array; createMeasurementProvider needs an options
// object saying which measurements to render (all flags default to false).
const providers = composeProviders([
  createLabelProvider(),
  createMeasurementProvider({ area: true, perimeter: true, length: true, radius: true }),
]);

// <Annotator decorationProviders={providers} defaultPixelSpacing={{ x: 0.25, y: 0.25, unit: 'um' }} ... />
```

## View & Tone Controls

Each grid cell carries its own `CellTransform` — rotation, horizontal/vertical
flip, and the tonal adjustments `exposure`, `contrast`, and `inverted`. Rotation
and flip are composed into the Fabric `viewportTransform` so annotations track
the image exactly; the tonal fields are rendered as a CSS `filter` on the viewer
element and never touch annotation geometry.

The built-in `ViewControls` component exposes all of these (shown by default in
`Annotator`; disable with `showViewControls={false}`), and the `Shift`+key
shortcuts above drive the same actions.

Exposure and contrast also have a **drag** gesture: arming the `tone` control puts
the overlay into `customControl` mode, where a horizontal drag adjusts exposure
(left = brighter) and a vertical drag adjusts contrast (up = more). The same
mechanism is available for your own controls:

```ts
import { createDragValueControl, createDragVectorControl } from '@osdlabel/solid';

const handler = createDragValueControl({
  getValue: () => currentValue, // read at pointer-down
  setValue: (v) => setValue(v), // called continuously during the drag
  sensitivity: 0.01,
  step: 0.025,
  min: -1,
  max: 1,
});

overlay.setCustomControlHandler(handler);
overlay.setMode('customControl');
```

## Serialization

```ts
import { serialize, deserialize } from '@osdlabel/solid'; // or '@osdlabel/react'

// Export
const doc = serialize(annotationState);
const json = JSON.stringify(doc);

// Import
const parsed = JSON.parse(json);
const { byImage } = deserialize(parsed);
actions.loadAnnotations(byImage);
```

## Development

This is a pnpm workspace monorepo using Turborepo. The library is split into
focused packages with strict dependency boundaries:

```
packages/annotation/          # @osdlabel/annotation — pure data model (zero deps)
packages/viewer-api/          # @osdlabel/viewer-api — viewer state types, PixelSpacing
packages/geometry/            # @osdlabel/geometry — geometry math & conversions
packages/annotation-context/  # @osdlabel/annotation-context — contexts, constraints, scoping
packages/decoration/          # @osdlabel/decoration — decorations & providers (re-exports geometry math)
packages/validation/          # @osdlabel/validation — Valibot schemas (Standard Schema)
packages/osd-helper/          # @osdlabel/osd-helper — OpenSeaDragon utilities
packages/fabric-annotations/  # @osdlabel/fabric-annotations — Fabric.js tools & serialization
packages/fabric-osd/          # @osdlabel/fabric-osd — Fabric.js + OSD overlay bridge
packages/osdlabel/            # osdlabel — framework-agnostic core (serialization, reducers, constraints)
packages/solid/               # @osdlabel/solid — SolidJS bindings
packages/react/               # @osdlabel/react — React bindings
apps/dev/                     # SolidJS development app with HMR
apps/dev-react/               # React development app with HMR
apps/docs/                    # documentation site (Astro + Starlight)
```

Most apps import from `@osdlabel/solid` or `@osdlabel/react` — the granular
packages are available for custom UI layers and advanced integrations.

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

| Layer         | Technology                |
| ------------- | ------------------------- |
| UI Frameworks | SolidJS 1.9, React 18/19  |
| State (React) | Immer 10                  |
| Canvas        | Fabric.js 7.4             |
| Tile Viewer   | OpenSeaDragon 5           |
| Validation    | Valibot (Standard Schema) |
| Language      | TypeScript 5.9            |
| Bundler       | Vite 8                    |
| Tests         | Vitest 4 + Playwright     |
| Monorepo      | pnpm + Turborepo          |

## License

[BSD-3-Clause](./LICENSE)
