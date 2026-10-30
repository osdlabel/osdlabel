---
'@osdlabel/fabric-osd': patch
---

A finger or a pen put down on the image while the mouse pans (Ctrl/Cmd held) no longer takes over. It used to stop the pan and draw, paint or move whatever it landed on, and OpenSeadragon's mouse navigation stayed switched on in annotation mode afterwards. It is now ignored until it is lifted, as one put down beside any other mouse press is, and the pan goes on. A pan whose release the system swallowed (a context menu, a switch to another window mid-drag) ends as soon as the browser takes back the pointer's capture, which Chrome does on its first move with no button held wherever it lands, or when the mouse, or a hovering pen, moves over the image with no button held; a pen that cannot hover ends it when it next touches down. Until then fingers are still ignored. The other way round, a pen or the mouse pressed while a finger pans ends the finger's pan and takes over, as it does a finger's other gestures.
