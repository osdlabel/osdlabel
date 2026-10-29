# @osdlabel/validation

[Valibot](https://valibot.dev/) schema implementations for
[osdlabel](https://github.com/osdlabel/osdlabel), a web-based image annotation
library for gigapixel/DZI images.

All osdlabel validation is schema-based and
[Standard Schema](https://standardschema.dev/) compatible — there are no manual
type-guard validators anywhere in the project. Depends on `@osdlabel/annotation`
and `valibot` (peer dependency).

## Installation

```bash
npm install @osdlabel/validation valibot
```

## What's inside

- `GeometrySchema`, `PointSchema`, `ToolTypeSchema`
- `BaseAnnotationSchema`, `OsdFieldsSchema`, `OsdAnnotationSchema`
- `FabricRawAnnotationDataSchema`

## Usage

```ts
import * as v from 'valibot';
import { OsdAnnotationSchema } from '@osdlabel/validation';

const result = v.safeParse(OsdAnnotationSchema, untrustedInput);
if (result.success) {
  // result.output is a validated annotation
}
```

Besides each field, `OsdAnnotationSchema` checks that an annotation's saved
Fabric object is the class that paints its geometry's type: `Rect` for a
rectangle, `Circle` for a circle or a point, `Line`, `Polyline` and `Polygon`
for the others. The saved object is what is painted and the geometry is what is
measured, so a mismatch is reported with an issue naming the annotation and
both types.

It also checks that the annotation's `toolType` is a tool that draws its
geometry's type: the tool of the same name for a rectangle, circle, line or
point, and `polyline` or `freeHandPath` for a polyline or a polygon (either
tool closes a path into a polygon). Constraints count annotations by
`toolType`, so another pairing is reported with an issue naming the
annotation, its geometry type, its `toolType` and the tool types that draw it.

`deserialize` in `osdlabel` validates each annotation with this schema.

## License

BSD-3-Clause. Part of the [osdlabel](https://github.com/osdlabel/osdlabel) monorepo.
