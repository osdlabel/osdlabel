---
'osdlabel': patch
---

Labels and measurements follow a line, polyline or polygon while it is sheared.

Holding **Shift** on a side handle shears a line, polyline or polygon, and its stored points follow the shear. Fabric reports each step of that drag as `object:skewing`, which `enableLiveDecorationUpdates` did not listen for, so the shape's labels, measurements and other decorations stayed where they were for the whole drag and jumped to the new shape on release. They now follow it every frame, as they follow a move, a resize or a rotation, with the same one-recompute-per-animation-frame throttling, and nothing is scheduled when no decoration providers are configured.
