---
'@osdlabel/fabric-osd': minor
'@osdlabel/fabric-annotations': minor
---

Identify a double click's own vertices by press sequence instead of screen distance.

A double click delivers both of its `pointerdown`s before `onDoubleClick`, so a tool that accumulates points on press has already picked up extra vertices — two, one, or none, because a press landing on an existing annotation is suppressed and never reaches the tool, and a press may instead have closed the path. `PolylineTool` decided which case it was geometrically, measuring the last two vertices against the release point.

That was inexact in one narrow case: with the first press suppressed _and_ the previous vertex within the first-press bound of the release, it dropped the vertex the second press placed. It also hand-composed OpenSeadragon's `clickDistThreshold` and `dblClickDistThreshold` into two constants, while `FabricOverlay` reads those off the tracker at runtime — so changing `OpenSeadragon.DEFAULT_SETTINGS.dblClickDistThreshold` moved one and not the other.

`FabricOverlay` now stamps every forwarded `pointerdown` with a monotonic press sequence, exposed as `ToolOverlay.pressSeqOf(event)`, and passes the pair of sequences that formed the gesture as an optional third argument to `onDoubleClick`. A tool stamps each accumulated entry with the sequence that placed it, and drops the tail entry only when it carries the _second_ press's sequence and the entry before it carries the first's. That preserves the existing behaviour exactly — the path still ends at the double-clicked point, because the gesture's first press places a real vertex and only its second is redundant — while making all three counts one rule: a press that never reached the tool stamped no entry, so a gesture that contributed a single vertex leaves it alone rather than discarding a deliberate click.

`pressSeqOf` is keyed on the synthetic event the overlay dispatches — the one a tool receives — and populated only for presses, so every other event returns `undefined`. `undefined` means "not a tracked press", never a stale number, and halts the scan rather than matching.

Both additions are optional or additive: `DoubleClickCallback` and `AnnotationTool.onDoubleClick` gain a trailing optional parameter, which existing implementations remain assignable to. `ToolOverlay` gains a required `pressSeqOf`, so a custom implementation of that interface must add it — hence minor rather than patch.

`SECOND_PRESS_SCREEN_PX` and `FIRST_PRESS_SCREEN_PX` are gone from `@osdlabel/fabric-annotations`.
