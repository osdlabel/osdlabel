---
'@osdlabel/annotation': patch
'@osdlabel/viewer-api': patch
'@osdlabel/decoration': patch
'osdlabel': patch
---

Make bare `Annotation` constructible: its default extension is now `Record<never, never>` instead of `Record<string, never>` (#165).

`Record<string, never>` is an index signature that maps _every_ key to `never`, so in `BaseAnnotation & Record<string, never>` each field intersected with `never`. The type advertised as "no extensions" could be read, but no object literal could satisfy it:

```ts
const a: Annotation = { id, geometry, toolType: 'point', createdAt, updatedAt };
// error TS2322: Type 'AnnotationId' is not assignable to type 'never'.
```

`Omit<Annotation, 'createdAt' | 'updatedAt'>` degenerated the same way, to `{ [k: string]: never }`.

`Record<never, never>` is a mapped type over no keys, so bare `Annotation` is now structurally `BaseAnnotation`. Excess-property checks on fresh literals still apply, and an explicit extension (`Annotation<MyFields>`) still requires its fields.

This only widens types — anything assignable before is still assignable — so no consumer code needs to change. The same default is updated on every generic that carried it: `AnnotationState`, `getAllAnnotationsFlat`, `DecorationContext`, `DecorationProvider`, `composeProviders`, `withSelectionEmphasis`, `createMeasurementProvider`, `createLabelProvider`, `createDistanceProvider`, `AnnotationPair`, `DistanceProviderOptions`, `DeserializeResult`, `LiveDecorationUpdateOptions` and `enableLiveDecorationUpdates`.
