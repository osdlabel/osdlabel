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
- `PolyVertexEditor` — interactive vertex editing for polygon / polyline
  annotations, plus `DEFAULT_VERTEX_EDIT_LONG_PRESS_MS` and
  `DEFAULT_VERTEX_EDIT_MOVE_TOLERANCE_PX`
- `initFabricModule` — registers custom serialized properties on Fabric objects
- Serialization helpers: `serializeFabricObject`, `deserializeFabricObject`,
  `createFabricObjectFromRawData`, `getGeometryFromFabricObject`,
  `getFabricOptions`
- `buildFabricObjectFromGeometry` — rebuilds a Fabric object from annotation
  geometry (used when an annotation's geometry changes type, e.g. circle →
  rectangle)
- `FabricRawAnnotationData` and the `FabricFields` extension interface

## Vertex editing

`PolyVertexEditor` builds on Fabric v7's native poly controls
(`controlsUtils.createPolyControls`) and adds three things on top: a configurable
**long-press** to enter a sticky edit mode (tablet-friendly), **edge-insertion**
handles at edge midpoints that splice in a new vertex and continue the same
drag, and **vertex deletion** via `Delete`/`Backspace`, honoring per-shape
minimums (3 points for a polygon, 2 for a polyline).

It is owned by the Select, Polyline, and free-draw tools, so it is active
automatically — vertex moves commit through the same `object:modified` →
`getGeometryFromFabricObject` path as any other edit. Tune the gesture through
`SelectTool`'s constructor, or through the `vertexEditLongPressMs` /
`vertexEditMoveTolerancePx` props on the framework `Annotator`.

## Usage

```ts
import { initFabricModule } from '@osdlabel/fabric-annotations';

// Optional: `FabricOverlay` calls this on construction, so most consumers never
// need it. It stays exported (and idempotent) for setups that build Fabric
// objects before any overlay exists. The `id` entry is merged into existing
// `customProperties`, so consumer-registered properties are preserved.
initFabricModule();
```

## License

BSD-3-Clause. Part of the [osdlabel](https://github.com/osdlabel/osdlabel) monorepo.
