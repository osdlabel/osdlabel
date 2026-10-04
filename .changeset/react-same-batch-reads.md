---
'@osdlabel/react': minor
---

An action now sees a write made earlier in the same batch, as in Solid (#217).

`AnnotatorProvider` used to hold its state in three `useReducer`s and hand `createActions` getters backed by refs it refreshed on render. Two actions issued from one event handler therefore had the second read the state from before the first: `addAnnotation` then `convertAnnotation` left a circle, and `setContexts` then `addAnnotation` ran the scope guard against the old contexts. The state now lives in a small store that applies each write immediately and that the provider reads through `useSyncExternalStore`, so the action getters and `useAnnotationTool`'s Fabric callbacks read the latest write.

`useAnnotator()` gains a `store` field. Its `getSnapshot()` and `getConstraintStatus()` return the state as of the latest write, for code outside render that must see its own writes; `annotationState`, `uiState`, `contextState` and `constraintStatus` stay the last rendered values. The `AnnotatorStoreReader` and `AnnotatorSnapshot` types are exported. Nothing existing changes shape: the reducers, `createActions`, the provider's props and the existing `useAnnotator()` fields keep their types, and `actions` stays referentially stable.

Two behaviours move with the store, neither visible to a host that dispatches from ordinary event handlers and effects:

- An action dispatched inside `startTransition` now renders synchronously, as `useSyncExternalStore` requires, instead of as a transition. The package itself uses no transitions.
- A reducer that throws now throws inside the handler that called the action, instead of during the next render.
