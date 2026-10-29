---
'@osdlabel/annotation': patch
'@osdlabel/fabric-annotations': patch
'osdlabel': patch
---

Rectangles are painted where their geometry says.

Fabric 7 places an object by its centre unless an origin is set, and the rectangle tool and `buildFabricObjectFromGeometry` never set one. So every rectangle was painted centred on the corner its geometry records, half its size up and to the left of the drag, and labels, measurements and exports computed from the geometry landed away from what the user saw. Rectangles are now built and read by their centre, and `getGeometryFromFabricObject` derives the corner from the object's centre, whatever origin it carries.

`RectangleGeometry.origin` keeps its meaning, now written on the type: the rectangle's corner that is top-left before rotation. What changed is that it is now true of the rectangle on screen. Earlier releases read `origin` back as the centre the rectangle was painted at; on a rectangle never edited, that point is also the top-left corner of the drag.

**Rectangles saved by earlier releases** (0.21.0 and before) still paint where users saw them, since their saved Fabric data is what is drawn. Their geometry is loaded as saved, so it stays half the rectangle's size from the shape on screen until the rectangle is next edited, when it is read back from the shape's centre. `deserialize` does not change it. To correct such rectangles on load, pass each loaded annotation through the new `migrateLegacyRectangle`. It recomputes an earlier release's rectangle's geometry from where it is painted, and returns anything else unchanged. It is opt-in and tree-shakeable, exported from `@osdlabel/fabric-annotations` (also as `@osdlabel/fabric-annotations/legacy-rectangle`), `osdlabel` and both bindings.
