---
'@osdlabel/annotation': minor
'@osdlabel/annotation-context': minor
'@osdlabel/decoration': minor
'@osdlabel/fabric-annotations': minor
'@osdlabel/fabric-osd': minor
'@osdlabel/geometry': minor
'@osdlabel/mask': minor
'@osdlabel/osd-helper': minor
'@osdlabel/react': minor
'@osdlabel/solid': minor
'@osdlabel/validation': minor
'@osdlabel/viewer-api': minor
'osdlabel': minor
---

Add a raster segmentation brush: paint and erase mask annotations, with pluggable
serialization and COCO RLE built in.

The new `@osdlabel/mask` package holds the pixel storage and codecs. A mask is
stored as a dense buffer covering only the painted bounding box, so painting
stays affordable on deep-zoom images. Masks are held in annotation state in a
neutral canonical encoding; `serialize(state, { maskCodec })` re-encodes the
payload for export and `deserialize(doc, { maskCodecs })` reads it back. The
built-in COCO RLE codec is verified byte-for-byte against `pycocotools`.

## Breaking at runtime

Two behaviour changes, both on the import path:

- **`deserialize` returns null-prototype maps.** `byImage` and each per-image
  map are now `Object.create(null)`, so a crafted `imageId` cannot reach
  `Object.prototype`. Code calling `byImage.hasOwnProperty(id)` will now throw;
  use `Object.hasOwn(byImage, id)` or `id in byImage`.
- **A mask whose pixels cannot be decoded no longer fails the import.** It is
  dropped and reported in the new `DeserializeResult.skipped`, so one corrupt
  annotation does not cost you the rest of the document. Check `skipped` if
  partial data is not acceptable for your use — it is empty on a clean load.
  Schema violations and a blown decode budget still throw.

## Breaking for TypeScript consumers

Several types widened. If you compile against these packages, expect errors in
the following places:

- **`Geometry` gained `MaskGeometry`.** Exhaustive `switch (geometry.type)`
  statements — anything relying on a `never` fallthrough, `noImplicitReturns`,
  or exhaustive return-type narrowing — need a `'mask'` case.
- **`GeometryType` gained `'mask'`.** Derived from the `Geometry` union, so any
  `Record<GeometryType, T>` — icon maps, per-shape handlers — needs a new entry,
  the same way `Record<ToolType, T>` does.
- **`ToolType` gained `'segmentationBrush'`.** Any `Record<ToolType, T>` (custom
  toolbars, label maps, icon maps) needs a new entry.
- **`FabricFields.rawAnnotationData` widened** from `FabricRawAnnotationData` to
  `AnnotationRawData`, a union with the new mask envelope. Code reading
  `.fabricVersion`, or passing the value to `deserializeFabricObject`, or
  treating `.data` as a Fabric object, must narrow on `format` first.
- **`UIState` gained `brushRadius` and `brushErasing`.** Code constructing a
  `UIState` literal (custom stores, test fixtures, SSR payloads) should use
  `createInitialUIState()` and spread overrides, rather than listing fields.
- **`OsdFieldsSchema.rawAnnotationData` is now a variant**, so
  `v.InferOutput<typeof OsdAnnotationSchema>` widens correspondingly.
- **`KeyboardShortcutMap` gained `segmentationBrushTool`,
  `increaseBrushRadius`, and `decreaseBrushRadius`.** Passing a partial map to
  `keyboardShortcuts` is unaffected; constructing a complete
  `KeyboardShortcutMap` literal needs the three new keys. Spread
  `DEFAULT_KEYBOARD_SHORTCUTS` instead of listing fields.

  Note the default bindings for the last two are `]` and `[`, **the same keys
  as `increaseGridRows` / `decreaseGridRows`**. The brush claims them for the
  whole time it is the active tool, so grid-row resizing is unavailable while
  it is selected. Resizing the brush between strokes is the far likelier intent
  there, but rebind either side if you disagree.

- **`OverlayMode` gained `'paint'`.** Any exhaustive `switch` over it needs the
  new case. Fabric receives pointer input in this mode but objects are inert,
  which is what stops a brush stroke dragging a shape it paints over.
- **`buildFabricObjectFromGeometry` and `createAnnotationFromGeometry` narrowed
  their parameter** from `Geometry` to the new `VectorGeometry`
  (`Exclude<Geometry, MaskGeometry>`). Code that passes a value typed as the
  full `Geometry` union must narrow first.

## Masks are not reconstructible from geometry

Unlike every other geometry, a mask is **not** reconstructible from its
`geometry` alone — that carries only a bounding box and a pixel count, and the
pixels live in `rawAnnotationData`. This is why the two helpers above exclude
masks from their parameter type: passing one is a compile error that points you
at `createMaskAnnotation(snapshot, options)` and `buildMaskFabricObject`, rather
than a `null` or a throw discovered at runtime. A JavaScript caller, who gets no
compile error, now gets a `TypeError` naming those helpers instead of failing
several frames later inside Fabric.

## New API

- **`@osdlabel/mask`** (new package): `MaskBuffer` (with the optional
  `reserve`), `BoundedDenseMaskBuffer` + `BoundedDenseMaskBufferOptions`,
  `MaskSnapshot`, `MaskRegion`, `emptySnapshot`, `snapshotPixelCount`,
  `stampCircle`, `strokeSegment`, `MaskCapacityExceededError`,
  `DEFAULT_MAX_MASK_PIXELS`, `assertDecodableArea`, `assertDecodableCount`,
  `assertDecodableOrigin`; the canonical codec
  (`canonicalMaskCodec`, `CanonicalMaskData`, `CANONICAL_MASK_FORMAT`,
  `encodeCanonical`, `decodeCanonical`, `toRuns`, `fromRuns`); the codec
  contract (`MaskCodec`, `MaskDecodeOptions`, `MaskCodecRegistry`,
  `createMaskCodecRegistry`); and COCO (`cocoRleCodec`,
  `cocoRleUncompressedCodec`, `COCO_RLE_FORMAT`,
  `COCO_RLE_UNCOMPRESSED_FORMAT`, `snapshotToCocoCounts`,
  `cocoCountsToSnapshot`, `encodeCocoCountsString`, `decodeCocoCountsString`,
  `cocoBbox`, `cocoArea`, `isCocoInteropSafe`,
  `COCO_MAX_INTEROP_IMAGE_PIXELS`).
- **`@osdlabel/annotation`**: `MaskGeometry`, `VectorGeometry`,
  `MASK_RAW_FORMAT`, `MaskRawData`, `MaskRawAnnotationData`.
- **`@osdlabel/viewer-api`**: `MIN_BRUSH_RADIUS`, `MAX_BRUSH_RADIUS`,
  `DEFAULT_BRUSH_RADIUS`.
- **`@osdlabel/fabric-annotations`**: `SegmentationBrushTool`,
  `SegmentationBrushToolConfig`, `BrushStrokeCommit`, `BrushTarget`,
  `buildMaskFabricObject`, `BuildMaskFabricObjectOptions`,
  `DEFAULT_MASK_FILL`, `AnnotationRawData`.
- **`@osdlabel/fabric-osd`**: the `'paint'` `OverlayMode`;
  `FabricOverlay.applyModeToObject(obj, readOnly)`, now the single authority for
  an object's interaction flags and needed by any host with a custom cell
  renderer; and `FabricOverlay.getImageSize()`.
- **`@osdlabel/validation`**: `MaskGeometrySchema`,
  `MaskRawAnnotationDataSchema`.
- **`osdlabel`**: `createMaskAnnotation` + `CreateMaskAnnotationOptions`,
  `maskAnnotationFields` + `MaskAnnotationFields`,
  `buildSegmentationBrushConfig` + `BrushConfigAccessors` /
  `BrushConfigDispatchers`, `nextBrushRadius`, `BrushOptions`,
  `DEFAULT_MAX_TOTAL_MASK_PIXELS`, and `SerializeOptions` /
  `DeserializeOptions` / `ExportedAnnotation` for the new `maskCodec`,
  `maskCodecs`, `maxMaskPixels` and `maxTotalMaskPixels` options on
  `serialize` / `deserialize`. Most of `@osdlabel/mask` and the mask types from
  `@osdlabel/annotation` are re-exported here too.
- **`@osdlabel/solid` and `@osdlabel/react`**: a `brushOptions` prop on
  `Annotator` and `AnnotatorProvider` (`maxPixels`, `onCapacityExceeded`), plus
  `setBrushRadius`, `setBrushErasing`, and `adjustBrushRadius` actions.

## Hardening on the import path

`deserialize` now decodes every mask it is given, canonical ones included, and
bounds that work: `maxMaskPixels` caps any one mask and `maxTotalMaskPixels`
caps the document. Annotations are grouped into null-prototype maps, so a
crafted `imageId` can no longer reach `Object.prototype` — that last one fixes
behaviour that predates this change.

Rendering also isolates each annotation, so a mask that cannot be rebuilt
degrades alone instead of blanking its whole grid cell.
