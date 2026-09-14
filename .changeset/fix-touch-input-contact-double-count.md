---
'@osdlabel/fabric-osd': patch
---

Fix touch input in annotation mode.

`FabricOverlay` forwards each pointer event to Fabric by dispatching a synthetic `PointerEvent` on the upper canvas. That event bubbled back into the OSD `MouseTracker`'s own element, and OSD's `onPointerDown` calls `updatePointerDown` — and so `GesturePointList.addContact()` — _before_ it honours `eventInfo.stopPropagation`, so one real press was counted as two contacts. `addContact()` clamps that back for mouse and pen but not for touch, so on touch the count never reached the values OSD's handlers key off: `releaseHandler` fires only at zero, so the release was never forwarded to Fabric, and `updatePointerMove` took its two-contact pinch branch and threw on a gesture point that was never tracked.

The press is now dispatched non-bubbling, which keeps it out of the tracker's element. The move and release still bubble, because Fabric relocates its `pointermove` and `pointerup` listeners to the document once a press lands — making those non-bubbling would deliver the press to Fabric and never the release, which costs every gesture that commits on mouse-up: dragging an existing object and drawing a new one alike. Only `pointerdown` adds a contact, so only the press needs withholding; a doubled `pointerup` is absorbed by `removeContact()`'s floor at zero.

Touch drawing now works, and so does the touch double tap that finishes a polyline — double-click detection runs inside `releaseHandler`, which touch could not previously reach. One further side effect worth naming: mouse and pen input no longer trips OSD's clamp, which had been logging `GesturePointList.addContact() Implausible contacts value` on every press in annotation mode.

Touch _selection_ was never broken — Fabric commits it on the press, which was always delivered — so the bug was narrower than it appeared: touch gestures that need a release were inert, not touch as a whole. Each gesture also failed independently rather than wedging the tracker; the browser retires the touch pointer after `touchend`, and the `pointerout` / `pointerleave` that follow drive OSD's `stopTrackingPointer`, which clears the contact list.
