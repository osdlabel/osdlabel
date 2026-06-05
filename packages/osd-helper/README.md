# @osdlabel/osd-helper

OpenSeaDragon utility functions for
[osdlabel](https://github.com/osdlabel/osdlabel), a web-based image annotation
library for gigapixel/DZI images.

Depends on `@osdlabel/annotation` and `@osdlabel/viewer-api`, with `openseadragon`
as a peer dependency.

## Installation

```bash
npm install @osdlabel/osd-helper openseadragon
```

## What's inside

- `openImage(viewer, source)` — opens an `ImageSource` in an OpenSeaDragon viewer,
  automatically detecting plain image URLs (by extension) versus DZI / tiled
  sources.

## Usage

```ts
import { openImage } from '@osdlabel/osd-helper';

// Simple image URLs (.jpg, .png, .webp, ...) open with { type: 'image' };
// everything else is passed through to viewer.open() as a tile source.
openImage(viewer, {
  id: createImageId('slide-1'),
  tileSource: 'https://example.com/slides/slide-1.dzi',
  label: 'Slide 1',
});
```

## License

BSD-3-Clause. Part of the [osdlabel](https://github.com/osdlabel/osdlabel) monorepo.
