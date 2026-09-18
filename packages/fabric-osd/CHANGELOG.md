# @osdlabel/fabric-osd

## 0.13.0

### Minor Changes

- 9b7b6a3: Add cell-anchored ("HUD") decorations (#185).

  `TextDecoration` and `DomDecoration` gain an optional `anchorSpace: 'image' | 'cell'`. The new `'cell'` space expresses `anchor` as a fraction of the cell's own size (`{x:0,y:0}` top-left, `{x:1,y:1}` bottom-right) instead of image pixels, so the decoration stays fixed in the cell's viewport through pan, zoom, rotate, and flip — ideal for a fixed readout in a corner of the view. `offset` and `placement` apply identically in both spaces.

  `TextPlacement` grows three corner values (`'top-right'`, `'bottom-left'`, `'bottom-right'`), for nine placements total, usable with either `anchorSpace`.

  Additive and backward-compatible: `anchorSpace` defaults to `'image'`, matching all existing decorations unchanged.

### Patch Changes

- Updated dependencies [9b7b6a3]
  - @osdlabel/annotation@0.13.0
  - @osdlabel/decoration@0.13.0
  - @osdlabel/fabric-annotations@0.13.0
  - @osdlabel/viewer-api@0.13.0

## 0.12.0

### Minor Changes

- 9d54b96: Identify a double click's own vertices by press sequence instead of screen distance.

  A double click delivers both of its `pointerdown`s before `onDoubleClick`, so a tool that accumulates points on press has already picked up extra vertices — two, one, or none, because a press landing on an existing annotation is suppressed and never reaches the tool, and a press may instead have closed the path. `PolylineTool` decided which case it was geometrically, measuring the last two vertices against the release point.

  That was inexact in one narrow case: with the first press suppressed _and_ the previous vertex within the first-press bound of the release, it dropped the vertex the second press placed. It also hand-composed OpenSeadragon's `clickDistThreshold` and `dblClickDistThreshold` into two constants, while `FabricOverlay` reads those off the tracker at runtime — so changing `OpenSeadragon.DEFAULT_SETTINGS.dblClickDistThreshold` moved one and not the other.

  `FabricOverlay` now stamps every forwarded `pointerdown` with a monotonic press sequence, exposed as `ToolOverlay.pressSeqOf(event)`, and passes the pair of sequences that formed the gesture as an optional third argument to `onDoubleClick`. A tool stamps each accumulated entry with the sequence that placed it, and drops the tail entry only when it carries the _second_ press's sequence and the entry before it carries the first's. That preserves the existing behaviour exactly — the path still ends at the double-clicked point, because the gesture's first press places a real vertex and only its second is redundant — while making all three counts one rule: a press that never reached the tool stamped no entry, so a gesture that contributed a single vertex leaves it alone rather than discarding a deliberate click.

  `pressSeqOf` is keyed on the synthetic event the overlay dispatches — the one a tool receives — and populated only for presses, so every other event returns `undefined`. `undefined` needs no special case: it fails the same equality check as any other non-match, so a vertex the overlay did not place is never removed.

  Both additions are optional or additive: `DoubleClickCallback` and `AnnotationTool.onDoubleClick` gain a trailing optional parameter, which existing implementations remain assignable to. `ToolOverlay` gains a required `pressSeqOf`, so a custom implementation of that interface must add it — hence minor rather than patch. Adding it is a one-liner: an overlay that does not forward presses can `return undefined`, which every consumer already has to handle, and which means "not a tracked press" — the tool then drops nothing rather than dropping the wrong thing.

  Both framework hooks relayed the double click as `(e, p) => tool.onDoubleClick?.(e, p)`, dropping the third argument, so the pair never reached the tool. Fixed in `@osdlabel/solid` and `@osdlabel/react`.

  `SECOND_PRESS_SCREEN_PX` and `FIRST_PRESS_SCREEN_PX` are gone from `@osdlabel/fabric-annotations`.

### Patch Changes

- Updated dependencies [9d54b96]
  - @osdlabel/fabric-annotations@0.12.0
  - @osdlabel/annotation@0.12.0
  - @osdlabel/decoration@0.12.0
  - @osdlabel/viewer-api@0.12.0

## 0.11.1

### Patch Changes

- 894636e: Fix touch input in annotation mode.

  `FabricOverlay` forwards each pointer event to Fabric by dispatching a synthetic `PointerEvent` on the upper canvas. That event bubbled back into the OSD `MouseTracker`'s own element, and OSD's `onPointerDown` calls `updatePointerDown` — and so `GesturePointList.addContact()` — _before_ it honours `eventInfo.stopPropagation`, so one real press was counted as two contacts. `addContact()` clamps that back for mouse and pen but not for touch, so on touch the count never reached the values OSD's handlers key off: `releaseHandler` fires only at zero contacts for a pointer pressed in our own element, so the release was never forwarded to Fabric, and `updatePointerMove` took its two-contact branch and threw computing a two-finger centre point from a gesture point that was never tracked.

  The press is now dispatched non-bubbling, which keeps it out of the tracker's element. The move and release still bubble, because Fabric binds `pointerup` on the document and relocates `pointermove` there once a press lands — making those non-bubbling would deliver the press to Fabric and never the release, which costs every gesture that commits on mouse-up: dragging an existing object and drawing a new one alike. Only `pointerdown` adds a contact, so only the press needs withholding; a doubled `pointerup` is absorbed by `removeContact()`'s floor at zero.

  Touch drawing now works, and so does the touch double tap that finishes a polyline — double-click detection runs inside `releaseHandler`, which touch could not previously reach. One further side effect worth naming: mouse and pen input no longer trips OSD's clamp, which had been logging `GesturePointList.addContact() Implausible contacts value` on every press in annotation mode.

  Touch _selection_ was never broken — Fabric commits it on the press, which was always delivered — so the bug was narrower than it appeared: touch gestures that need a release were inert, not touch as a whole. Each gesture also failed independently rather than wedging the tracker; the browser retires the touch pointer after `touchend`, and the `pointerout` / `pointerleave` that follow drive OSD's `stopTrackingPointer`, which clears the contact list.
  - @osdlabel/annotation@0.11.1
  - @osdlabel/decoration@0.11.1
  - @osdlabel/fabric-annotations@0.11.1
  - @osdlabel/viewer-api@0.11.1

## 0.11.0

### Minor Changes

- a158bf4: Make double click finish a polyline again, and add the overlay double-click event it needs.

  `PolylineTool` ended an in-progress path as an open polyline when `event.detail === 2`, but that branch could never run. Tools are driven from `pointerdown`, whose `detail` is 0 by specification, so double click did nothing at all — leaving Enter and the close target as the only ways to end a path (#168).

  Double clicks cannot come from Fabric here. Fabric's `mouse:dblclick` is raised from a native `dblclick` listener on the upper canvas, but that canvas is `pointerEvents: 'none'` and all input is routed through an OSD `MouseTracker`, so the browser's own `dblclick` targets the container and the upper canvas only ever sees synthetic pointer events.
  - `FabricOverlay` gains `onDoubleClick(callback)`, returning an unsubscribe function. It pairs consecutive releases using the tracker's own `clickTimeThreshold` / `clickDistThreshold` / `dblClickTimeThreshold` / `dblClickDistThreshold` rather than redeclaring them. Subscribing resets the pairing, so a click made under a previous tool cannot pair with the first click under the next one.
  - `AnnotationTool` gains `onDoubleClick(event, imagePoint)`, defaulting to a no-op on `BaseTool`. Custom tools implementing the interface directly will need it; those extending `BaseTool` are unaffected.
  - Both framework `useAnnotationTool` hooks route the overlay event to the active tool.

  Note for anyone implementing `AnnotationTool` directly: a double click still delivers both of its `pointerdown`s before `onDoubleClick`, so a tool that accumulates points on press may have picked up two extra vertices — or one, or none, since a press landing on an existing annotation is suppressed and never reaches the tool. `PolylineTool` decides which case it is geometrically, using two screen-space bounds derived from OpenSeadragon's click thresholds.

### Patch Changes

- Updated dependencies [a158bf4]
  - @osdlabel/fabric-annotations@0.11.0
  - @osdlabel/annotation@0.11.0
  - @osdlabel/decoration@0.11.0
  - @osdlabel/viewer-api@0.11.0

## 0.10.1

### Patch Changes

- @osdlabel/annotation@0.10.1
- @osdlabel/decoration@0.10.1
- @osdlabel/fabric-annotations@0.10.1
- @osdlabel/viewer-api@0.10.1

## 0.10.0

### Patch Changes

- Updated dependencies [b030137]
  - @osdlabel/annotation@0.10.0
  - @osdlabel/fabric-annotations@0.10.0
  - @osdlabel/decoration@0.10.0
  - @osdlabel/viewer-api@0.10.0

## 0.9.0

### Patch Changes

- @osdlabel/annotation@0.9.0
- @osdlabel/decoration@0.9.0
- @osdlabel/fabric-annotations@0.9.0
- @osdlabel/viewer-api@0.9.0

## 0.8.1

### Patch Changes

- @osdlabel/annotation@0.8.1
- @osdlabel/decoration@0.8.1
- @osdlabel/fabric-annotations@0.8.1
- @osdlabel/viewer-api@0.8.1

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
