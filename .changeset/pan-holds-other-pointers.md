---
'@osdlabel/fabric-osd': patch
---

A finger or a pen put down on the image while the mouse pans (Ctrl/Cmd held) no longer takes over. It used to stop the pan and draw, paint or move whatever it landed on, and OpenSeadragon's mouse navigation stayed switched on in annotation mode afterwards. It is now ignored until it is lifted, as one put down beside any other mouse press is, and the pan goes on. The other way round, a pen or the mouse pressed while a finger pans ends the finger's pan and takes over, as it does a finger's other gestures.
