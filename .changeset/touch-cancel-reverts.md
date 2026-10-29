---
'@osdlabel/fabric-osd': patch
'@osdlabel/fabric-annotations': patch
'osdlabel': patch
'@osdlabel/solid': patch
'@osdlabel/react': patch
---

A touch or pen gesture that the system cancels is now undone, instead of left half-done.

When the OS or the browser takes a touch or pen contact away mid-gesture (an edge swipe, palm rejection, a system dialog, an orientation change), the browser sends `pointercancel` and no `pointerup`. Nothing handled it. The shape stayed where the finger had left it while its stored geometry kept the old position, so labels, measurements and exports disagreed with the screen. The next pointer movement anywhere, even a mouse hover or a drag on empty canvas, carried the shape on and committed it wherever that ended. A drawing tool's preview stayed painted, and a tap on the toolbar committed it as an annotation the user never finished.

A cancelled gesture is now reverted. A moved, resized or rotated shape, or a dragged polygon vertex, goes back to where the press found it, and nothing is committed. A drawing tool drops its preview, a polyline drops only the vertex the cancelled press placed, and decorations return to the stored geometry. Later input starts afresh.

For hosts that build on the lower layers:

- `FabricOverlay.onPointerCancel(callback)` is new, with the `PointerCancelCallback` type (exported by `@osdlabel/fabric-osd`, `osdlabel` and both bindings). It reports a cancelled press, with the press's sequence, after the overlay has put Fabric's side back.
- `AnnotationTool` gains an optional `onPointerCancel(event, pressSeq)`. `BaseTool` implements it by calling `cancel()`, which suits a tool whose drawing lasts from press to release. `PolyVertexEditor` gains `onPointerCancel()`.
- `enableLiveDecorationUpdates` now subscribes to `onPointerCancel`, so a test double of `FabricOverlay` passed to it needs that method, returning an unsubscribe function.
