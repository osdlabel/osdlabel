---
'@osdlabel/fabric-annotations': minor
'osdlabel': minor
---

The select tool's handles can no longer make a rectangle or a circle that its geometry cannot describe.

Fabric's default handles let a user hold **Shift** on a side handle to shear a rectangle into a parallelogram, or a circle into a slanted ellipse, and stretch a circle into an ellipse with a side handle or with **Shift** on a corner. The stored geometry kept an unsheared rectangle about the same centre, or a circle of the larger radius, so measurements, labels, bounding boxes and exports described a shape the user never saw, and the saved Fabric data disagreed with the geometry saved beside it.

- **Rectangles**: the side handles only resize, so Shift + a side handle does what the handle does without Shift. Corner handles are unchanged: proportional, or free while Shift is held.
- **Circles**: four corner handles that always scale uniformly, Shift or not, and the rotation handle. No side handles.
- **Lines, polylines and polygons** keep Fabric's handles, Shift + a side handle shear included: their stored points follow the shear exactly.

The handles are installed on every path that puts an annotation's object on the canvas: the rectangle and circle tools, `buildFabricObjectFromGeometry` and `createFabricObjectFromRawData`. The new `applyShapeControls(object, geometryType)` (exported from `@osdlabel/fabric-annotations`, `osdlabel` and both bindings) does it, for hosts that build or revive objects some other way, such as with `deserializeFabricObject`. It builds on the controls the object already has, so rectangle and circle controls a host customised through Fabric's `createControls` are kept, apart from the handlers the library constrains: a rotation handle the host removed stays removed.

**The edit commit normalises such shapes.** When `processObjectModified` commits a rectangle, circle or point that is skewed, or a circle scaled differently along its two axes, it stores the geometry read back as before (a circle's radius is still `radius × max(scaleX, scaleY)`) and replaces the Fabric data with data that paints exactly that geometry, in the same style, keeping any custom properties the host registered.

**Data saved by earlier releases** (0.21.0 and before) with a sheared rectangle or circle, or a stretched circle, is not changed on load: it still paints as saved, with its geometry as saved. The first time it is edited, its Fabric data is replaced as above, and the shape on screen snaps to what its geometry describes. There is no migration helper.
