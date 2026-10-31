# @osdlabel/geometry

## 0.22.0

### Minor Changes

- 83ad4d4: Rectangles are painted where their geometry says.

  Fabric 7 places an object by its centre unless an origin is set, and the rectangle tool and `buildFabricObjectFromGeometry` never set one. So every rectangle was painted centred on the corner its geometry records, half its size up and to the left of the drag, and labels, measurements and exports computed from the geometry landed away from what the user saw. Rectangles are now built and read by their centre, and `getGeometryFromFabricObject` derives the corner from the object's centre, whatever origin it carries.

  **What a rectangle's geometry means**, now written on `RectangleGeometry`: `origin`, `width` and `height` are the box before rotation, and `rotation` turns that box about its centre, `origin + (width / 2, height / 2)`. So rotating a rectangle changes only its `rotation`, and the new `rectangleCorners` (in `@osdlabel/geometry`, re-exported by `@osdlabel/decoration`, `osdlabel` and both bindings) gives the corners of the shape it describes. **Behaviour change:** earlier releases' `centroid` and `boundingBox` turned a rotated rectangle about `origin` instead; they now turn it about its centre, as the editor does. Unrotated rectangles are unaffected. Earlier releases read `origin` back as the centre the rectangle was painted at; on a rectangle never edited, that point is also the top-left corner of the drag.

  **Rectangles saved by earlier releases** (0.21.0 and before) still paint where users saw them, since their saved Fabric data is what is drawn. Their geometry is loaded as saved, so it stays half the rectangle's size from the shape on screen until the rectangle is next edited, when it is read back from the shape's centre. `deserialize` does not change it. To correct such rectangles on load, pass each loaded annotation through the new `migrateLegacyRectangle`. It recomputes an earlier release's rectangle's geometry from where it is painted, and returns anything else unchanged. It is opt-in and tree-shakeable, exported from `@osdlabel/fabric-annotations` (also as `@osdlabel/fabric-annotations/legacy-rectangle`), `osdlabel` and both bindings.

### Patch Changes

- Updated dependencies [83ad4d4]
  - @osdlabel/annotation@0.22.0

## 0.21.0

### Patch Changes

- @osdlabel/annotation@0.21.0

## 0.20.0

### Patch Changes

- @osdlabel/annotation@0.20.0

## 0.19.2

### Patch Changes

- @osdlabel/annotation@0.19.2

## 0.19.1

### Patch Changes

- @osdlabel/annotation@0.19.1

## 0.19.0

### Patch Changes

- @osdlabel/annotation@0.19.0

## 0.18.0

### Patch Changes

- @osdlabel/annotation@0.18.0

## 0.17.0

### Patch Changes

- @osdlabel/annotation@0.17.0

## 0.16.0

### Patch Changes

- @osdlabel/annotation@0.16.0

## 0.15.0

### Patch Changes

- Updated dependencies [68d3ddf]
  - @osdlabel/annotation@0.15.0

## 0.14.0

### Patch Changes

- @osdlabel/annotation@0.14.0

## 0.13.0

### Minor Changes

- 9b7b6a3: Add cell-anchored ("HUD") decorations (#185).

  `TextDecoration` and `DomDecoration` gain an optional `anchorSpace: 'image' | 'cell'`. The new `'cell'` space expresses `anchor` as a fraction of the cell's own size (`{x:0,y:0}` top-left, `{x:1,y:1}` bottom-right) instead of image pixels, so the decoration stays fixed in the cell's viewport through pan, zoom, rotate, and flip — ideal for a fixed readout in a corner of the view. `offset` and `placement` apply identically in both spaces.

  `TextPlacement` grows three corner values (`'top-right'`, `'bottom-left'`, `'bottom-right'`), for nine placements total, usable with either `anchorSpace`.

  Additive and backward-compatible: `anchorSpace` defaults to `'image'`, matching all existing decorations unchanged.

### Patch Changes

- Updated dependencies [9b7b6a3]
  - @osdlabel/annotation@0.13.0

## 0.12.0

### Patch Changes

- @osdlabel/annotation@0.12.0

## 0.11.1

### Patch Changes

- @osdlabel/annotation@0.11.1

## 0.11.0

### Patch Changes

- @osdlabel/annotation@0.11.0

## 0.10.1

### Patch Changes

- @osdlabel/annotation@0.10.1

## 0.10.0

### Patch Changes

- Updated dependencies [b030137]
  - @osdlabel/annotation@0.10.0

## 0.9.0

### Patch Changes

- @osdlabel/annotation@0.9.0

## 0.8.1

### Patch Changes

- @osdlabel/annotation@0.8.1

## 0.8.0

### Patch Changes

- @osdlabel/annotation@0.8.0

## 0.7.2

### Patch Changes

- @osdlabel/annotation@0.7.2

## 0.7.1

### Patch Changes

- ee551bd: Bring every README up to date with the features shipped since they were last written, and republish so the new content reaches npm.
  - Add the missing README for `@osdlabel/geometry`, the package the geometry math and `circleToBoundingRectangle` moved into. The root README's package layout lists it too.
  - Document what's new: polygon/polyline vertex editing (`PolyVertexEditor`), circle→rectangle conversion, per-cell `contrast` alongside `exposure`/`inverted`, the `customControl` overlay mode with its `createDragValueControl` / `createDragVectorControl` factories, `ViewerControlId` / `VIEWER_CONTROL_SPECS`, and `.` / `,` context cycling.
  - Drop `initFabricModule()` from every quick start — `FabricOverlay` now calls it on construction. The call stays documented as the escape hatch for building Fabric objects before an overlay exists.
  - Fix inaccuracies: `composeProviders` takes an array (not varargs) and `createMeasurementProvider` requires an options object, so the decoration examples did not compile; the geometry union member is `polygon`, not `path`; and the `@osdlabel/solid` / `@osdlabel/react` install commands no longer list `valibot`, which is not a peer dependency of either.
  - Replace the root README's keyboard table with the actual `DEFAULT_KEYBOARD_SHORTCUTS`, which had drifted — the polyline tool is `d` and freehand is `f`, and the `Shift`-modified view/tone bindings were missing entirely.

- Updated dependencies [ee551bd]
  - @osdlabel/annotation@0.7.1

## 0.7.0

### Patch Changes

- @osdlabel/annotation@0.7.0

## 0.6.0

### Patch Changes

- @osdlabel/annotation@0.6.0

## 0.5.0

### Minor Changes

- c77c661: Add circle→rectangle conversion and interactive polygon/polyline vertex editing.
  - Convert a selected circle to its axis-aligned bounding rectangle via a contextual, constraint-aware "Convert to Rect" toolbar button, backed by the pure `circleToBoundingRectangle` helper.
  - Edit polygon/polyline vertices: a configurable long-press enters a sticky edit mode with per-vertex move handles and edge-midpoint insertion handles; Delete/Backspace removes a vertex (min 3 polygon / 2 polyline). Reachable from the Select, Polyline, and Free-draw tools; long-press timing/tolerance are Annotator-level options.
  - New `@osdlabel/geometry` package holds the geometry math and conversions; `@osdlabel/decoration` re-exports the math so the public API is unchanged.

### Patch Changes

- @osdlabel/annotation@0.5.0
