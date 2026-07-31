# @osdlabel/fabric-osd

[Fabric.js](http://fabricjs.com/) + [OpenSeaDragon](https://openseadragon.github.io/)
overlay bridge and decoration renderer for
[osdlabel](https://github.com/osdlabel/osdlabel), a web-based image annotation
library for gigapixel/DZI images.

This package computes the Fabric `viewportTransform` that maps image-space
coordinates to screen-space at the current OSD zoom/pan/rotate/flip, so
annotations stored in image-space render in the right place on every frame.
SolidJS-agnostic. `fabric` and `openseadragon` are peer dependencies.

## Installation

```bash
npm install @osdlabel/fabric-osd fabric openseadragon
```

## What's inside

- `FabricOverlay` — canvas overlay + viewport transform; exposes `onSync`,
  `overlayElement`, and flip-aware `imageToScreen` / `screenToImage`. Calls
  `initFabricModule()` on construction, so consumers don't have to.
- `DecorationLayer` — renders text decorations as positioned DOM elements and
  connector lines as non-interactive Fabric objects
- `composeImageFilterCss` / `ImageFilters` — composes a cell's tonal adjustments
  (`exposure`, `contrast`, `inverted`) into a CSS `filter` value
- Drag-driven control factories: `createDragValueControl` (one value),
  `createDragVectorControl` (one value per axis), and the shared
  `DragAxisBehavior` config
- Pure helpers: `computeViewportTransform`, `imageToScreenFlipAware`,
  `screenToImageFlipAware`

## Overlay modes

`FabricOverlay` routes pointer input through an OSD `MouseTracker`, and its
`OverlayMode` decides who owns the mouse:

| Mode            | OSD navigation | Fabric annotation | Pointer events go to                   |
| --------------- | -------------- | ----------------- | -------------------------------------- |
| `navigation`    | enabled        | display-only      | OSD (pan / zoom)                       |
| `annotation`    | disabled\*     | active            | Fabric (select / move / draw)          |
| `customControl` | disabled       | inert             | your registered `CustomControlHandler` |

\* In `annotation` mode, `Ctrl`/`Cmd`+drag still passes through to OSD for
panning. In `customControl` mode `Ctrl`/`Cmd`+scroll still zooms, so users don't
lose zoom while a control is engaged.

## Usage

```ts
import { FabricOverlay, DecorationLayer, createDragValueControl } from '@osdlabel/fabric-osd';

// Route pointer drags to your own handler instead of OSD or Fabric.
overlay.setCustomControlHandler(
  createDragValueControl({
    getValue: () => exposure, // read at pointer-down
    setValue: (v) => setExposure(v), // called continuously during the drag
    sensitivity: 0.01,
    step: 0.025,
    min: -1,
    max: 1,
  }),
);
overlay.setMode('customControl');
```

See the [main repository](https://github.com/osdlabel/osdlabel) for full overlay
and coordinate-system documentation.

## License

BSD-3-Clause. Part of the [osdlabel](https://github.com/osdlabel/osdlabel) monorepo.
