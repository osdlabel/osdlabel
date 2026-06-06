# @osdlabel/annotation-context

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
