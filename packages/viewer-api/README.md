# @osdlabel/viewer-api

Viewer state types and utilities for [osdlabel](https://github.com/osdlabel/osdlabel),
a web-based image annotation library for gigapixel/DZI images.

Depends only on `@osdlabel/annotation`. No framework dependencies.

## Installation

```bash
npm install @osdlabel/viewer-api
```

## What's inside

- `ImageId` (branded id), `createImageId`, `ImageIdFields` extension interface
- `ImageSource` — describes a tile source / image to annotate
- `PixelSpacing` — physical calibration for measurements
- `AnnotationState<E>` and `getAllAnnotationsFlat`
- `CellTransform`, `DEFAULT_CELL_TRANSFORM` — per-cell pan/zoom/rotate/flip state
- `UIState`, `KeyboardShortcutMap`

## Usage

```ts
import {
  type ImageSource,
  type AnnotationState,
  createImageId,
  getAllAnnotationsFlat,
} from '@osdlabel/viewer-api';

const image: ImageSource = {
  id: createImageId('slide-1'),
  tileSource: 'https://example.com/slides/slide-1.dzi',
  label: 'Slide 1',
};
```

## License

BSD-3-Clause. Part of the [osdlabel](https://github.com/osdlabel/osdlabel) monorepo.
