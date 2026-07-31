---
'osdlabel': minor
'@osdlabel/viewer-api': minor
'@osdlabel/react': minor
'@osdlabel/solid': minor
---

Add keyboard controls for cycling between annotation contexts.

- `.` activates the next annotation context and `,` the previous one, wrapping around at both ends. The shifted `>` / `<` variants are accepted too, mirroring the existing `=` / `+` grid-column handling. `KeyboardShortcutMap` gains `nextContext` / `previousContext`, overridable like any other binding.
- Contexts scoped to other images (via `AnnotationContext.imageIds`) are skipped, so a keypress only ever lands on a context usable on the image in the active cell. When the active context is unset — or is itself scoped out of the current image — the ring is entered at the end the direction implies: `next` lands on the first selectable context, `previous` on the last.
- The active tool and selected annotation are deliberately left untouched, making the shortcut equivalent to picking an entry in `ContextSwitcher`. `useAnnotationTool` already re-checks `constraintStatus` at draw time, so a tool the new context disallows is rejected there and shown disabled in the toolbar.
- New pure helpers `getSelectableContexts` and `getCycledContextId` are exported from `osdlabel`, keeping `mapKeyEventToActions` a thin dispatcher. It now returns `ContextAction` alongside UI and annotation actions; both framework `useKeyboard` hooks handle `SET_ACTIVE_CONTEXT`.
- The new `KeyboardMappingState.contexts` / `.activeContextId` fields are optional, so existing callers of `mapKeyEventToActions` keep compiling — cycling simply no-ops without them. **Breaking (React only):** `useKeyboard` takes a new required `contextState` argument between `uiState` and `activeImageId`; callers using the `AnnotatorProvider` are unaffected.
