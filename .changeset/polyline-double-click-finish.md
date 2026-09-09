---
'osdlabel': minor
'@osdlabel/fabric-annotations': minor
'@osdlabel/fabric-osd': minor
'@osdlabel/solid': minor
'@osdlabel/react': minor
---

Make double click finish a polyline again, and add the overlay double-click event it needs.

`PolylineTool` ended an in-progress path as an open polyline when `event.detail === 2`, but that branch could never run. Tools are driven from `pointerdown`, whose `detail` is 0 by specification, so double click did nothing at all — leaving Enter and the close target as the only ways to end a path (#168).

Double clicks cannot come from Fabric here. Fabric's `mouse:dblclick` is raised from a native `dblclick` listener on the upper canvas, but that canvas is `pointerEvents: 'none'` and all input is routed through an OSD `MouseTracker`, so the browser's own `dblclick` targets the container and the upper canvas only ever sees synthetic pointer events.

- `FabricOverlay` gains `onDoubleClick(callback)`, returning an unsubscribe function. It pairs consecutive releases using the tracker's own `clickTimeThreshold` / `clickDistThreshold` / `dblClickTimeThreshold` / `dblClickDistThreshold` rather than redeclaring them. Subscribing resets the pairing, so a click made under a previous tool cannot pair with the first click under the next one.
- `AnnotationTool` gains `onDoubleClick(event, imagePoint)`, defaulting to a no-op on `BaseTool`. Custom tools implementing the interface directly will need it; those extending `BaseTool` are unaffected.
- Both framework `useAnnotationTool` hooks route the overlay event to the active tool.

Note for anyone implementing `AnnotationTool` directly: a double click still delivers both of its `pointerdown`s before `onDoubleClick`, so a tool that accumulates points on press may have picked up two extra vertices — or one, or none, since a press landing on an existing annotation is suppressed and never reaches the tool. `PolylineTool` decides which case it is geometrically, using two screen-space bounds derived from OpenSeadragon's click thresholds.
