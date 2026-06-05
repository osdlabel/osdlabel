# @osdlabel/react

[React](https://react.dev/) bindings for
[osdlabel](https://github.com/osdlabel/osdlabel) — a web-based image annotation
library for gigapixel/DZI images, powered by
[OpenSeaDragon](https://openseadragon.github.io/) deep zoom and
[Fabric.js](http://fabricjs.com/) v7 canvas rendering.

Re-exports everything from the framework-agnostic `osdlabel` core plus React
components, hooks, and [Immer](https://immerjs.github.io/immer/)-based state
management. Works with React 18 and 19.

## Features

- Deep zoom annotation of gigapixel DZI images or plain image files
- Multi-image grid (up to 16 images) with one active annotation cell at a time
- Rectangle, circle, line, point, polyline/polygon, and freehand path tools
- Annotation contexts with per-tool constraints (max count, count scope)
- Derived text labels, calibrated measurements, and connector lines via
  decoration providers
- View controls (rotate / flip) with overlay annotations following in lockstep
- Configurable keyboard shortcuts
- Versioned JSON serialization

## Installation

```bash
npm install @osdlabel/react react react-dom fabric openseadragon valibot
```

## Quick Start

```tsx
import { createRoot } from 'react-dom/client';
import {
  Annotator,
  createImageId,
  createAnnotationContextId,
  initFabricModule,
} from '@osdlabel/react';
import type { ImageSource, AnnotationContext } from '@osdlabel/react';

initFabricModule();

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
        onAnnotationsChange={(annotations) => console.log(annotations)}
      />
    </div>
  );
}

createRoot(document.getElementById('app')!).render(<App />);
```

## Composable API

Prefer to assemble the UI yourself? Wrap your tree in `<AnnotatorProvider>`, call
`useAnnotator()` for state and actions, then compose `Toolbar`, `GridView`,
`Filmstrip`, `StatusBar`, `GridControls`, and `ViewControls`:

```tsx
import {
  AnnotatorProvider,
  useAnnotator,
  Toolbar,
  GridView,
  Filmstrip,
  StatusBar,
  GridControls,
  serialize,
  deserialize,
} from '@osdlabel/react';
```

Sub-path barrels are also available: `@osdlabel/react/components`,
`@osdlabel/react/state`, `@osdlabel/react/hooks`.

## Documentation

Full documentation, the composable API, decoration providers, and keyboard
shortcuts live in the [main repository](https://github.com/osdlabel/osdlabel).

## License

BSD-3-Clause.
