# @osdlabel/solid

## 0.5.0

### Minor Changes

- c77c661: Add circle→rectangle conversion and interactive polygon/polyline vertex editing.
  - Convert a selected circle to its axis-aligned bounding rectangle via a contextual, constraint-aware "Convert to Rect" toolbar button, backed by the pure `circleToBoundingRectangle` helper.
  - Edit polygon/polyline vertices: a configurable long-press enters a sticky edit mode with per-vertex move handles and edge-midpoint insertion handles; Delete/Backspace removes a vertex (min 3 polygon / 2 polyline). Reachable from the Select, Polyline, and Free-draw tools; long-press timing/tolerance are Annotator-level options.
  - New `@osdlabel/geometry` package holds the geometry math and conversions; `@osdlabel/decoration` re-exports the math so the public API is unchanged.

### Patch Changes

- Updated dependencies [c77c661]
  - osdlabel@0.5.0
  - @osdlabel/decoration@0.5.0
  - @osdlabel/fabric-osd@0.5.0
  - @osdlabel/annotation@0.5.0
  - @osdlabel/annotation-context@0.5.0
  - @osdlabel/fabric-annotations@0.5.0
  - @osdlabel/osd-helper@0.5.0
  - @osdlabel/validation@0.5.0
  - @osdlabel/viewer-api@0.5.0

## 0.4.0

### Patch Changes

- 6fb9f49: Widen the published `fabric` and `openseadragon` peer ranges from exact pins to caret ranges (`fabric: ^7.4.0`, `openseadragon: ^5.0.1`) to reduce install friction in monorepos and shared-install setups. The `fabric` floor stays at 7.4.0 to exclude the <7.4 CVE. Dev/workspace installs remain pinned to exact versions via the default pnpm catalog; the ranges are sourced from a new named `peers` catalog used only in `peerDependencies`.
- Updated dependencies [6fb9f49]
- Updated dependencies [6fb9f49]
- Updated dependencies [6fb9f49]
  - @osdlabel/fabric-annotations@0.4.0
  - @osdlabel/fabric-osd@0.4.0
  - osdlabel@0.4.0
  - @osdlabel/osd-helper@0.4.0
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
  - osdlabel@0.3.0
  - @osdlabel/annotation@0.3.0
  - @osdlabel/annotation-context@0.3.0
  - @osdlabel/decoration@0.3.0
  - @osdlabel/fabric-annotations@0.3.0
  - @osdlabel/fabric-osd@0.3.0
  - @osdlabel/osd-helper@0.3.0
  - @osdlabel/validation@0.3.0
  - @osdlabel/viewer-api@0.3.0

## 0.2.2

### Patch Changes

- Updated dependencies [54f4f59]
  - @osdlabel/fabric-annotations@0.2.2
  - @osdlabel/fabric-osd@0.2.2
  - osdlabel@0.2.2
  - @osdlabel/annotation@0.2.2
  - @osdlabel/annotation-context@0.2.2
  - @osdlabel/decoration@0.2.2
  - @osdlabel/osd-helper@0.2.2
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
  - @osdlabel/osd-helper@0.2.1
  - @osdlabel/fabric-annotations@0.2.1
  - @osdlabel/fabric-osd@0.2.1
  - osdlabel@0.2.1

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
  - osdlabel@0.2.0
  - @osdlabel/annotation@0.2.0
  - @osdlabel/annotation-context@0.2.0
  - @osdlabel/decoration@0.2.0
  - @osdlabel/fabric-annotations@0.2.0
  - @osdlabel/fabric-osd@0.2.0
  - @osdlabel/osd-helper@0.2.0
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
  - @osdlabel/osd-helper@0.1.0
  - osdlabel@0.1.0
  - @osdlabel/validation@0.1.0
  - @osdlabel/viewer-api@0.1.0
