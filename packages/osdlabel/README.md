# osdlabel

Framework-agnostic core for [osdlabel](https://github.com/osdlabel/osdlabel), a
web-based image annotation library for gigapixel/DZI images, with rich drawing
tools, customizable annotation contexts, derived measurements, and serialization.

This package contains the shared business logic with **no UI framework
dependencies**. If you are building an app, you most likely want
[`@osdlabel/solid`](https://www.npmjs.com/package/@osdlabel/solid) or
[`@osdlabel/react`](https://www.npmjs.com/package/@osdlabel/react), which
re-export everything here plus components and hooks. Reach for `osdlabel`
directly when building a custom UI layer or your own framework binding.

## Installation

```bash
npm install osdlabel fabric openseadragon valibot
```

## What's inside

- `OsdAnnotation` composed type alias and the `OsdFields` extension bundle
- `serialize` / `deserialize` (versioned JSON document format),
  `SerializationError`, `DeserializeResult`
- Pure reducers — `applyAnnotationAction`, `applyUIAction`, `applyContextAction`
  — that work with both SolidJS `produce()` and Immer `produce()`, plus
  `validateAddAnnotation`
- Initial-state factories, `computeConstraintStatus`, and
  `countAnnotationsForContextAndType`
- Keyboard mapping: `mapKeyEventToActions`, `DEFAULT_KEYBOARD_SHORTCUTS`,
  `MAX_GRID_SIZE`
- Context cycling: `getCycledContextId`, `getSelectableContexts`
- `createAnnotationFromGeometry` — builds a complete annotation (id, style, raw
  Fabric data) from a geometry
- Tool factory: `createAnnotationTool`, `buildToolCallbacks`, and the pure
  processors `processObjectModified`, `processToolAddAnnotation`,
  `processToolUpdateAnnotation`, `processConvertCircleToRectangle`
- `VIEWER_CONTROL_SPECS` / `getToneValue` — the framework-agnostic registry of
  drag-driven viewer controls, so the Solid and React hooks configure the
  exposure/contrast gesture identically
- `enableLiveDecorationUpdates` — rAF-throttled live label-follows-shape updates
  during Fabric drags
- Re-exports the full `@osdlabel/decoration`, `@osdlabel/fabric-annotations`,
  `@osdlabel/fabric-osd`, and `@osdlabel/validation` public APIs

## Usage

```ts
import {
  serialize,
  deserialize,
  applyAnnotationAction,
  computeConstraintStatus,
  type OsdAnnotation,
} from 'osdlabel';

const doc = serialize(annotationState);
const { byImage } = deserialize(JSON.parse(json));
```

## License

BSD-3-Clause. Part of the [osdlabel](https://github.com/osdlabel/osdlabel) monorepo.
