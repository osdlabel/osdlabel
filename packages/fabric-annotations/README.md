# @osdlabel/fabric-annotations

[Fabric.js](http://fabricjs.com/) v7 annotation tools and utilities for
[osdlabel](https://github.com/osdlabel/osdlabel), a web-based image annotation
library for gigapixel/DZI images.

SolidJS-agnostic and OpenSeaDragon-agnostic — tools depend on the `ToolOverlay`
interface rather than any concrete overlay. Depends on `@osdlabel/annotation`,
`@osdlabel/annotation-context`, and `@osdlabel/viewer-api`, with `fabric` as a
peer dependency.

## Installation

```bash
npm install @osdlabel/fabric-annotations fabric
```

## What's inside

- Drawing tools: `RectangleTool`, `CircleTool`, `LineTool`, `PointTool`,
  `PolylineTool`, `FreeHandPathTool`, `SelectTool` (plus `BaseTool` / `ShapeTool`
  base classes) and the `ToolOverlay` interface
- `initFabricModule` — registers custom serialized properties on Fabric objects
- Serialization helpers: `serializeFabricObject`, `deserializeFabricObject`,
  `createFabricObjectFromRawData`, `getGeometryFromFabricObject`,
  `getFabricOptions`
- `FabricRawAnnotationData` and the `FabricFields` extension interface

## Usage

```ts
import { initFabricModule } from '@osdlabel/fabric-annotations';

// Call once before creating any annotations so custom properties serialize.
initFabricModule();
```

## License

BSD-3-Clause. Part of the [osdlabel](https://github.com/osdlabel/osdlabel) monorepo.
