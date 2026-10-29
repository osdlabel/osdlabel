---
'@osdlabel/fabric-annotations': patch
---

Deleting a vertex in vertex-edit mode no longer moves the rest of the shape.

On a polygon or polyline in vertex-edit mode, Delete or Backspace removed the vertex, but when that vertex alone marked one side of the shape's bounding box (its leftmost, rightmost, topmost or bottommost point), every other vertex shifted as well: deleting the right-hand corner of the quadrilateral (100, 100), (200, 100), (250, 200), (100, 200) stored (125, 100), (225, 100), (125, 200). The shape was painted and saved in the shifted place. The remaining vertices now stay exactly where they were, for rotated, scaled and sheared shapes too, and what is saved is what is painted.

Delete and Backspace now also wait for the pointer to be released. Pressed while a vertex was being dragged, they deleted it at once, and the drag then moved a different vertex, which the release saved. While the pointer is held they now do nothing; after the release they delete as before. Escape still leaves vertex-edit mode mid-drag, and the drag carries on to its release.
