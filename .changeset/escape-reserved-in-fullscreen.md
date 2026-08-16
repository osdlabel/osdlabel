---
'osdlabel': patch
'@osdlabel/react': patch
'@osdlabel/solid': patch
---

Ignore `Escape` while an element is displayed fullscreen

The browser exits fullscreen on `Escape` and the keypress cannot be
intercepted, so the annotator acting on it too made one press do two unrelated
things: leave fullscreen _and_ deselect, clear the active tool, or cancel an
in-progress polyline, with the second effect hidden behind the transition.

The guard covers all four `Escape` handlers — the vertex editor's exit, the
polyline and free-hand cancels, and the global cancel — and applies whenever
_any_ element is fullscreen, including one your own app put there. Every other
shortcut keeps working. Browser-native fullscreen (F11, kiosk mode) is
unaffected, since `Escape` does not exit those either.

Also fixes three package root barrels that were missing exports available from
their sub-path barrels: `useKeyboard` from `@osdlabel/react`, and
`ActiveToolKeyHandlerRef` and `FpsCounter` from `@osdlabel/solid`.
