---
'@osdlabel/react': patch
---

An inline `keyboardShortcuts` prop no longer rebuilds the active tool on every host render (#152).

`AnnotatorProvider` merged `keyboardShortcuts` over the defaults in a `useMemo` keyed on the prop's identity, so the documented usage — `<Annotator keyboardShortcuts={{ rectangleTool: 'b' }} />` — produced a new shortcut map each time the host re-rendered. The map is a dependency of the tool lifecycle effect, so the active tool was deactivated and rebuilt, discarding an in-progress polyline or vertex edit, and the keyboard listener was re-subscribed. The map is now keyed by value: equal shortcuts keep the same map, and a changed binding still takes effect. Solid was not affected.
