---
'osdlabel': minor
'@osdlabel/solid': patch
'@osdlabel/react': patch
---

`<GridControls>`' popover no longer gets clipped near a right edge: it opens leftward when opening rightward would be cut off (#147).

The popover was anchored to its button's left edge, so it always opened down and to the right. A host that put the control near a right edge, such as a hand-composed toolbar or a narrow slot, got a popover cut off by the window or by a container that hides overflow, with the far columns unreachable.

Each time the popover opens, it is now measured before the browser paints and lined up with the button's right edge instead whenever the rightward placement would be clipped. The bounds are the viewport narrowed by every element that actually clips the popover, following its containing-block chain in the flat tree (through shadow roots and slots). Overflow other than `visible` and paint containment (including `content-visibility`'s) clip. Absolutely and fixed-positioned boxes skip ancestors that do not contain them, where transforms (individual `translate` / `rotate` / `scale` included), `perspective`, `transform-style: preserve-3d`, filters, layout or paint containment and matching `will-change` values also make an ancestor a containing block. A top-layer element (fullscreen, a modal `<dialog>`, an open popover) ends the chain, and a `<body>` whose overflow goes to the viewport, or a `display: contents` element, does not clip. Rightward stays the default whenever it fits, so the stock `<Annotator>` layout is unchanged. The popover exposes its choice as `data-alignment="start" | "end"`.

`osdlabel` exports the two pieces for hosts building a similar dropdown: `choosePopoverAlignment(anchor, popoverWidth, bounds)`, a pure decision that prefers `'start'`, falls back to `'end'`, and picks the smaller overflow when neither fits; and `getHorizontalClipBounds(element)`, which finds those bounds in the DOM. `'start'` and `'end'` are physical (left and right), not logical.
