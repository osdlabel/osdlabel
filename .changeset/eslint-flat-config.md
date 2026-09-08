---
'@osdlabel/solid': patch
---

Replace an `as any` cast in `ContextSwitcher` with `createAnnotationContextId`.

Behaviour is unchanged — the factory is an identity cast — but the component no longer launders a raw `string` into a branded `AnnotationContextId`, which is the convention the rest of the codebase follows. Surfaced by enabling ESLint across the workspace for the first time.
