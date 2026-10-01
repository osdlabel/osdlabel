---
'@osdlabel/solid': patch
'@osdlabel/react': patch
---

The `<Annotator>` toolbar bar now wraps instead of overflowing a narrow host (#147).

The bar was a single flex row with no `flex-wrap`, and `<ViewControls>` alone is wide (rotate, flip, four exposure/contrast groups, reset, fullscreen). Below roughly 700px the row's content ran past the annotator's right edge, and because the root does not scroll, the fullscreen toggle and context switcher were clipped and unreachable.

Both the bar and `<ViewControls>` now set `flex-wrap: wrap` (the bar with a 4px row gap), matching what `<Toolbar>` already did for its tool buttons. At widths where everything fits, the layout is unchanged: one row. In a narrower host the bar grows taller instead, which the column layout below it absorbs.
