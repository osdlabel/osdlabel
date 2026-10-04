# osdlabel

## 0.20.0

### Patch Changes

- @osdlabel/annotation@0.20.0
- @osdlabel/annotation-context@0.20.0
- @osdlabel/decoration@0.20.0
- @osdlabel/fabric-annotations@0.20.0
- @osdlabel/fabric-osd@0.20.0
- @osdlabel/geometry@0.20.0
- @osdlabel/validation@0.20.0
- @osdlabel/viewer-api@0.20.0

## 0.19.2

### Patch Changes

- @osdlabel/annotation@0.19.2
- @osdlabel/annotation-context@0.19.2
- @osdlabel/decoration@0.19.2
- @osdlabel/fabric-annotations@0.19.2
- @osdlabel/fabric-osd@0.19.2
- @osdlabel/geometry@0.19.2
- @osdlabel/validation@0.19.2
- @osdlabel/viewer-api@0.19.2

## 0.19.1

### Patch Changes

- 7b92ff1: Re-assigning the image a cell already shows no longer resets the cell's view (#212).

  `ASSIGN_IMAGE_TO_CELL` reset the cell's view transform even when the cell already showed that image. So pressing the active cell's own filmstrip thumbnail (a click, or Enter or Space on the focused thumbnail) silently threw away its rotation, flip, negative, exposure and contrast, with nothing visible changing and no undo. Assigning the same image is now a no-op. Assigning a different image still starts it from a fresh view.

  Also, `onAnnotationRenderError`'s parameter is now named `failure` in its type, since it receives an `AnnotationRenderFailure` record whose `error` field holds what was thrown. Nothing changes at runtime or in types.
  - @osdlabel/annotation@0.19.1
  - @osdlabel/annotation-context@0.19.1
  - @osdlabel/decoration@0.19.1
  - @osdlabel/fabric-annotations@0.19.1
  - @osdlabel/fabric-osd@0.19.1
  - @osdlabel/geometry@0.19.1
  - @osdlabel/validation@0.19.1
  - @osdlabel/viewer-api@0.19.1

## 0.19.0

### Minor Changes

- 3944fcf: An annotation that cannot be rendered no longer empties its image's canvas, and is no longer dropped silently (#209).

  `ViewerCell` rebuilt every annotation's Fabric object with `Promise.all`. One whose stored `rawAnnotationData` named a Fabric class that isn't registered failed the whole rebuild, so the canvas stayed empty for that image and the error surfaced only as an unhandled promise rejection. One whose data was malformed for a known class was dropped by Fabric's loader with no error at all.

  Each annotation is now built on its own. One that fails is skipped on the canvas and stays in state, and the rest of the image's annotations render as usual. The failure is reported:
  - **`onAnnotationRenderError({ annotation, error })`:** a new optional prop on `AnnotatorProvider` and `Annotator`, called once per skipped annotation. If it throws, the error is logged with `console.error` and the remaining failures are still reported.
  - **Without it:** a `console.warn` naming the annotation and its image.

  A rebuild that is superseded, or cancelled because the cell unmounted, reports nothing.

  **Behaviour change in `@osdlabel/fabric-annotations`:** `deserializeFabricObject` (and so `createFabricObjectFromRawData`) now rejects with Fabric's error when a Fabric payload cannot be revived, including malformed data that Fabric's `enlivenObjects` used to swallow. It still resolves to `null` for an envelope whose `format` is not `'fabric'`.

  `osdlabel` exports the pieces both frameworks use: `settleAnnotationObjects(annotations, build)`, `reportAnnotationRenderFailures(failures, report)`, `warnAnnotationRenderError`, and the `AnnotationRenderFailure` and `SettledAnnotationObjects` types.

- fd0cc76: Filmstrip accessibility follow-ups (#205):
  - **Announced as a list.** The filmstrip is now a list labelled "Images" (`FILMSTRIP_LABEL`, exported from `osdlabel`), with one list item per image. Assistive tech announces what the thumbnails belong to and how many there are.
  - **Larger clear target.** The clear badge's button is now a 24px target (WCAG 2.5.8). The badge is still drawn at 16px, centred in the target, so it sits 2px further in from the corner.
  - **Valid markup.** The text placeholder inside a thumbnail button is a `<span>` rather than a `<div>`, since a button may only hold phrasing content. The layout is unchanged.
  - **Label updates (SolidJS).** The filmstrip follows a change to an image's `label` again, matching React.
  - **More focused controls keep their keys.** `shouldSkipKeyboardShortcut` now also leaves `Enter` and `Space` to a focused `<summary>` or `<select>`, and `Enter` to a link (`<a href>` or `role="link"`). A `<select>` opens on Space, and on Return on macOS.

  The keyboard guide also explains when the browser may draw a focus ring around the viewer, and how to style it.

### Patch Changes

- Updated dependencies [3944fcf]
  - @osdlabel/fabric-annotations@0.19.0
  - @osdlabel/fabric-osd@0.19.0
  - @osdlabel/annotation@0.19.0
  - @osdlabel/annotation-context@0.19.0
  - @osdlabel/decoration@0.19.0
  - @osdlabel/geometry@0.19.0
  - @osdlabel/validation@0.19.0
  - @osdlabel/viewer-api@0.19.0

## 0.18.0

### Minor Changes

- 06e6394: `<GridControls>`' popover no longer gets clipped near a right edge: it opens leftward when opening rightward would be cut off (#147).

  The popover was anchored to its button's left edge, so it always opened down and to the right. A host that put the control near a right edge, such as a hand-composed toolbar or a narrow slot, got a popover cut off by the window or by a container that hides overflow, with the far columns unreachable.

  Each time the popover opens, it is now measured before the browser paints and lined up with the button's right edge instead whenever the rightward placement would be clipped. The bounds are the viewport narrowed by every element that actually clips the popover, following its containing-block chain in the flat tree (through shadow roots and slots). Overflow other than `visible` and paint containment (including `content-visibility`'s) clip. Absolutely and fixed-positioned boxes skip ancestors that do not contain them, where transforms (individual `translate` / `rotate` / `scale` included), `perspective`, `transform-style: preserve-3d`, filters, layout or paint containment and matching `will-change` values also make an ancestor a containing block. A top-layer element (fullscreen, a modal `<dialog>`, an open popover) ends the chain, and a `<body>` whose overflow goes to the viewport, or a `display: contents` element, does not clip. Rightward stays the default whenever it fits, so the stock `<Annotator>` layout is unchanged. The popover exposes its choice as `data-alignment="start" | "end"`.

  `osdlabel` exports the two pieces for hosts building a similar dropdown: `choosePopoverAlignment(anchor, popoverWidth, bounds)`, a pure decision that prefers `'start'`, falls back to `'end'`, and picks the smaller overflow when neither fits; and `getHorizontalClipBounds(element)`, which finds those bounds in the DOM. `'start'` and `'end'` are physical (left and right), not logical.

### Patch Changes

- @osdlabel/annotation@0.18.0
- @osdlabel/annotation-context@0.18.0
- @osdlabel/decoration@0.18.0
- @osdlabel/fabric-annotations@0.18.0
- @osdlabel/fabric-osd@0.18.0
- @osdlabel/geometry@0.18.0
- @osdlabel/validation@0.18.0
- @osdlabel/viewer-api@0.18.0

## 0.17.0

### Minor Changes

- 1f6be38: Make the filmstrip usable from the keyboard and by assistive tech, and stop Enter on a focused button from also firing a shortcut (#189).

  **Enter on a focused button no longer also fires a shortcut.** The keyboard shortcuts listen on `window`, so they saw the same Enter or Space that the browser turns into a click on a focused button. `Enter` is the polyline-finish binding: activating the filmstrip's clear button from the keyboard with a polyline in progress finished the polyline _and_ emptied the cell. The shortcuts now leave Enter and Space to a focused `<button>` or `role="button"` element. Every other key still reaches them from a focused button, so tabbing through the toolbar does not switch off `r`, `Delete` or the grid digits. The rule is exported as `shouldSkipKeyboardShortcut(target, key)`, and both framework hooks use it alongside the existing `<input>` / `<textarea>` / contenteditable skip, which it now also covers.

  **Thumbnails are buttons.** Assigning an image was mouse-only: each thumbnail was a `<div onClick>`. It is now a `<button>`, reachable with Tab and operated with Enter or Space, named with the image and its assignment state for assistive tech (e.g. "Landscape, shown in the active cell") and marked `aria-current` when it is the active cell's image. `getCellAssignmentLabel` and `CELL_ASSIGNMENT_STATE_LABEL` export that wording. The thumbnail wrapper keeps its `data-testid`, `data-assignment` and border, and now holds two sibling buttons, assign and clear, so no control is nested inside another. Each thumbnail button also carries `data-testid="filmstrip-thumb-<imageId>"`.

  **Focus after a keyboard clear.** The clear button unmounts with the assignment, so focus fell to `<body>`. When the clear was made from the keyboard, focus now moves to the same image's thumbnail, where Enter puts the image back. A mouse clear leaves focus where it was.

  Like the toolbar, a mouse click on a thumbnail or the clear button no longer leaves keyboard focus on it (`preventButtonFocusSteal`), so a later Enter cannot re-press it.

  **A press on the image now moves keyboard focus to the viewer** (`@osdlabel/fabric-osd`). In annotation and custom-control mode, `FabricOverlay` prevents the default of every press it owns, and that also cancelled the browser's own focus change, so whatever had focus kept it. Combined with the button rule above, that would have broken a real flow: pick the polyline tool from the keyboard, draw with the mouse, and the final Enter went to the still-focused tool button. The overlay now focuses OSD's canvas on such a press, which is the element a native click would have focused and where a navigation-mode click already puts focus. OSD's own key bindings on it stay suppressed. As in any page, the press also blurs a host text field that had focus, so shortcuts resume once the user starts drawing.

  The thumbnails' hover text (`CELL_ASSIGNMENT_TITLE`) is now gesture-neutral ("Show this image in the active cell" rather than "Click to show…"). Next to the thumbnail's `aria-label` it is also announced as the accessible description.

### Patch Changes

- Updated dependencies [1f6be38]
  - @osdlabel/fabric-osd@0.17.0
  - @osdlabel/annotation@0.17.0
  - @osdlabel/annotation-context@0.17.0
  - @osdlabel/decoration@0.17.0
  - @osdlabel/fabric-annotations@0.17.0
  - @osdlabel/geometry@0.17.0
  - @osdlabel/validation@0.17.0
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

- Updated dependencies [7955609]
  - @osdlabel/decoration@0.16.0
  - @osdlabel/fabric-osd@0.16.0
  - @osdlabel/annotation@0.16.0
  - @osdlabel/annotation-context@0.16.0
  - @osdlabel/fabric-annotations@0.16.0
  - @osdlabel/geometry@0.16.0
  - @osdlabel/validation@0.16.0
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
  - @osdlabel/decoration@0.15.0
  - @osdlabel/annotation-context@0.15.0
  - @osdlabel/fabric-annotations@0.15.0
  - @osdlabel/fabric-osd@0.15.0
  - @osdlabel/geometry@0.15.0
  - @osdlabel/validation@0.15.0

## 0.14.0

### Minor Changes

- 96d046e: Let a grid cell be emptied again, from a dedicated clear button on the filmstrip thumbnail.

  Once a cell had been assigned an image there was no way back to the empty state. Reassigning worked; unassigning did not exist at any layer (#183).

  The empty state was never unsupported, only unreachable. `GridView` already renders the "Assign an image" placeholder for an unassigned cell, every cell starts that way, and `activeImageId` is `ImageId | undefined` throughout the stack — `getSelectableContexts` even documents the no-image case. What was missing was a way to re-enter it.
  - `osdlabel` gains a `UNASSIGN_IMAGE_FROM_CELL` UI action, which deletes the cell's grid assignment and its view transform. Dropping the transform mirrors `ASSIGN_IMAGE_TO_CELL`, which resets it on every assignment.
  - Both framework `actions` objects gain `unassignImageFromCell(cellIndex)`.
  - `osdlabel` exports `getCellAssignmentState`, `getGridCellCount`, the `CellAssignmentState` / `CellAssignmentView` / `GridDimensions` types, and the shared `CELL_ASSIGNMENT_*` palette (including `CELL_ASSIGNMENT_CLEAR_LABEL` for the clear button's accessible name). The helpers take the UI state rather than pre-computed indices, so a caller cannot derive one of the inputs wrongly.
  - **`activeCellIndex` is now an invariant of the reducer: it always addresses a cell the grid renders.** `SET_ACTIVE_CELL` and `SET_GRID_DIMENSIONS` both clamp into the current grid, from both ends, and `SET_GRID_DIMENSIONS` floors the grid at one cell — so no sequence of actions can leave the active cell pointing off screen. `setGridDimensions(0, 0)` now yields a 1×1 grid rather than a grid with no cells.

    Both take raw `number`s from public API, so both normalise before clamping: a fractional index is truncated (`setActiveCell(1.5)` selects cell 1 — a clamp alone would accept 1.5, which is in range by every comparison yet keys nothing in `gridAssignments`), and non-finite input falls back to a real cell rather than propagating (`Math.max(1, NaN)` is `NaN`, which would poison every clamp derived from the grid size). Everything keyed on the active cell — the image it shows, its view transform, the tools it enables — therefore reads state the user can actually see, with no scoping at the point of use. The clamp in both `GridControls` components is removed; the reducer owns this.

    **This imposes an ordering rule on hosts:** size the grid before restoring a saved active cell. `setActiveCell(3)` against a 1×1 grid clamps to 0 rather than being remembered until the grid grows.

  - The cell-selection shortcuts (digits 1-9) are screened against the current grid size. They previously mapped a digit to a fixed cell index regardless of how many cells existed, so on the default 1x1 grid pressing `2` selected a cell that does not exist. Screened rather than clamped: pressing `9` on a 1×1 grid should do nothing, not snap the selection to cell 0.

  Assignments for cells pruned by a shrink are still kept, so a shrink/expand round trip restores the image that cell was showing (its view transform is reset, as on any assignment). Note the asymmetry this creates with the clamp above: the same round trip does **not** restore the active cell, which stays where the shrink clamped it. The viewer-grid guide documents it, since `-` then `=` is an ordinary thing for a user to do. `getCellAssignmentState` scopes `'other'` by the grid's cell count for exactly that reason — a retained assignment must not make the filmstrip describe a cell nobody can see.

  **Clearing is a separate control, not a second click on the thumbnail.** The `✕` badge on the active cell's thumbnail is a real `<button>`: focusable, labelled for assistive tech, and the only thing that empties a cell. A thumbnail click only ever assigns, so it stays idempotent and there is no behavioural change for existing callers. The reason is double-click: if a thumbnail both assigned and cleared, clicking an unassigned thumbnail twice — an extremely common habit — would assign and then immediately wipe the cell, discarding its rotation, flip, exposure and contrast with no undo.

  The filmstrip highlight changed with it. It previously meant "assigned to _some_ cell"; it now distinguishes three states, exposed as a `data-assignment` attribute for testing: `active` (bright blue, carries the `✕` button), `other` (muted blue — shown in another cell), and `none` (grey). Only `active` offers the clear, so the highlight matches the controls the thumbnail actually has.

  Annotations are unaffected by clearing a cell: `AnnotationState.byImage` is keyed by image, independent of grid placement, so they survive and reappear on reassignment. `selectedAnnotationId` is deliberately left intact, since another cell may still be displaying the image it belongs to.

  `assignImageToCell` and `unassignImageFromCell` now validate their cell index. A fraction is truncated — `gridAssignments` and `cellTransforms` are keyed by whole numbers, so `assignImageToCell(1.5, id)` previously wrote a `"1.5"` key that no reader ever looked up. A negative or non-finite index is ignored: the action does nothing, rather than falling back to cell 0 and overwriting or emptying the cell that is always on screen. Neither action screens against the current grid size, because a shrink deliberately keeps out-of-grid assignments for a later expand. `setActiveCell` differs because it must always land on a real cell: it clamps instead, so `NaN` selects the first cell and `Infinity` the last.

### Patch Changes

- @osdlabel/annotation@0.14.0
- @osdlabel/annotation-context@0.14.0
- @osdlabel/decoration@0.14.0
- @osdlabel/fabric-annotations@0.14.0
- @osdlabel/fabric-osd@0.14.0
- @osdlabel/geometry@0.14.0
- @osdlabel/validation@0.14.0
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
  - @osdlabel/annotation-context@0.13.0
  - @osdlabel/decoration@0.13.0
  - @osdlabel/fabric-annotations@0.13.0
  - @osdlabel/fabric-osd@0.13.0
  - @osdlabel/geometry@0.13.0
  - @osdlabel/validation@0.13.0
  - @osdlabel/viewer-api@0.13.0

## 0.12.0

### Patch Changes

- Updated dependencies [9d54b96]
  - @osdlabel/fabric-osd@0.12.0
  - @osdlabel/fabric-annotations@0.12.0
  - @osdlabel/annotation@0.12.0
  - @osdlabel/annotation-context@0.12.0
  - @osdlabel/decoration@0.12.0
  - @osdlabel/geometry@0.12.0
  - @osdlabel/validation@0.12.0
  - @osdlabel/viewer-api@0.12.0

## 0.11.1

### Patch Changes

- Updated dependencies [894636e]
  - @osdlabel/fabric-osd@0.11.1
  - @osdlabel/annotation@0.11.1
  - @osdlabel/annotation-context@0.11.1
  - @osdlabel/decoration@0.11.1
  - @osdlabel/fabric-annotations@0.11.1
  - @osdlabel/geometry@0.11.1
  - @osdlabel/validation@0.11.1
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
  - @osdlabel/fabric-osd@0.11.0
  - @osdlabel/annotation@0.11.0
  - @osdlabel/annotation-context@0.11.0
  - @osdlabel/decoration@0.11.0
  - @osdlabel/geometry@0.11.0
  - @osdlabel/validation@0.11.0
  - @osdlabel/viewer-api@0.11.0

## 0.10.1

### Patch Changes

- @osdlabel/annotation@0.10.1
- @osdlabel/annotation-context@0.10.1
- @osdlabel/decoration@0.10.1
- @osdlabel/fabric-annotations@0.10.1
- @osdlabel/fabric-osd@0.10.1
- @osdlabel/geometry@0.10.1
- @osdlabel/validation@0.10.1
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
  - @osdlabel/fabric-annotations@0.10.0
  - @osdlabel/annotation-context@0.10.0
  - @osdlabel/decoration@0.10.0
  - @osdlabel/fabric-osd@0.10.0
  - @osdlabel/geometry@0.10.0
  - @osdlabel/validation@0.10.0
  - @osdlabel/viewer-api@0.10.0

## 0.9.0

### Minor Changes

- 551e21f: Remove `buildToolCallbacks`, `ToolCallbackAccessors` and `ToolCallbackDispatchers`.

  **Breaking.** These were exported from the `osdlabel` barrel (and transitively re-exported by `@osdlabel/solid` and `@osdlabel/react`) but had no callers anywhere — both framework hooks build their `ToolCallbacks` object inline in `useAnnotationTool`. `buildToolCallbacks` could not run, which is why mutating its `canAddAnnotation` to always return `true` survived the entire test suite.

  If you were calling `buildToolCallbacks`, construct the `ToolCallbacks` object directly; `ToolCallbacks` itself is unchanged and still exported from `@osdlabel/fabric-annotations`.

  `createAnnotationTool` is unaffected and now has direct test coverage asserting the concrete tool class returned for each `ToolType`.

### Patch Changes

- @osdlabel/annotation@0.9.0
- @osdlabel/annotation-context@0.9.0
- @osdlabel/decoration@0.9.0
- @osdlabel/fabric-annotations@0.9.0
- @osdlabel/fabric-osd@0.9.0
- @osdlabel/geometry@0.9.0
- @osdlabel/validation@0.9.0
- @osdlabel/viewer-api@0.9.0

## 0.8.1

### Patch Changes

- @osdlabel/annotation@0.8.1
- @osdlabel/annotation-context@0.8.1
- @osdlabel/decoration@0.8.1
- @osdlabel/fabric-annotations@0.8.1
- @osdlabel/fabric-osd@0.8.1
- @osdlabel/geometry@0.8.1
- @osdlabel/validation@0.8.1
- @osdlabel/viewer-api@0.8.1

## 0.8.0

### Minor Changes

- b6b4e3d: Add a fullscreen toggle to the annotator

  The view controls gain a fullscreen button that puts the whole annotator —
  toolbar, filmstrip, grid and status bar — into the browser's native fullscreen
  mode. Hide it with `showFullscreenControl={false}` on `<Annotator>` or
  `<ViewControls>`; it hides itself where the browser has no element-level
  Fullscreen API, such as iPhone Safari or an `<iframe>` without
  `allow="fullscreen"`.

  Which element goes fullscreen is resolved most-specific-first: the new
  `fullscreenTarget` prop (an element or a getter), then whatever claimed
  `fullscreenTargetRef` on the annotator context, and finally the document
  element so the control is never inert. `<Annotator>` claims the ref with its
  own root; a layout composed by hand claims it the same way, on the element
  wrapping the annotator UI.

  New `useFullscreen` hook in both framework packages, plus `getFullscreenElement`,
  `isFullscreenSupported`, `requestFullscreen`, `exitFullscreen`,
  `toggleFullscreen`, `onFullscreenChange` and `resolveFullscreenTarget` from
  `osdlabel`. The shim covers the standard Fullscreen API plus Safari's `webkit`
  prefix, and requests resolve `false` rather than rejecting when the browser
  refuses.

  Entering and leaving preserves the centre of the image and scales it by the
  change in the container's diagonal, so the round trip returns the exact zoom
  and centre you started from.

  **Possible visual change:** the `<Annotator>` root now paints
  `background: #1a1a1a`. It painted nothing before, so in fullscreen the black
  backdrop showed through every gap in the layout. If you embed the annotator in
  a light-themed page you may see a dark rectangle where you previously saw your
  own background — override it with `style={{ background: '...' }}`.

  Also fixes Solid's `<Annotator>` silently dropping the `renderDomDecoration`
  prop, which was never added to its hand-enumerated provider prop list.

### Patch Changes

- b6b4e3d: Ignore `Escape` while an element is displayed fullscreen

  The browser exits fullscreen on `Escape` and the keypress cannot be
  intercepted, so the annotator acting on it too made one press do two unrelated
  things: leave fullscreen _and_ deselect, clear the active tool, or cancel an
  in-progress polyline, with the second effect hidden behind the transition.

  The guard covers all four `Escape` handlers — the vertex editor's exit, the
  polyline and free-hand cancels, and the global cancel — and applies whenever
  _any_ element is fullscreen, including one your own app put there. Every other
  shortcut keeps working. Browser-native fullscreen (F11, kiosk mode) is
  unaffected, since `Escape` does not exit those either.

  Also fixes three package root barrels that were missing exports available from
  their sub-path barrels: `useKeyboard` from `@osdlabel/react`, and
  `ActiveToolKeyHandlerRef` and `FpsCounter` from `@osdlabel/solid`.

- 43265af: Stop toolbar clicks from parking keyboard focus on the button

  Clicking a `<button>` focuses it, and a focused button is activated again by
  `Enter` or `Space`. In an annotator, whose shortcuts are global and whose real
  focus context is the image, that turns every toolbar click into a loaded gun:
  after clicking Rotate, `Enter` rotated again; after clicking the fullscreen
  toggle, `Enter` left fullscreen. Worse, `Enter` is the polyline-finish binding,
  so finishing a shape re-fired whichever control had last been clicked.

  The `Toolbar`, `ViewControls` and `GridControls` containers now suppress the
  default on `mousedown` when the press lands on a button, so the button never
  takes focus. The click still fires, and keyboard operation is untouched: `Tab`
  still reaches every control and `Enter` / `Space` still activate it.

  Exported as `preventButtonFocusSteal` from `osdlabel` for hosts that build
  their own control surfaces around the annotator.

- Updated dependencies [b6b4e3d]
  - @osdlabel/fabric-osd@0.8.0
  - @osdlabel/annotation@0.8.0
  - @osdlabel/annotation-context@0.8.0
  - @osdlabel/decoration@0.8.0
  - @osdlabel/fabric-annotations@0.8.0
  - @osdlabel/geometry@0.8.0
  - @osdlabel/validation@0.8.0
  - @osdlabel/viewer-api@0.8.0

## 0.7.2

### Patch Changes

- @osdlabel/annotation@0.7.2
- @osdlabel/annotation-context@0.7.2
- @osdlabel/decoration@0.7.2
- @osdlabel/fabric-annotations@0.7.2
- @osdlabel/fabric-osd@0.7.2
- @osdlabel/geometry@0.7.2
- @osdlabel/validation@0.7.2
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
  - @osdlabel/decoration@0.7.1
  - @osdlabel/fabric-annotations@0.7.1
  - @osdlabel/fabric-osd@0.7.1
  - @osdlabel/geometry@0.7.1
  - @osdlabel/viewer-api@0.7.1
  - @osdlabel/validation@0.7.1

## 0.7.0

### Minor Changes

- 49b5003: Add keyboard controls for cycling between annotation contexts.
  - `.` activates the next annotation context and `,` the previous one, wrapping around at both ends. The shifted `>` / `<` variants are accepted too, mirroring the existing `=` / `+` grid-column handling. `KeyboardShortcutMap` gains `nextContext` / `previousContext`, overridable like any other binding.
  - Contexts scoped to other images (via `AnnotationContext.imageIds`) are skipped, so a keypress only ever lands on a context usable on the image in the active cell. When the active context is unset — or is itself scoped out of the current image — the ring is entered at the end the direction implies: `next` lands on the first selectable context, `previous` on the last.
  - The active tool and selected annotation are deliberately left untouched, making the shortcut equivalent to picking an entry in `ContextSwitcher`. `useAnnotationTool` already re-checks `constraintStatus` at draw time, so a tool the new context disallows is rejected there and shown disabled in the toolbar.
  - New pure helpers `getSelectableContexts` and `getCycledContextId` are exported from `osdlabel`, keeping `mapKeyEventToActions` a thin dispatcher. It now returns `ContextAction` alongside UI and annotation actions; both framework `useKeyboard` hooks handle `SET_ACTIVE_CONTEXT`.
  - The new `KeyboardMappingState.contexts` / `.activeContextId` fields are optional, so existing callers of `mapKeyEventToActions` keep compiling — cycling simply no-ops without them. **Breaking (React only):** `useKeyboard` takes a new required `contextState` argument between `uiState` and `activeImageId`; callers using the `AnnotatorProvider` are unaffected.

### Patch Changes

- Updated dependencies [49b5003]
  - @osdlabel/viewer-api@0.7.0
  - @osdlabel/annotation-context@0.7.0
  - @osdlabel/decoration@0.7.0
  - @osdlabel/fabric-annotations@0.7.0
  - @osdlabel/fabric-osd@0.7.0
  - @osdlabel/annotation@0.7.0
  - @osdlabel/geometry@0.7.0
  - @osdlabel/validation@0.7.0

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
  - @osdlabel/fabric-osd@0.6.0
  - @osdlabel/annotation-context@0.6.0
  - @osdlabel/decoration@0.6.0
  - @osdlabel/fabric-annotations@0.6.0
  - @osdlabel/annotation@0.6.0
  - @osdlabel/geometry@0.6.0
  - @osdlabel/validation@0.6.0

## 0.5.0

### Minor Changes

- c77c661: Add circle→rectangle conversion and interactive polygon/polyline vertex editing.
  - Convert a selected circle to its axis-aligned bounding rectangle via a contextual, constraint-aware "Convert to Rect" toolbar button, backed by the pure `circleToBoundingRectangle` helper.
  - Edit polygon/polyline vertices: a configurable long-press enters a sticky edit mode with per-vertex move handles and edge-midpoint insertion handles; Delete/Backspace removes a vertex (min 3 polygon / 2 polyline). Reachable from the Select, Polyline, and Free-draw tools; long-press timing/tolerance are Annotator-level options.
  - New `@osdlabel/geometry` package holds the geometry math and conversions; `@osdlabel/decoration` re-exports the math so the public API is unchanged.

### Patch Changes

- Updated dependencies [c77c661]
  - @osdlabel/geometry@0.5.0
  - @osdlabel/decoration@0.5.0
  - @osdlabel/fabric-osd@0.5.0
  - @osdlabel/annotation@0.5.0
  - @osdlabel/annotation-context@0.5.0
  - @osdlabel/fabric-annotations@0.5.0
  - @osdlabel/validation@0.5.0
  - @osdlabel/viewer-api@0.5.0

## 0.4.0

### Minor Changes

- 6fb9f49: Add `createAnnotationFromGeometry` for seeding annotations from external geometry without the manual Fabric round-trip. The `osdlabel` umbrella (and the `@osdlabel/react` / `@osdlabel/solid` re-exports) gains `createAnnotationFromGeometry(geometry, { imageId, contextId, toolType, style?, id?, label? })`, which builds a complete `OsdAnnotation` including the Fabric `rawAnnotationData` envelope and guarantees the `id` survives serialization. `@osdlabel/fabric-annotations` exposes the underlying `buildFabricObjectFromGeometry` (the inverse of `getGeometryFromFabricObject`).

### Patch Changes

- 6fb9f49: Widen the published `fabric` and `openseadragon` peer ranges from exact pins to caret ranges (`fabric: ^7.4.0`, `openseadragon: ^5.0.1`) to reduce install friction in monorepos and shared-install setups. The `fabric` floor stays at 7.4.0 to exclude the <7.4 CVE. Dev/workspace installs remain pinned to exact versions via the default pnpm catalog; the ranges are sourced from a new named `peers` catalog used only in `peerDependencies`.
- Updated dependencies [6fb9f49]
- Updated dependencies [6fb9f49]
- Updated dependencies [6fb9f49]
  - @osdlabel/fabric-annotations@0.4.0
  - @osdlabel/fabric-osd@0.4.0
  - @osdlabel/annotation@0.4.0
  - @osdlabel/annotation-context@0.4.0
  - @osdlabel/decoration@0.4.0
  - @osdlabel/validation@0.4.0
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
  - @osdlabel/decoration@0.3.0
  - @osdlabel/fabric-annotations@0.3.0
  - @osdlabel/fabric-osd@0.3.0
  - @osdlabel/validation@0.3.0
  - @osdlabel/viewer-api@0.3.0

## 0.2.2

### Patch Changes

- Updated dependencies [54f4f59]
  - @osdlabel/fabric-annotations@0.2.2
  - @osdlabel/fabric-osd@0.2.2
  - @osdlabel/annotation@0.2.2
  - @osdlabel/annotation-context@0.2.2
  - @osdlabel/decoration@0.2.2
  - @osdlabel/validation@0.2.2
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
  - @osdlabel/decoration@0.2.1
  - @osdlabel/validation@0.2.1
  - @osdlabel/fabric-annotations@0.2.1
  - @osdlabel/fabric-osd@0.2.1

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
  - @osdlabel/decoration@0.2.0
  - @osdlabel/fabric-annotations@0.2.0
  - @osdlabel/fabric-osd@0.2.0
  - @osdlabel/validation@0.2.0
  - @osdlabel/viewer-api@0.2.0

## 0.1.0

### Minor Changes

- 187721c: First Beta release of osdlabel

### Patch Changes

- Updated dependencies [187721c]
  - @osdlabel/annotation@0.1.0
  - @osdlabel/annotation-context@0.1.0
  - @osdlabel/decoration@0.1.0
  - @osdlabel/fabric-annotations@0.1.0
  - @osdlabel/fabric-osd@0.1.0
  - @osdlabel/validation@0.1.0
  - @osdlabel/viewer-api@0.1.0
