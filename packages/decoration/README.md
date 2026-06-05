# @osdlabel/decoration

Declarative annotation decorations (text labels, computed measurements, connector
lines) and calibrated geometry math for
[osdlabel](https://github.com/osdlabel/osdlabel), a web-based image annotation
library for gigapixel/DZI images.

Decorations are a **pure derivation** of annotation state — they are never
serialized, and they are recomputed whenever the underlying annotations change.
This package defines the data model and provider contract; the rendering happens
in `@osdlabel/fabric-osd`. Zero framework dependencies.

## Installation

```bash
npm install @osdlabel/decoration
```

## What's inside

- `Decoration` discriminated union — `TextDecoration` (supports `zIndex`) and
  `LineDecoration`
- `DecorationProvider` contract + `composeProviders`, `DecorationContext`
- Built-in providers: `createMeasurementProvider`, `createLabelProvider`,
  `createDistanceProvider`
- `withSelectionEmphasis` — opt-in style/z-index elevation for the selected
  annotation's decorations
- Geometry math: `area`, `perimeter`, `length`, `radius`, `distance`,
  `centroid`, `midpoint`, `boundingBox`
- Measurements: `Measurement`, `toPhysicalLength`, `toPhysicalArea`,
  `formatMeasurement`

## Usage

```ts
import {
  createLabelProvider,
  createMeasurementProvider,
  composeProviders,
} from '@osdlabel/decoration';

const providers = composeProviders(
  createLabelProvider(),
  createMeasurementProvider(), // area / perimeter / length / radius
);
```

## License

BSD-3-Clause. Part of the [osdlabel](https://github.com/osdlabel/osdlabel) monorepo.
