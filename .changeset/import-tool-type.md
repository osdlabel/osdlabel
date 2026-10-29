---
'@osdlabel/validation': patch
'osdlabel': patch
---

`deserialize` rejects an annotation whose `toolType` is not a tool that draws its geometry's type.

`toolType` records which tool drew an annotation, and constraints count annotations by it. `deserialize` validated `toolType` and `geometry` separately and never compared them, so a document edited by hand or written by another tool could load a rectangle recorded as drawn by the line tool. It counted as one of the context's lines and freed one of its rectangles: under a context allowing two rectangles and three lines, one rectangle and one line on the image showed as no rectangles and two lines, and a third rectangle could be drawn.

**Behaviour change:** `OsdAnnotationSchema` in `@osdlabel/validation`, which `deserialize` uses, now requires the `toolType` to be one that draws the geometry's type: the tool of the same name for a rectangle, circle, line or point, and `polyline` or `freeHandPath` for a polyline or a polygon, since either tool draws an open path or closes one. Otherwise `deserialize` throws `SerializationError`, loading nothing, with a message naming the annotation, its geometry type, its `toolType` and the tool types that draw it, for example `Validation failed: Annotation "a1" has rectangle geometry, but its toolType is "line", not "rectangle"`. These are exactly the pairings every release has saved, a circle converted to a rectangle included, so every document a release has exported still loads.

`createAnnotationFromGeometry` does not check the pairing, and its documentation used to call `toolType` independent of the geometry, so a host may have built annotations with another pairing. Their documents are now refused when loaded: set each such annotation's `toolType` to one from the list above. The serialization guide's "Choosing a `toolType`" section and the JSDoc of `deserialize` and `createAnnotationFromGeometry` now give the pairings. `loadAnnotations` and `initialAnnotations` still check neither, so pass outside data through `deserialize` first.
