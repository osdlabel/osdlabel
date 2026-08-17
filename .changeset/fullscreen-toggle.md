---
'osdlabel': minor
'@osdlabel/react': minor
'@osdlabel/solid': minor
---

Add a fullscreen toggle to the annotator

The view controls gain a fullscreen button that puts the whole annotator —
toolbar, filmstrip, grid and status bar — into the browser's native fullscreen
mode. Hide it with `showFullscreenControl={false}` on `<Annotator>` or
`<ViewControls>`; it hides itself where the browser has no element-level
Fullscreen API, such as iPhone Safari or an `<iframe>` without
`allow="fullscreen"`.

Which element goes fullscreen is resolved most-specific-first: the new
`fullscreenTarget` prop (an element or a getter), then whatever claimed
`fullscreenTargetRef` on the annotator context, and finally the document
element so the control is never inert. `<Annotator>` claims the ref with its
own root; a layout composed by hand claims it the same way, on the element
wrapping the annotator UI.

New `useFullscreen` hook in both framework packages, plus `getFullscreenElement`,
`isFullscreenSupported`, `requestFullscreen`, `exitFullscreen`,
`toggleFullscreen`, `onFullscreenChange` and `resolveFullscreenTarget` from
`osdlabel`. The shim covers the standard Fullscreen API plus Safari's `webkit`
prefix, and requests resolve `false` rather than rejecting when the browser
refuses.

Entering and leaving preserves the centre of the image and scales it by the
change in the container's diagonal, so the round trip returns the exact zoom
and centre you started from.

**Possible visual change:** the `<Annotator>` root now paints
`background: #1a1a1a`. It painted nothing before, so in fullscreen the black
backdrop showed through every gap in the layout. If you embed the annotator in
a light-themed page you may see a dark rectangle where you previously saw your
own background — override it with `style={{ background: '...' }}`.

Also fixes Solid's `<Annotator>` silently dropping the `renderDomDecoration`
prop, which was never added to its hand-enumerated provider prop list.
