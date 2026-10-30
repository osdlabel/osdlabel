---
'@osdlabel/validation': minor
'osdlabel': minor
---

`deserialize` rejects an annotation whose saved Fabric object is not the kind of shape its geometry describes.

An annotation stores its shape twice. `rawAnnotationData` is the saved Fabric object, and it is what is painted and what the user drags. `geometry` is what is measured, labelled and exported, and an edit recomputes it from the Fabric object. `deserialize` validated the two separately and never compared them, so a document edited by hand or written by another tool could load a rectangle whose payload was a `Circle`: the user saw a circle, every measurement described a rectangle nobody could see, and edits to the circle were never saved.

**Behaviour change:** `OsdAnnotationSchema` in `@osdlabel/validation`, which `deserialize` uses, now requires the payload's Fabric class to be the one that paints the geometry's type: `Rect` for a rectangle, `Circle` for a circle or a point, `Line`, `Polyline` and `Polygon` for the others. The class name is matched regardless of case. Otherwise `deserialize` throws `SerializationError`, loading nothing, with a message naming the annotation and both types, for example `Validation failed: Annotation "a1" has rectangle geometry, but its rawAnnotationData is a Fabric Circle, not a Rect`. Every document a release has exported still loads, rectangles saved by 0.21.0 and earlier included.

Only the kind is compared. Whether the payload sits where the geometry says needs Fabric to check, and `deserialize` is synchronous, so such an annotation still loads as saved: painted from its payload, measured from its geometry, until its first edit. The serialization guide and the JSDoc of `deserialize` and `createAnnotationFromGeometry` now say which field is authoritative for what. Build annotations with `createAnnotationFromGeometry`, which writes both from one geometry, rather than pairing them by hand. `loadAnnotations` and `initialAnnotations` still check neither, so pass outside data through `deserialize` first.
