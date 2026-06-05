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

## License

BSD-3-Clause. Part of the [osdlabel](https://github.com/osdlabel/osdlabel) monorepo.
