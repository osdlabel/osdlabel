---
'@osdlabel/solid': patch
'@osdlabel/react': patch
---

`<ViewerCell>` no longer adds stale annotation objects to its canvas (#160, #190).

The cell rebuilds its Fabric objects from state asynchronously: it clears the canvas, waits for every object to be built, then adds them. Two problems followed.

- **Duplicates (#160).** When a second rebuild started during that wait, both rebuilds added their objects, so the canvas could hold several copies of an annotation (three objects for one annotation was observed). It stayed out of sync with state until something triggered another rebuild.
- **Adds after unmount (#190).** When the cell unmounted mid-rebuild, for example after clearing it from the filmstrip, the rebuild still added its objects to the destroyed canvas.

A rebuild is now cancelled when the next one starts or when the cell unmounts, and a cancelled rebuild adds nothing. This replaces the previous image-id check, which ran before the wait and so could never catch either case.
