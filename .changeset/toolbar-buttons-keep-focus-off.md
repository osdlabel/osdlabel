---
'osdlabel': patch
'@osdlabel/react': patch
'@osdlabel/solid': patch
---

Stop toolbar clicks from parking keyboard focus on the button

Clicking a `<button>` focuses it, and a focused button is activated again by
`Enter` or `Space`. In an annotator, whose shortcuts are global and whose real
focus context is the image, that turns every toolbar click into a loaded gun:
after clicking Rotate, `Enter` rotated again; after clicking the fullscreen
toggle, `Enter` left fullscreen. Worse, `Enter` is the polyline-finish binding,
so finishing a shape re-fired whichever control had last been clicked.

The `Toolbar`, `ViewControls` and `GridControls` containers now suppress the
default on `mousedown` when the press lands on a button, so the button never
takes focus. The click still fires, and keyboard operation is untouched: `Tab`
still reaches every control and `Enter` / `Space` still activate it.

Exported as `preventButtonFocusSteal` from `osdlabel` for hosts that build
their own control surfaces around the annotator.
