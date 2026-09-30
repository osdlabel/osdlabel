---
'@osdlabel/decoration': minor
'osdlabel': minor
---

Measure lengths, perimeters and distances per axis, so they are correct on anisotropic images (#187).

`createMeasurementProvider` and `createDistanceProvider` converted every length with the _mean_ pixel spacing, `(x + y) / 2`. That is exact only when `x = y`. On an image with 0.1 mm/px horizontally and 0.2 mm/px vertically, a horizontal and a vertical 100 px line were both labelled "15.00 mm"; they are 10 mm and 20 mm.

Each segment is now converted per axis, `hypot(dx · x, dy · y)`, which is exact at any angle:

- **`L:`** for lines and polylines (summed per segment).
- **`P:`** for polygons and rectangles, rotated rectangles included (per edge). A circle is physically an ellipse when `x ≠ y`, so its perimeter uses Ramanujan's ellipse formula: exact for isotropic spacing, and within 1e-6 relative at a 1:5 spacing ratio.
- **The distance provider's label**, between the two centroids.

Unchanged: areas (already `x · y`), and **circle radius `r:`**, which keeps the mean spacing because an ellipse has no single radius. On isotropic images, and on images without spacing, every label is the same as before.

**Labels on anisotropic images change value.** This is a correction, but anything that compared against the old numbers (snapshots, exported reports) will see the difference.

New exports, which the built-in providers now use, so custom providers and derived values (such as a ratio between two measured lines) can agree with the built-in labels:

- `measureDistance(a, b, spacing)`: the distance between two image-pixel points.
- `measureLength(geometry, spacing)`: open-curve length, mirroring `length`.
- `measurePerimeter(geometry, spacing)`: closed perimeter, mirroring `perimeter`.

Each returns a `Measurement`, in `px` when `spacing` is `undefined`. `toPhysicalLength` is unchanged. A scalar has lost its direction, so it cannot be converted per axis; its docs now point to the functions above for segments.
