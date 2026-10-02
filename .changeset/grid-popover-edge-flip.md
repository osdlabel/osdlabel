---
'osdlabel': minor
'@osdlabel/solid': patch
'@osdlabel/react': patch
---

`<GridControls>`' popover no longer gets clipped near a right edge: it opens leftward when opening rightward would be cut off (#147).

The popover was anchored to its button's left edge, so it always opened down and to the right. A host that put the control near a right edge, such as a hand-composed toolbar or a narrow slot, got a popover cut off by the window or by a container that hides overflow, with the far columns unreachable.

Each time the popover opens, it is now measured before the browser paints and lined up with the button's right edge instead whenever the rightward placement would be clipped. The bounds are the viewport narrowed by every ancestor whose `overflow-x` is not `visible`. Rightward stays the default whenever it fits, so the stock `<Annotator>` layout is unchanged. The popover exposes its choice as `data-alignment="start" | "end"`.

`osdlabel` exports the two pieces for hosts building a similar dropdown: `choosePopoverAlignment(anchor, popoverWidth, bounds)`, a pure decision that prefers `'start'`, falls back to `'end'`, and picks the smaller overflow when neither fits; and `getHorizontalClipBounds(element)`, which finds those bounds in the DOM.
