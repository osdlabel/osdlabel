# @osdlabel/fabric-annotations

## 0.10.1

### Patch Changes

- @osdlabel/annotation@0.10.1
- @osdlabel/annotation-context@0.10.1
- @osdlabel/viewer-api@0.10.1

## 0.10.0

### Minor Changes

- b030137: Honour `ToolConstraint.defaultStyle` in the polyline and free-hand previews, and mark vertices while drawing.

  `PolylineTool` and `FreeHandPathTool` hardcoded a translucent black dashed preview and only reached `defaultStyle` once the annotation was committed, so on dark imagery the whole drawing interaction happened blind. No vertex marker was drawn either, which left the 10px close target on the first vertex — the only route to a closed polygon — invisible.
  - Both tools now build their preview from the resolved style via the new `getPreviewOptions(style, zoom)` (exported from `@osdlabel/fabric-annotations`), the way `ShapeTool` already did. The preview stays distinguishable from a committed annotation by being unfilled and dashed; the dash pattern comes from the style's `strokeDashArray` when it sets one, otherwise from `DEFAULT_PREVIEW_DASH_SCREEN_PX`. Stroke width and dash lengths are divided by zoom, matching the screen-pixel semantics `AnnotationStyle.strokeWidth` documents — measured in image pixels they collapse to a sub-pixel hairline whenever the image is larger than its viewport.
  - The style-resolution merge moved to a shared `BaseTool.resolveStyle()`, and is re-resolved when the annotation is committed rather than reused from draw time, so switching annotation context mid-draw no longer stores a shape under one context painted in another's colour.
  - New `VertexMarkerLayer` draws a marker per clicked vertex while a polyline is in progress, with the first one a larger hollow ring that fills in once the pointer is within the close threshold. Appearance is configurable through `VertexMarkerOptions` — on the `PolylineTool` constructor, via `createAnnotationTool({ vertexMarkers })`, or as a `vertexMarkers` prop on `<Annotator>` in `@osdlabel/solid` and `@osdlabel/react`; `{ enabled: false }` turns the markers off. Radii default to `DEFAULT_VERTEX_MARKER_RADIUS_PX` / `DEFAULT_FIRST_VERTEX_MARKER_RADIUS_PX` and colours to the resolved style's `strokeColor`.
  - `AnnotationStyle` gains an optional `pointRadius`, defaulting to the new `DEFAULT_POINT_RADIUS` (5) and included in `DEFAULT_ANNOTATION_STYLE`. It is honoured by `PointTool` and by `buildFabricObjectFromGeometry`, which takes it as a new optional third argument, so imported and drawn points scale identically. Point annotations previously could not be resized at all.
  - Preview and marker objects carry no `id` and are flagged `_readOnly`. Previews previously lacked the flag, so `FabricOverlay.setMode('annotation')` would make an in-progress preview selectable.

  Additive throughout: `pointRadius` and the `buildFabricObjectFromGeometry` argument are optional, and the new `style` argument to the protected `ShapeTool.createPreview` is appended, so existing subclasses continue to compile.

### Patch Changes

- Updated dependencies [b030137]
  - @osdlabel/annotation@0.10.0
  - @osdlabel/annotation-context@0.10.0
  - @osdlabel/viewer-api@0.10.0

## 0.9.0

### Patch Changes

- @osdlabel/annotation@0.9.0
- @osdlabel/annotation-context@0.9.0
- @osdlabel/viewer-api@0.9.0

## 0.8.1

### Patch Changes

- @osdlabel/annotation@0.8.1
- @osdlabel/annotation-context@0.8.1
- @osdlabel/viewer-api@0.8.1

## 0.8.0

### Patch Changes

- @osdlabel/annotation@0.8.0
- @osdlabel/annotation-context@0.8.0
- @osdlabel/viewer-api@0.8.0

## 0.7.2

### Patch Changes

- @osdlabel/annotation@0.7.2
- @osdlabel/annotation-context@0.7.2
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
  - @osdlabel/annotation-context@0.7.1
  - @osdlabel/viewer-api@0.7.1

## 0.7.0

### Patch Changes

- Updated dependencies [49b5003]
  - @osdlabel/viewer-api@0.7.0
  - @osdlabel/annotation-context@0.7.0
  - @osdlabel/annotation@0.7.0

## 0.6.0

### Patch Changes

- Updated dependencies [3912c83]
  - @osdlabel/viewer-api@0.6.0
  - @osdlabel/annotation-context@0.6.0
  - @osdlabel/annotation@0.6.0

## 0.5.0

### Patch Changes

- @osdlabel/annotation@0.5.0
- @osdlabel/annotation-context@0.5.0
- @osdlabel/viewer-api@0.5.0

## 0.4.0

### Minor Changes

- 6fb9f49: Register the Fabric `id` custom property automatically. `FabricOverlay`'s constructor now calls `initFabricModule()`, so annotations serialize their `id` (and the overlay's clear filter works) without consumers remembering the setup call. `initFabricModule()` remains exported and is now idempotent and merge-safe — it adds `id` to any existing `customProperties` instead of overwriting them — so explicit calls and consumer-registered custom properties are both preserved.
- 6fb9f49: Add `createAnnotationFromGeometry` for seeding annotations from external geometry without the manual Fabric round-trip. The `osdlabel` umbrella (and the `@osdlabel/react` / `@osdlabel/solid` re-exports) gains `createAnnotationFromGeometry(geometry, { imageId, contextId, toolType, style?, id?, label? })`, which builds a complete `OsdAnnotation` including the Fabric `rawAnnotationData` envelope and guarantees the `id` survives serialization. `@osdlabel/fabric-annotations` exposes the underlying `buildFabricObjectFromGeometry` (the inverse of `getGeometryFromFabricObject`).

### Patch Changes

- 6fb9f49: Widen the published `fabric` and `openseadragon` peer ranges from exact pins to caret ranges (`fabric: ^7.4.0`, `openseadragon: ^5.0.1`) to reduce install friction in monorepos and shared-install setups. The `fabric` floor stays at 7.4.0 to exclude the <7.4 CVE. Dev/workspace installs remain pinned to exact versions via the default pnpm catalog; the ranges are sourced from a new named `peers` catalog used only in `peerDependencies`.
  - @osdlabel/annotation@0.4.0
  - @osdlabel/annotation-context@0.4.0
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
  - @osdlabel/annotation-context@0.3.0
  - @osdlabel/viewer-api@0.3.0

## 0.2.2

### Patch Changes

- 54f4f59: Fix point annotations being incorrectly resizable. Point annotations now have `hasControls: false` set both when first drawn and when loaded from serialized state, so they can only be moved, not scaled.
  - @osdlabel/annotation@0.2.2
  - @osdlabel/annotation-context@0.2.2
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
  - @osdlabel/annotation-context@0.2.1

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
  - @osdlabel/annotation-context@0.2.0
  - @osdlabel/viewer-api@0.2.0

## 0.1.0

### Minor Changes

- 187721c: First Beta release of osdlabel

### Patch Changes

- Updated dependencies [187721c]
  - @osdlabel/annotation@0.1.0
  - @osdlabel/annotation-context@0.1.0
  - @osdlabel/viewer-api@0.1.0
