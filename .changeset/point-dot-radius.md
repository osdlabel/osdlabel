---
'osdlabel': patch
---

A point's dot is always drawn at its style's radius, whatever its Fabric object's scale.

A point's geometry is only a position, but its dot is a Fabric `Circle`, and a scale on that object paints the dot larger or smaller than its style says, on screen and after every repaint, export and import of the saved data. Resizing a multi-selection puts one there: Fabric bakes the selection's scale into each member when the selection is dissolved, as the commit of a multi-selection edit does.

When `processObjectModified` (the commit both bindings run on an edit) commits a point whose Fabric object has any scale other than 1, or any skew, it now stores the point's position as before and replaces its Fabric data with data for an unscaled, unsheared dot at the radius it was saved with (its style's `pointRadius`, or `DEFAULT_POINT_RADIUS`), in the same style, keeping any custom properties the host registered. Resizing a multi-selection moves the points in it apart or together and leaves each dot its size.

A point saved with a scaled or sheared dot is not changed on load: it paints as saved until its next edit redraws it at its radius.
