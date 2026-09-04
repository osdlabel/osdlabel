---
'osdlabel': minor
'@osdlabel/solid': minor
'@osdlabel/react': minor
---

Remove `buildToolCallbacks`, `ToolCallbackAccessors` and `ToolCallbackDispatchers`.

**Breaking.** These were exported from the `osdlabel` barrel (and transitively re-exported by `@osdlabel/solid` and `@osdlabel/react`) but had no callers anywhere — both framework hooks build their `ToolCallbacks` object inline in `useAnnotationTool`. `buildToolCallbacks` could not run, which is why mutating its `canAddAnnotation` to always return `true` survived the entire test suite.

If you were calling `buildToolCallbacks`, construct the `ToolCallbacks` object directly; `ToolCallbacks` itself is unchanged and still exported from `@osdlabel/fabric-annotations`.

`createAnnotationTool` is unaffected and now has direct test coverage asserting the concrete tool class returned for each `ToolType`.
