# @osdlabel/geometry

Pure geometry math and geometry-type conversions for
[osdlabel](https://github.com/osdlabel/osdlabel), a web-based image annotation
library for gigapixel/DZI images.

Everything here operates on the `Geometry` discriminated union from
`@osdlabel/annotation` in **image-space pixels** — no calibration, no rendering,
no framework dependencies. Physical-unit conversion (`toPhysicalLength`,
`toPhysicalArea`) lives in `@osdlabel/decoration`.

## Installation

```bash
npm install @osdlabel/geometry
```

`@osdlabel/decoration` re-exports this package's entire surface, so if you
already depend on `@osdlabel/decoration`, `osdlabel`, `@osdlabel/solid`, or
`@osdlabel/react` you can import these functions from there instead of adding a
dependency.

## What's inside

- Measurements: `area`, `perimeter`, `length`, `radius`
- Point math: `distance`, `centroid`, `midpoint`
- `boundingBox` — axis-aligned bounds of any geometry
- `circleToBoundingRectangle` — converts a circle geometry to the rectangle that
  bounds it (backs the "convert to rectangle" annotation action)

Every function accepts any `Geometry`, so callers never branch on
`geometry.type` themselves:

- `area` returns image-px² for rectangles, circles, and polygons, and `0` for
  zero-area geometries (points, lines, polylines). Polygon area uses the
  absolute shoelace area, so winding direction doesn't matter.
- `perimeter` is the closed-perimeter of rectangles, circles, and polygons, and
  `0` for open shapes — use `length` for those.
- `length` is the open-curve length of lines and polylines; for closed shapes it
  equals `perimeter`.
- `radius` returns `number | undefined` — it is the only geometry-specific
  accessor, defined for circles alone.

## Usage

```ts
import { area, boundingBox, circleToBoundingRectangle } from '@osdlabel/geometry';

const px = area(annotation.geometry); // square image pixels

if (annotation.geometry.type === 'circle') {
  const rect = circleToBoundingRectangle(annotation.geometry);
}
```

## License

BSD-3-Clause. Part of the [osdlabel](https://github.com/osdlabel/osdlabel) monorepo.
