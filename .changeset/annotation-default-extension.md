---
'@osdlabel/annotation': minor
'@osdlabel/viewer-api': minor
'@osdlabel/decoration': minor
'osdlabel': minor
---

Make bare `Annotation` constructible: its default extension is now `Record<never, never>` instead of `Record<string, never>` (#165).

`Record<string, never>` is an index signature that maps _every_ key to `never`, so in `BaseAnnotation & Record<string, never>` each field intersected with `never`. The type advertised as "no extensions" could be read, but no object literal could satisfy it:

```ts
const a: Annotation = { id, geometry, toolType: 'point', createdAt, updatedAt };
// error TS2322: Type 'AnnotationId' is not assignable to type 'never'.
```

`Omit<Annotation, 'createdAt' | 'updatedAt'>` degenerated the same way, to `{ [k: string]: never }`.

`Record<never, never>` is a mapped type over no keys, so bare `Annotation` is now structurally `BaseAnnotation`. Excess-property checks on fresh literals still apply, and an explicit extension (`Annotation<MyFields>`) still requires its fields.

**Building and assigning values only gets looser**: anything assignable to bare `Annotation` before still is, and values that carry extension fields are now assignable to it too.

**Reading arbitrary keys is now a type error.** The old index signature let any key through, typed `never`. With real keys only, code that relied on it stops compiling:

- `annotation.whatever` on bare `Annotation`: TS2339, where it used to compile as `never`.
- `for (const k in annotation) annotation[k]`: TS7053, since `k` is a `string` that no longer indexes the type.
- `keyof Annotation` narrows from `string` to the real field names, so a `keyof Annotation` variable holding any other string fails.

None of these could have been doing anything useful (every such read was `never`), but they compiled, so this is a minor bump rather than a patch. Code that uses an explicit extension, `Annotation<MyFields>`, is unaffected.

The same default is updated on every generic that carried it: `AnnotationState`, `getAllAnnotationsFlat`, `DecorationContext`, `DecorationProvider`, `composeProviders`, `withSelectionEmphasis`, `createMeasurementProvider`, `createLabelProvider`, `createDistanceProvider`, `AnnotationPair`, `DistanceProviderOptions`, `DeserializeResult`, `LiveDecorationUpdateOptions` and `enableLiveDecorationUpdates`.
