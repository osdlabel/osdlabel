# @osdlabel/decoration

Declarative annotation decorations (text labels, computed measurements, connector
lines) and calibrated geometry math for
[osdlabel](https://github.com/osdlabel/osdlabel), a web-based image annotation
library for gigapixel/DZI images.

Decorations are a **pure derivation** of annotation state — they are never
serialized, and they are recomputed whenever the underlying annotations change.
This package defines the data model and provider contract; the rendering happens
in `@osdlabel/fabric-osd`. Zero framework dependencies. Depends on
`@osdlabel/annotation`, `@osdlabel/geometry`, and `@osdlabel/viewer-api`.

## Installation

```bash
npm install @osdlabel/decoration
```

## What's inside

- `Decoration` discriminated union — `TextDecoration` (supports `zIndex`),
  `LineDecoration`, and `DomDecoration`
- `DecorationProvider` contract + `composeProviders`, `DecorationContext`
- Built-in providers: `createMeasurementProvider`, `createLabelProvider`,
  `createDistanceProvider`
- `withSelectionEmphasis` — opt-in style/z-index elevation for the selected
  annotation's decorations
- Measurements: `Measurement`, `toPhysicalLength`, `toPhysicalArea`,
  `formatMeasurement`
- Geometry math — `area`, `perimeter`, `length`, `radius`, `distance`,
  `centroid`, `midpoint`, `boundingBox`, `circleToBoundingRectangle` — now lives
  in [`@osdlabel/geometry`](https://github.com/osdlabel/osdlabel/tree/main/packages/geometry)
  and is re-exported here unchanged

## Usage

```ts
import {
  createLabelProvider,
  createMeasurementProvider,
  composeProviders,
} from '@osdlabel/decoration';

// composeProviders takes an array; createMeasurementProvider needs an options
// object saying which measurements to render (all flags default to false).
const providers = composeProviders([
  createLabelProvider(),
  createMeasurementProvider({ area: true, perimeter: true, length: true, radius: true }),
]);
```

## License

BSD-3-Clause. Part of the [osdlabel](https://github.com/osdlabel/osdlabel) monorepo.
