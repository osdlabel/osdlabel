---
"@osdlabel/fabric-annotations": patch
---

Fix point annotations being incorrectly resizable. Point annotations now have `hasControls: false` set both when first drawn and when loaded from serialized state, so they can only be moved, not scaled.
