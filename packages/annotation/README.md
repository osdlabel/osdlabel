# @osdlabel/annotation

Pure annotation data model for [osdlabel](https://github.com/osdlabel/osdlabel), a
web-based image annotation library for gigapixel/DZI images.

This package has **zero dependencies** and contains no UI, serialization, or
validation logic — just the immutable data model that every other osdlabel
package builds on.

## Installation

```bash
npm install @osdlabel/annotation
```

## What's inside

- `Annotation<E>` — the generic annotation type (`BaseAnnotation & E`), extended
  via intersection by feature packages
- `BaseAnnotation`, `AnnotationStyle`, `AnnotationId` (branded id)
- `Geometry` — discriminated union of geometry types (rectangle, circle, line,
  point, polyline, path)
- `ToolType` and `toolTypeToGeometryType`
- `RawAnnotationData<TFormat, TData>` — generic raw-data container
- `createAnnotationId` and other id/util helpers

## Usage

```ts
import { type Annotation, type Geometry, createAnnotationId } from '@osdlabel/annotation';

const id = createAnnotationId('ann-1');
```

IDs are **branded types** — always construct them through the factory functions
rather than casting raw strings.

## License

BSD-3-Clause. Part of the [osdlabel](https://github.com/osdlabel/osdlabel) monorepo.
