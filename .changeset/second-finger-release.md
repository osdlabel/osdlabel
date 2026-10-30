---
'@osdlabel/fabric-osd': patch
---

Lifting the finger that started a gesture now ends it, even while a second finger is still on the screen.

When a second finger touched the canvas during a move, a resize or a stroke, and the first finger lifted before it, the gesture was never finished. The shape stayed where the first finger left it on screen, but the stored geometry kept the old shape, so labels, measurements and exports did not match the screen. Lifting the second finger did not finish the gesture either. The next pointer movement anywhere (a mouse hover, a later touch) carried the shape on and saved it wherever that ended. A shape being drawn stayed an unsaved preview until a tap on the toolbar saved it, stretched to the button.

The first finger's lift now ends the gesture and saves it, as a mouse release does. A finger that touches down during a gesture does nothing until it is lifted and pressed again. Annotation mode has no two-finger gesture, so a second finger does not pinch-zoom there either. The same goes for a finger put down while a pen or the mouse draws, and for a pen and a mouse used at once: none of them starts a second gesture or moves the shape being dragged, and a mouse hovering during a finger's gesture moves nothing either. A touch never wins over a pen or a mouse, though: a pen or the mouse pressed while a finger's gesture is in progress takes the finger for a resting hand (a palm, or a finger left on the screen), so the finger's gesture is undone as a cancelled one is, and the pen or mouse draws.
