---
"osdlabel": minor
"@osdlabel/annotation": minor
"@osdlabel/annotation-context": minor
"@osdlabel/decoration": minor
"@osdlabel/fabric-annotations": minor
"@osdlabel/fabric-osd": minor
"@osdlabel/osd-helper": minor
"@osdlabel/react": minor
"@osdlabel/solid": minor
"@osdlabel/validation": minor
"@osdlabel/viewer-api": minor
---

Add DOM decorations: framework-rendered rich annotation decorations.

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
