---
'@osdlabel/fabric-annotations': patch
---

A click on an edge-insert handle now commits the vertex it adds.

In vertex-edit mode on a polygon or polyline, pressing an edge-insert handle and releasing without moving added a vertex to the shape on the canvas, at the press point rather than the edge's midpoint, but never reported the edit. State kept the old points, so the canvas painted one vertex more than the stored geometry, and exports, `onAnnotationsChange` and measurements left it out. The next time the cell was redrawn from state (after another edit, or an import), the vertex disappeared. A click now inserts the vertex at the edge's midpoint and commits it. Pressing and dragging still inserts the vertex and moves it with the pointer, committed on release.
