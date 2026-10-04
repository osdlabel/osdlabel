---
'@osdlabel/viewer-api': minor
'@osdlabel/osd-helper': minor
'osdlabel': minor
'@osdlabel/solid': minor
'@osdlabel/react': minor
---

`ImageSource.tileSource` accepts any tile source OpenSeadragon's `viewer.open()` takes, not just a URL. That covers an options object (IIIF, Zoomify, TMS, `{ type: 'image', url, buildPyramid: false }`), an inline DZI descriptor or a `TileSource` instance (#83).

The new `TileSourceSpec` type (`string | object`) is exported from `@osdlabel/viewer-api` and `osdlabel`. `openImage` gives OpenSeadragon a copy of a plain options object, and of a TiledImage options wrapper's plain `tileSource`, since OpenSeadragon writes into the tile source it opens, and passes anything else, such as a `TileSource` instance, as is. The new `isSameTileSource` in `@osdlabel/osd-helper` compares plain objects by value, and functions and class instances by identity. Both bindings use it to decide whether a cell's image changed, so re-creating an equal object does not reload the image.

This also fixes a SolidJS cell reloading its image the first time a new `ImageSource` arrived with the same URL.
