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
  `overlayElement`, and flip-aware `imageToScreen` / `screenToImage`
- `DecorationLayer` — renders text decorations as positioned DOM elements and
  connector lines as non-interactive Fabric objects
- Pure helpers: `computeViewportTransform`, `imageToScreenFlipAware`,
  `screenToImageFlipAware`

## Usage

```ts
import { FabricOverlay, DecorationLayer } from '@osdlabel/fabric-osd';
```

See the [main repository](https://github.com/osdlabel/osdlabel) for full overlay
and coordinate-system documentation.

## License

BSD-3-Clause. Part of the [osdlabel](https://github.com/osdlabel/osdlabel) monorepo.
