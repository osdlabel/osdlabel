# @osdlabel/fabric-osd

## 0.8.0

### Patch Changes

- b6b4e3d: Fix overlay behaviour around zooming and container resizes
  - **Ctrl/Cmd+scroll now anchors the zoom at the pointer.** The handler passed
    `clientX`/`clientY` to `viewport.pointFromPixel`, which expects a pixel
    relative to the viewer element, so the anchor was off by wherever the viewer
    sat in the window and the view drifted away from the cursor as you zoomed.
    The anchor is also mirrored under horizontal flip now, matching what OSD's
    own `onCanvasScroll` does — a flipped cell previously zoomed toward the
    mirror image of the cursor.
  - **A purely horizontal wheel no longer zooms out.** `-0 > 0` is false, so a
    trackpad shear or tilt wheel with Ctrl held was read as "scroll down".
  - **Fabric's `devicePixelRatio` is resynced before the canvas is resized.**
    Fabric captures `window.devicePixelRatio` once, at module evaluation, and
    never re-reads it; OSD re-reads its own on window resize. After a
    display-scale change that left crisp tiles under a soft annotation overlay.
    Changes that do not alter the container's CSS size — dragging a window
    between monitors — are picked up with a re-arming `(resolution: Ndppx)`
    media query.
  - **The overlay repaints from settled bounds after a resize.** OSD raises
    `resize` before `fitBounds` and before its follow-up pan/zoom, so the paint
    moved to `after-resize`; re-measuring the canvas stays on `resize`, where
    the container size is already current.

  New exports: `computeScrollZoom`, `mirrorScreenX`, `syncFabricDevicePixelRatio`,
  `observeDevicePixelRatio`, and their supporting types.
  - @osdlabel/annotation@0.8.0
  - @osdlabel/decoration@0.8.0
  - @osdlabel/fabric-annotations@0.8.0
  - @osdlabel/viewer-api@0.8.0

## 0.7.2

### Patch Changes

- @osdlabel/annotation@0.7.2
- @osdlabel/decoration@0.7.2
- @osdlabel/fabric-annotations@0.7.2
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
  - @osdlabel/decoration@0.7.1
  - @osdlabel/fabric-annotations@0.7.1
  - @osdlabel/viewer-api@0.7.1

## 0.7.0

### Patch Changes

- Updated dependencies [49b5003]
  - @osdlabel/viewer-api@0.7.0
  - @osdlabel/decoration@0.7.0
  - @osdlabel/fabric-annotations@0.7.0
  - @osdlabel/annotation@0.7.0

## 0.6.0

### Minor Changes

- 3912c83: Add per-cell contrast control alongside the existing brightness (exposure) control.
  - `CellTransform` gains `contrast` (−1…1, `0` = unchanged, mapped to CSS `contrast(0…2)`), with new `INCREASE_CONTRAST` / `DECREASE_CONTRAST` / `SET_CONTRAST` UI actions and `increaseActiveImageContrast` / `decreaseActiveImageContrast` / `setActiveImageContrast` on both framework action sets.
  - `ViewControls` (Solid + React) gains decrease / value / increase buttons for contrast; `Reset` now also clears contrast. New shortcuts: `Shift+C` (increase) and `Shift+X` (decrease).
  - **One unified drag control for both tonal axes.** A single toggle arms `tone`: horizontal drag adjusts exposure (left = brighter), vertical drag adjusts contrast (up = more contrast). Drag diagonally to change both in one gesture, or along a single axis to change just that one — no switching between controls. **Breaking:** `ViewerControlId` is now `'tone'`, replacing `'exposure'`; callers passing `'exposure'` to `setActiveViewerControl` must pass `'tone'`.
  - New `createDragVectorControl` drives one value per axis in a single gesture, with per-axis sensitivity, step, clamp, direction and redundant-write suppression (so a horizontal-only drag never writes the vertical value). `createDragValueControl` keeps its single-axis API and now shares the same per-axis math.
  - `createDragValueControl` also gains an `invert` option that reverses the axis's default direction (x rightward, y upward), so direction stays separable from the sensitivity magnitude.
  - The drag parameters live in the new shared `VIEWER_CONTROL_SPECS` registry — now per-axis, each axis naming the `CellTransform` field it drives — so Solid and React behave identically.
  - **Breaking (low-level API):** `FabricOverlay.applyImageFilters` now takes a single object — `applyImageFilters({ exposure, contrast, inverted })` — instead of positional `(exposure, inverted)` arguments. The filter string itself is composed by the newly exported pure helper `composeImageFilterCss`, which emits `brightness()`, then `contrast()`, then `invert()`.

### Patch Changes

- Updated dependencies [3912c83]
  - @osdlabel/viewer-api@0.6.0
  - @osdlabel/decoration@0.6.0
  - @osdlabel/fabric-annotations@0.6.0
  - @osdlabel/annotation@0.6.0

## 0.5.0

### Patch Changes

- @osdlabel/decoration@0.5.0
- @osdlabel/annotation@0.5.0
- @osdlabel/fabric-annotations@0.5.0
- @osdlabel/viewer-api@0.5.0

## 0.4.0

### Minor Changes

- 6fb9f49: Register the Fabric `id` custom property automatically. `FabricOverlay`'s constructor now calls `initFabricModule()`, so annotations serialize their `id` (and the overlay's clear filter works) without consumers remembering the setup call. `initFabricModule()` remains exported and is now idempotent and merge-safe — it adds `id` to any existing `customProperties` instead of overwriting them — so explicit calls and consumer-registered custom properties are both preserved.

### Patch Changes

- 6fb9f49: Widen the published `fabric` and `openseadragon` peer ranges from exact pins to caret ranges (`fabric: ^7.4.0`, `openseadragon: ^5.0.1`) to reduce install friction in monorepos and shared-install setups. The `fabric` floor stays at 7.4.0 to exclude the <7.4 CVE. Dev/workspace installs remain pinned to exact versions via the default pnpm catalog; the ranges are sourced from a new named `peers` catalog used only in `peerDependencies`.
- Updated dependencies [6fb9f49]
- Updated dependencies [6fb9f49]
- Updated dependencies [6fb9f49]
  - @osdlabel/fabric-annotations@0.4.0
  - @osdlabel/annotation@0.4.0
  - @osdlabel/decoration@0.4.0
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
  - @osdlabel/decoration@0.3.0
  - @osdlabel/fabric-annotations@0.3.0
  - @osdlabel/viewer-api@0.3.0

## 0.2.2

### Patch Changes

- Updated dependencies [54f4f59]
  - @osdlabel/fabric-annotations@0.2.2
  - @osdlabel/annotation@0.2.2
  - @osdlabel/decoration@0.2.2
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
  - @osdlabel/decoration@0.2.1
  - @osdlabel/fabric-annotations@0.2.1

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
  - @osdlabel/decoration@0.2.0
  - @osdlabel/fabric-annotations@0.2.0
  - @osdlabel/validation@0.2.0
  - @osdlabel/viewer-api@0.2.0

## 0.1.0

### Minor Changes

- 187721c: First Beta release of osdlabel

### Patch Changes

- Updated dependencies [187721c]
  - @osdlabel/annotation@0.1.0
  - @osdlabel/decoration@0.1.0
  - @osdlabel/fabric-annotations@0.1.0
  - @osdlabel/validation@0.1.0
  - @osdlabel/viewer-api@0.1.0
