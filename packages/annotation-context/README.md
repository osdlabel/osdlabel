# @osdlabel/annotation-context

Annotation contexts, constraints, and scoping for
[osdlabel](https://github.com/osdlabel/osdlabel), a web-based image annotation
library for gigapixel/DZI images.

A **context** defines an annotation task: which tools are available, how many of
each may be drawn (globally or per-image), and which images it applies to.

Depends on `@osdlabel/annotation` and `@osdlabel/viewer-api`. No framework
dependencies.

## Installation

```bash
npm install @osdlabel/annotation-context
```

## What's inside

- `AnnotationContext`, `AnnotationContextId` (branded id)
- `ToolConstraint`, `ConstraintStatus`, `ContextState`, `ContextFields`
- Scoping helpers: `isContextScopedToImage`, `getCountableImageIds`

## Usage

```ts
import type { AnnotationContext } from '@osdlabel/annotation-context';

const context: AnnotationContext = {
  id: createAnnotationContextId('tumor-detection'),
  label: 'Tumor Detection',
  tools: [
    { type: 'polyline', maxCount: 3 }, // max 3 globally
    { type: 'rectangle', maxCount: 2, countScope: 'per-image' },
    { type: 'point' }, // unlimited
  ],
};
```

## License

BSD-3-Clause. Part of the [osdlabel](https://github.com/osdlabel/osdlabel) monorepo.
