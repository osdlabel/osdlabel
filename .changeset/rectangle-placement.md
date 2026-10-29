---
'@osdlabel/fabric-annotations': patch
'osdlabel': patch
---

Rectangles are painted where their geometry says.

Fabric 7 places an object by its centre unless an origin is set, and the rectangle tool and `buildFabricObjectFromGeometry` never set one. So every rectangle was painted centred on the corner its geometry records, half its size up and to the left of the drag. Labels, measurements and exports computed from the geometry landed away from what the user saw. Rectangles are now built and read by their centre, and `getGeometryFromFabricObject` derives the corner from the object's centre, whatever origin it carries.

Rectangles saved by earlier releases keep painting where users saw them. `deserialize` recomputes their geometry to match: it recognises one by Fabric data with a centre origin whose `left` / `top` equal the geometry's origin. A host that loads stored annotations without `deserialize` can call the new `migrateLegacyRectangle` on each.
