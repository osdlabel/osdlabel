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
- **Earlier releases cannot read a document that holds a mask.** Their schema
  rejects `geometry.type: 'mask'` and `toolType: 'segmentationBrush'`, and a
  schema failure costs the whole document, vector annotations included. Export
  without masks if an older consumer must read the file.

## Breaking for TypeScript consumers

Several types widened. If you compile against these packages, expect errors in
the following places:

- **`Geometry` gained `MaskGeometry`.** Exhaustive `switch (geometry.type)`
  statements — anything relying on a `never` fallthrough, `noImplicitReturns`,
  or exhaustive return-type narrowing — need a `'mask'` case.
- **`GeometryType` gained `'mask'`.** Derived from the `Geometry` union, so any
  `Record<GeometryType, T>` — icon maps, per-shape handlers — needs a new entry,
  the same way `Record<ToolType, T>` does.
- **`ToolType` gained `'segmentationBrush'`.** `ConstraintStatus` (so a hand-built one needs a `segmentationBrush` entry; prefer `computeConstraintStatus`) and any `Record<ToolType, T>` (custom
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
  `COCO_MAX_INTEROP_IMAGE_PIXELS`); the decode guards `assertBoxInsideImage` and `assertCountableImage`,
  for a third-party codec that honours `maxPixels`, and `MAX_IMAGE_SIDE`, the
  longest image side a mask may record (2^26, the same bound the validation
  schema applies); and the COCO payload types
  `CocoRleSegmentation` / `CocoRleUncompressedSegmentation`.
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
  `MaskRawAnnotationDataSchema`, and the bounds `MAX_MASK_PIXELS`,
  `MAX_MASK_COUNTS_LENGTH`, `MAX_IMAGE_DIMENSION`.
- **`@osdlabel/geometry` and `@osdlabel/decoration`** learn masks: `area` is the
  exact `pixelCount`, `perimeter` and `length` are `0`, `centroid` and
  `boundingBox` come from the bounding box, and `createMeasurementProvider`
  anchors a mask's label at that centre and emits an area but no perimeter or
  length line. `getGeometryFromFabricObject` now declares its true return type,
  `VectorGeometry | null`, so it composes with `buildFabricObjectFromGeometry`.
- **`osdlabel`**: `createMaskAnnotation` + `CreateMaskAnnotationOptions`,
  `maskAnnotationFields` + `MaskAnnotationFields`,
  `buildSegmentationBrushConfig` + `BrushConfigAccessors` /
  `BrushConfigDispatchers`, `nextBrushRadius`, `BrushOptions`,
  `DEFAULT_MAX_TOTAL_MASK_PIXELS`, and `SerializeOptions` /
  `DeserializeOptions` / `ExportedAnnotation` for the new `maskCodec`,
  `maskCodecs`, `maxMaskPixels` and `maxTotalMaskPixels` options on
  `serialize` / `deserialize` (`serialize` takes `maxMaskPixels` too, for a
  host that raised the brush's cap). `canAddAnnotation(status, type)` says
  whether a tool may add an annotation, which for the brush is no longer what
  `enabled` says (below). The selected-mask styling helpers `MaskTintState`,
  `swapMaskTints`, `MaskTintSwapHost` and `MaskSwapOutcome` are exported for a
  host rendering masks itself. Most of `@osdlabel/mask` and the mask types from
  `@osdlabel/annotation` are re-exported here too.
- **`@osdlabel/solid` and `@osdlabel/react`**: a `brushOptions` prop on
  `Annotator` and `AnnotatorProvider` (`maxPixels`, `onCapacityExceeded`,
  `maskStyle`), plus `setBrushRadius`, `setBrushErasing`, and
  `adjustBrushRadius` actions.

## The selected mask is told apart from the others

A mask has no handles to show when selected, and every mask renders in its
own tint (the recorded `fill`, else `DEFAULT_MASK_FILL` — the same for every
mask the brush paints), so nothing marked the one a refining stroke would paint
into. While a mask on the image is selected, both bindings now dim that image's
other masks to 40% of their opacity (`DEFAULT_UNSELECTED_MASK_OPACITY`). `brushOptions.maskStyle`
(`MaskStyle`) tunes it: `unselectedOpacity` sets the dimming (`1` turns it off)
and `selectedFill` recolours the selected mask, display only — the recorded
`fill` and everything exported are unchanged, and the brush's live preview
paints in that tint while refining. Dimming is a per-object opacity; recolouring
re-decodes only the two masks whose tint changed.

For hosts with their own cell renderer, `osdlabel` exports the pieces:
`maskOpacityFor`, `maskFillFor`, `applyMaskSelectionStyle`, `replaceMaskObject`
and `unselectedMaskOpacity`; `createFabricObjectFromRawData` takes an optional
`{ maskFill }` (`CreateFabricObjectOptions`); and `BrushConfigAccessors` gained
`getSelectedFill`. `osdlabel` also now exports `DeserializeSkip` (the element
type of `DeserializeResult.skipped`) and the mask bounds `MAX_MASK_PIXELS`,
`MAX_MASK_COUNTS_LENGTH` and `MAX_IMAGE_DIMENSION` from `@osdlabel/validation`.

## Hardening on the import path

`deserialize` now decodes every mask it is given, canonical ones included, and
bounds that work: `maxMaskPixels` caps any one mask and `maxTotalMaskPixels`
caps the document. Annotations are grouped into null-prototype maps, so a
crafted `imageId` can no longer reach `Object.prototype` — that last one fixes
behaviour that predates this change.

Rendering also isolates each annotation, so a mask that cannot be rebuilt
degrades alone instead of blanking its whole grid cell.

- **The run lengths are bounded by the box before they are decoded.** A
  payload for a one-pixel mask could carry tens of megabytes of varints and
  buy seconds of work under a cap of 1; it is now refused in constant time.
  The COCO decoders refuse fractional run lengths, counts that are not an
  array or a string, no runs at all for an image that has pixels, and a
  malformed `size`, each by name; a third-party codec's failure names the
  codec in `skipped[].reason`, and a payload that is not an object is
  reported as such. The encoders refuse an image wider or taller than
  `MAX_IMAGE_SIDE` (2^26), which the schema already refused on the way back
  in, and a box placed between pixels. A degenerate box encodes as the empty
  mask.
- **A mask that decodes under the cap can be refined under it.** The buffer
  rounded its allocation up to its growth chunk and so refused a mask the
  decoder had just admitted, which rendered but could not be painted into;
  the rounding now yields to the cap when the exact region fits.

## While painting

- **A mask count limit no longer locks the brush out of refining** (#154). At
  its limit the brush stays enabled while a mask it can refine is selected —
  one of the active context's masks on the current image — and a stroke on
  empty canvas is refused rather than starting another mask. With nothing
  refinable selected it is disabled like any other tool at its limit. The
  selection is therefore an input to `computeConstraintStatus`, which takes
  it as a fourth argument; `ConstraintStatus.enabled` means "the tool can do
  something now", and `canAddAnnotation(status, type)` is the question the
  tools ask before adding.
- **A palm beside a pen or mouse is ignored.** OpenSeadragon keeps one contact
  list per pointer type, so a touch landing while a pen press was held was a
  fresh press to it: the brush painted with the palm and committed the smear
  when it lifted. A contact of another pointer type while a press is held now
  reaches neither Fabric nor the tool, in paint and annotation mode alike. A
  chord — the primary button released while another is held — ends the press
  too, since no release would otherwise be reported for it. And a release the
  overlay forwards on OpenSeadragon's behalf no longer passes through the
  tracker's own element, where it removed a live contact and turned the second
  finger into a phantom press.
- **Delete waits for the release** while a stroke is open; deleting the mask
  being refined mid-stroke left the stroke nothing to commit into. The brush
  cancels on the `cancel` shortcut, not `polylineCancel` (both are Escape by
  default).
- **A mask is hit-tested by its pixels**, not its bounding box, so a click
  through a sparse mask reaches the shape beneath it.
- **A preview the engine refuses to allocate is a capacity failure.** The
  RGBA preview is four bytes a pixel over a box larger than the buffer's, and
  an engine past its canvas limit throws a plain error that escaped into
  Fabric's dispatch; it is reported through `onCapacityExceeded` and the
  stroke is abandoned with the mask unchanged.
