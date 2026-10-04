---
'@osdlabel/solid': minor
---

`keyboardShortcuts`, `vertexMarkers`, `vertexEditLongPressMs` and `vertexEditMoveTolerancePx` now follow changes after mount, as they already did in React (#219).

`AnnotatorProvider` used to read them once at setup and silently ignore later changes. They are now value-compared memos. A new binding takes effect on the next keypress, and a changed marker style or vertex-edit tuning rebuilds the active tool. An equal-valued object, such as an inline literal re-created by a parent, changes nothing. `useKeyboard` also accepts a getter for its `shortcuts`, read on every keypress; passing a plain map still works.
