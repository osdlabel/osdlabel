---
'osdlabel': minor
'@osdlabel/fabric-annotations': minor
'@osdlabel/solid': minor
'@osdlabel/react': minor
---

An annotation that cannot be rendered no longer empties its image's canvas, and is no longer dropped silently (#209).

`ViewerCell` rebuilt every annotation's Fabric object with `Promise.all`. One whose stored `rawAnnotationData` named a Fabric class that isn't registered failed the whole rebuild, so the canvas stayed empty for that image and the error surfaced only as an unhandled promise rejection. One whose data was malformed for a known class was dropped by Fabric's loader with no error at all.

Each annotation is now built on its own. One that fails is skipped on the canvas and stays in state, and the rest of the image's annotations render as usual. The failure is reported:

- **`onAnnotationRenderError({ annotation, error })`:** a new optional prop on `AnnotatorProvider` and `Annotator`, called once per skipped annotation. If it throws, the error is logged with `console.error` and the remaining failures are still reported.
- **Without it:** a `console.warn` naming the annotation and its image.

A rebuild that is superseded, or cancelled because the cell unmounted, reports nothing.

**Behaviour change in `@osdlabel/fabric-annotations`:** `deserializeFabricObject` (and so `createFabricObjectFromRawData`) now rejects with Fabric's error when a Fabric payload cannot be revived, including malformed data that Fabric's `enlivenObjects` used to swallow. It still resolves to `null` for an envelope whose `format` is not `'fabric'`.

`osdlabel` exports the pieces both frameworks use: `settleAnnotationObjects(annotations, build)`, `reportAnnotationRenderFailures(failures, report)`, `warnAnnotationRenderError`, and the `AnnotationRenderFailure` and `SettledAnnotationObjects` types.
