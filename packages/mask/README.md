# @osdlabel/mask

Raster mask storage, brush rasterization, and pluggable mask codecs for
[osdlabel](https://github.com/osdlabel/osdlabel). Pure TypeScript with no
framework, Fabric, or OpenSeadragon dependencies.

## Three representations

Painting, storing, and exporting a mask have genuinely different requirements,
so this package keeps them separate:

| Layer            | Type                   | Why                                       |
| ---------------- | ---------------------- | ----------------------------------------- |
| Painting         | `MaskBuffer` (mutable) | fast stamping, no per-frame allocation    |
| Annotation state | `CanonicalMaskData`    | compact, immutable, format-neutral        |
| Downstream       | `MaskCodec` output     | consumers choose; COCO RLE ships built in |

The annotator never stores COCO internally — codecs translate only at the
boundary, so adopting another format changes nothing about how painting works.

## Storage

`BoundedDenseMaskBuffer` keeps a dense buffer covering **only the painted
bounding box**, growing on demand. This is the model CVAT and 3D Slicer
converged on, and it is what makes painting affordable on deep-zoom images:
cost scales with the area you paint, not the size of the image. A `maxPixels`
cap guards against a mask whose bounding box balloons.

`MaskBuffer` is an interface, so a tiled sparse implementation can replace the
dense one without touching the brush tool, the codecs, or the renderer.

```ts
const buffer = new BoundedDenseMaskBuffer({ imageWidth, imageHeight });
strokeSegment(buffer, x0, y0, x1, y1, radius, 1); // paint
strokeSegment(buffer, x0, y0, x1, y1, radius, 0); // erase
const snapshot = buffer.snapshot(); // tightly cropped
```

## Codecs

```ts
const registry = createMaskCodecRegistry(canonicalMaskCodec, cocoRleCodec);
const segmentation = registry.require('coco-rle').encode(snapshot);
// -> { size: [imageHeight, imageWidth], counts: '...' }
```

COCO RLE is **column-major over the full image** with counts alternating from
background, and the compressed string uses pycocotools' delta + 5-bit chunk
scheme — all of which this package implements faithfully, including counts
larger than 32 bits (a gigapixel image has more pixels than a 32-bit integer
can hold). Only the mask's bounding box is walked during encoding; the
surrounding background is accounted for arithmetically.

Register your own `MaskCodec` for any other format; `decode` is optional for
export-only formats.

### Verified against pycocotools

The COCO output is checked against the reference implementation, not just
against our own decoder: for a hand-computed fixture, a painted blob with an
erased hole, an edge-touching stroke, and a single pixel at the origin,
`pycocotools.mask.encode` produces **byte-identical** counts to ours, and its
`decode` returns pixel-identical masks.

### A pycocotools limitation worth knowing (not enforced here)

`pycocotools` stores run lengths in a **32-bit** array. A run longer than
`COCO_MAX_INTEROP_IMAGE_PIXELS` (4,294,967,295) is silently truncated when it
reads the mask back — the area stays correct while the mask _moves_. A mask at
the centre of a 100000x100000 image comes back near the top-left corner.

Our encoder and decoder handle those runs correctly, and this package does
not refuse, clamp, or warn about them — the output is valid COCO, and the
constraint belongs to one downstream reader. Since deep-zoom images routinely
exceed 4.29 gigapixels, an opt-in check is provided for callers who want it:

```ts
if (!isCocoInteropSafe(snapshot)) {
  // Masks from this image will not survive a pycocotools round-trip.
  // Use the canonical codec, or export a cropped region.
}
```
