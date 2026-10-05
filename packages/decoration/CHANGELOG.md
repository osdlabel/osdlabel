# @osdlabel/decoration

## 0.21.0

### Patch Changes

- Updated dependencies [b829f81]
  - @osdlabel/viewer-api@0.21.0
  - @osdlabel/annotation@0.21.0
  - @osdlabel/geometry@0.21.0

## 0.20.0

### Patch Changes

- @osdlabel/annotation@0.20.0
- @osdlabel/geometry@0.20.0
- @osdlabel/viewer-api@0.20.0

## 0.19.2

### Patch Changes

- @osdlabel/annotation@0.19.2
- @osdlabel/geometry@0.19.2
- @osdlabel/viewer-api@0.19.2

## 0.19.1

### Patch Changes

- @osdlabel/annotation@0.19.1
- @osdlabel/geometry@0.19.1
- @osdlabel/viewer-api@0.19.1

## 0.19.0

### Patch Changes

- @osdlabel/annotation@0.19.0
- @osdlabel/geometry@0.19.0
- @osdlabel/viewer-api@0.19.0

## 0.18.0

### Patch Changes

- @osdlabel/annotation@0.18.0
- @osdlabel/geometry@0.18.0
- @osdlabel/viewer-api@0.18.0

## 0.17.0

### Patch Changes

- @osdlabel/annotation@0.17.0
- @osdlabel/geometry@0.17.0
- @osdlabel/viewer-api@0.17.0

## 0.16.0

### Minor Changes

- 7955609: Measure lengths, perimeters and distances per axis, so they are correct on anisotropic images (#187).

  `createMeasurementProvider` and `createDistanceProvider` converted every length with the _mean_ pixel spacing, `(x + y) / 2`. That is exact only when `x = y`. On an image with 0.1 mm/px horizontally and 0.2 mm/px vertically, a horizontal and a vertical 100 px line were both labelled "15.00 mm"; they are 10 mm and 20 mm.

  Each segment is now converted per axis, `hypot(dx · x, dy · y)`, which is exact at any angle:
  - **`L:`** for lines and polylines (summed per segment).
  - **`P:`** for polygons and rectangles, rotated rectangles included (per edge). A circle is physically an ellipse when `x ≠ y`, so its perimeter uses Ramanujan's ellipse formula: exact for isotropic spacing, and within 1e-6 relative at a 1:5 spacing ratio.
  - **The distance provider's label**, between the two centroids.

  Unchanged: areas (already `x · y`), and **circle radius `r:`**, which keeps the mean spacing because an ellipse has no single radius. On isotropic images, and on images without spacing, every label is the same as before.

  **Labels on anisotropic images change value.** This is a correction, but anything that compared against the old numbers (snapshots, exported reports) will see the difference.

  New exports, which the built-in providers now use, so custom providers and derived values (such as a ratio between two measured lines) can agree with the built-in labels:
  - `measureDistance(a, b, spacing)`: the distance between two image-pixel points.
  - `measureLength(geometry, spacing)`: open-curve length, mirroring `length`.
  - `measurePerimeter(geometry, spacing)`: closed perimeter, mirroring `perimeter`.

  Each returns a `Measurement`, in `px` when `spacing` is `undefined`. `toPhysicalLength` is unchanged. A scalar has lost its direction, so it cannot be converted per axis; its docs now point to the functions above for segments.

### Patch Changes

- @osdlabel/annotation@0.16.0
- @osdlabel/geometry@0.16.0
- @osdlabel/viewer-api@0.16.0

## 0.15.0

### Minor Changes

- 68d3ddf: Make bare `Annotation` constructible: its default extension is now `Record<never, never>` instead of `Record<string, never>` (#165).

  `Record<string, never>` is an index signature that maps _every_ key to `never`, so in `BaseAnnotation & Record<string, never>` each field intersected with `never`. The type advertised as "no extensions" could be read, but no object literal could satisfy it:

  ```ts
  const a: Annotation = { id, geometry, toolType: 'point', createdAt, updatedAt };
  // error TS2322: Type 'AnnotationId' is not assignable to type 'never'.
  ```

  `Omit<Annotation, 'createdAt' | 'updatedAt'>` degenerated the same way, to `{ [k: string]: never }`.

  `Record<never, never>` is a mapped type over no keys, so bare `Annotation` is now structurally `BaseAnnotation`. Excess-property checks on fresh literals still apply, and an explicit extension (`Annotation<MyFields>`) still requires its fields.

  **Building and assigning values only gets looser**: anything assignable to bare `Annotation` before still is, and values that carry extension fields are now assignable to it too.

  **Reading arbitrary keys is now a type error.** The old index signature let any key through, typed `never`. With real keys only, code that relied on it stops compiling:
  - `annotation.whatever` on bare `Annotation`: TS2339, where it used to compile as `never`.
  - `for (const k in annotation) annotation[k]`: TS7053, since `k` is a `string` that no longer indexes the type.
  - `keyof Annotation` narrows from `string` to the real field names, so a `keyof Annotation` variable holding any other string fails.

  These reads were typed `never`, so code relying on them compiled without real type checking; it now needs an explicit extension or a cast. The `for…in` form is the one most likely to bite: a generic clone or serializer such as `for (const k in a) out[k] = a[k]` copies real values at runtime, and because `never` is assignable to anything it type-checked without complaint. Hence a minor bump rather than a patch. Code that uses an explicit extension, `Annotation<MyFields>`, is unaffected.

  The same default is updated on every generic that carried it: `AnnotationState`, `getAllAnnotationsFlat`, `DecorationContext`, `DecorationProvider`, `composeProviders`, `withSelectionEmphasis`, `createMeasurementProvider`, `createLabelProvider`, `createDistanceProvider`, `AnnotationPair`, `DistanceProviderOptions`, `DeserializeResult`, `LiveDecorationUpdateOptions` and `enableLiveDecorationUpdates`.

### Patch Changes

- Updated dependencies [68d3ddf]
  - @osdlabel/annotation@0.15.0
  - @osdlabel/viewer-api@0.15.0
  - @osdlabel/geometry@0.15.0

## 0.14.0

### Patch Changes

- @osdlabel/annotation@0.14.0
- @osdlabel/geometry@0.14.0
- @osdlabel/viewer-api@0.14.0

## 0.13.0

### Minor Changes

- 9b7b6a3: Add cell-anchored ("HUD") decorations (#185).

  `TextDecoration` and `DomDecoration` gain an optional `anchorSpace: 'image' | 'cell'`. The new `'cell'` space expresses `anchor` as a fraction of the cell's own size (`{x:0,y:0}` top-left, `{x:1,y:1}` bottom-right) instead of image pixels, so the decoration stays fixed in the cell's viewport through pan, zoom, rotate, and flip — ideal for a fixed readout in a corner of the view. `offset` and `placement` apply identically in both spaces.

  `TextPlacement` grows three corner values (`'top-right'`, `'bottom-left'`, `'bottom-right'`), for nine placements total, usable with either `anchorSpace`.

  Additive and backward-compatible: `anchorSpace` defaults to `'image'`, matching all existing decorations unchanged.

### Patch Changes

- Updated dependencies [9b7b6a3]
  - @osdlabel/annotation@0.13.0
  - @osdlabel/geometry@0.13.0
  - @osdlabel/viewer-api@0.13.0

## 0.12.0

### Patch Changes

- @osdlabel/annotation@0.12.0
- @osdlabel/geometry@0.12.0
- @osdlabel/viewer-api@0.12.0

## 0.11.1

### Patch Changes

- @osdlabel/annotation@0.11.1
- @osdlabel/geometry@0.11.1
- @osdlabel/viewer-api@0.11.1

## 0.11.0

### Patch Changes

- @osdlabel/annotation@0.11.0
- @osdlabel/geometry@0.11.0
- @osdlabel/viewer-api@0.11.0

## 0.10.1

### Patch Changes

- @osdlabel/annotation@0.10.1
- @osdlabel/geometry@0.10.1
- @osdlabel/viewer-api@0.10.1

## 0.10.0

### Patch Changes

- Updated dependencies [b030137]
  - @osdlabel/annotation@0.10.0
  - @osdlabel/geometry@0.10.0
  - @osdlabel/viewer-api@0.10.0

## 0.9.0

### Patch Changes

- @osdlabel/annotation@0.9.0
- @osdlabel/geometry@0.9.0
- @osdlabel/viewer-api@0.9.0

## 0.8.1

### Patch Changes

- @osdlabel/annotation@0.8.1
- @osdlabel/geometry@0.8.1
- @osdlabel/viewer-api@0.8.1

## 0.8.0

### Patch Changes

- @osdlabel/annotation@0.8.0
- @osdlabel/geometry@0.8.0
- @osdlabel/viewer-api@0.8.0

## 0.7.2

### Patch Changes

- @osdlabel/annotation@0.7.2
- @osdlabel/geometry@0.7.2
- @osdlabel/viewer-api@0.7.2

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
  - @osdlabel/geometry@0.7.1
  - @osdlabel/viewer-api@0.7.1

## 0.7.0

### Patch Changes

- Updated dependencies [49b5003]
  - @osdlabel/viewer-api@0.7.0
  - @osdlabel/annotation@0.7.0
  - @osdlabel/geometry@0.7.0

## 0.6.0

### Patch Changes

- Updated dependencies [3912c83]
  - @osdlabel/viewer-api@0.6.0
  - @osdlabel/annotation@0.6.0
  - @osdlabel/geometry@0.6.0

## 0.5.0

### Patch Changes

- Updated dependencies [c77c661]
  - @osdlabel/geometry@0.5.0
  - @osdlabel/annotation@0.5.0
  - @osdlabel/viewer-api@0.5.0

## 0.4.0

### Patch Changes

- @osdlabel/annotation@0.4.0
- @osdlabel/viewer-api@0.4.0

## 0.3.0

### Minor Changes

- dea4e63: Add a `customControl` overlay mode that forwards mouse click/drag input to a registered handler instead of OpenSeadragon or the Fabric annotation layer.
  - `FabricOverlay` gains the `customControl` mode, a `CustomControlHandler` contract, and `setCustomControlHandler()`. A `setMode` no-op guard prevents redundant re-applies from clobbering an in-progress gesture.
  - New framework-agnostic `createDragValueControl()` helper maps drag distance onto a clamped numeric value, reusable for any drag-driven viewer function.
  - New `UIState.activeViewerControl` (`ViewerControlId`) field, mutually exclusive with `activeTool`, drives the mode via the single existing mode-authority effect in both the SolidJS and React `useAnnotationTool` hooks.
  - `ViewControls` (Solid + React) gains a drag-to-adjust-exposure toggle button as the first use case.

### Patch Changes

- Updated dependencies [dea4e63]
  - @osdlabel/annotation@0.3.0
  - @osdlabel/viewer-api@0.3.0

## 0.2.2

### Patch Changes

- @osdlabel/annotation@0.2.2
- @osdlabel/viewer-api@0.2.2

## 0.2.1

### Patch Changes

- df01e5a: Add and expand per-package README files so each package shows relevant
  documentation on its npm page, and refresh the root README to cover decorations,
  measurements, view controls, and the full package layout.

  Also drop the unused `@osdlabel/validation` dependency and `valibot` peer
  dependency from `@osdlabel/fabric-osd` — neither is referenced by the package,
  so consumers no longer need to install `valibot` to use it.

- Updated dependencies [df01e5a]
  - @osdlabel/annotation@0.2.1
  - @osdlabel/viewer-api@0.2.1

## 0.2.0

### Minor Changes

- 2acbf8a: Add DOM decorations: framework-rendered rich annotation decorations.

  A new `DomDecoration` variant joins the `Decoration` union (alongside text and
  line). It exposes a positioned `<div>` root whose screen position and transforms
  are managed entirely by the Fabric/OSD `DecorationLayer`, while a UI framework
  renders an arbitrary component tree into it via its native portal — so the
  rendered tree shares the host app's context (state, theme, hooks). This enables
  interactive popovers, mini-forms, and charts attached to annotations.
  - `@osdlabel/decoration`: new `DomDecoration` + `DomDecorationStyle` types
    (framework-agnostic, `content: unknown`). Interactive by default
    (`pointer-events: auto`), configurable to `'none'`.
  - `@osdlabel/fabric-osd`: `DecorationLayer` creates, positions, and owns the DOM
    roots (id-stable diffing, unified positioning with text decorations), and
    exposes `onDomDecorations` — a subscription that fires on membership change
    only, so portals never thrash during pan/zoom/drag. Entry identity is stable
    so SolidJS `<For>` reuses rows. `content` is stable config; dynamic data flows
    through the app's own reactivity inside the mounted component.
  - `@osdlabel/react` / `@osdlabel/solid`: new `renderDomDecoration` prop on the
    annotator wires the bridge (React `createPortal`, Solid `<Portal>`).

  Also includes a prior dependency-maintenance chore: project dependencies were
  updated, notably patching the vulnerable `fabric` 7.2.0 to 7.4.0.

### Patch Changes

- Updated dependencies [2acbf8a]
  - @osdlabel/annotation@0.2.0
  - @osdlabel/viewer-api@0.2.0

## 0.1.0

### Minor Changes

- 187721c: First Beta release of osdlabel

### Patch Changes

- Updated dependencies [187721c]
  - @osdlabel/annotation@0.1.0
  - @osdlabel/viewer-api@0.1.0
