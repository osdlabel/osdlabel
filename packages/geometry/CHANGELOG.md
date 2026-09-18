# @osdlabel/geometry

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
