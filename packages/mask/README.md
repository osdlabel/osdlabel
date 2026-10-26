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

Everything that reads a mask — the codecs, the renderer, the exporters — reads
it through `MaskRaster`, a read-only view that makes no promise about storage:
`cells` (the box, in cells), the image size, `downsample`, `cellCount`,
`get(cx, cy)`, and `forEachSpan(visit, within?)`, which visits maximal runs of
set cells in row order, optionally limited to a window. `denseRaster` wraps a
snapshot, `decodeCanonicalRaster` keeps a payload's runs as runs without
allocating its box, and `forEachCheckedSpan` enforces the span contract on any
raster a host supplies. `forEachLevel0Span` walks the image pixels a raster
covers, for exporters to formats that know nothing of downsampling.

The box is capped at `DEFAULT_MAX_MASK_PIXELS` (64 Mi) cells. The cap is the
format's: the decoders apply it, osdlabel's validation schema applies it, and
`encodeCanonical` throws `MaskCapacityExceededError` rather than write a payload
past it.

## Downsampling

A mask may be stored at a power-of-two `downsample` from 1 to 2^16, each cell
standing for a `d`×`d` block of image pixels:

- The box in a payload, and the annotation's geometry, are in image (level-0)
  pixels at every downsample; the run lengths cover `ceil(width / d)` ×
  `ceil(height / d)` cells. `MaskSnapshot` and `MaskRaster` nest their box in
  cells as `cells`, so reading cells as image pixels is a compile error.
- The box is cell-aligned: `x` and `y` are multiples of `d`, and so are its
  right and bottom edges unless they are the image's own.
- Cell `(cx, cy)` covers `[cx·d, min((cx+1)·d, W)) × [cy·d, min((cy+1)·d, H))`;
  cells in the image's last column or row may be clipped by its edge.
- `snapshotPixelCount` (and the geometry's `pixelCount`) counts the image pixels
  covered exactly, clipped edge cells at their clipped size.
- A pixel-centred format such as OME-Zarr 0.6 needs a translation of
  `(d − 1) / 2` alongside the scale of `d`.
- A missing `downsample` means 1, and 1 is never written, so a full-resolution
  payload is unchanged. The format string stays `osdlabel-mask`.

```ts
const buffer = new BoundedDenseMaskBuffer({ imageWidth, imageHeight });
strokeSegment(buffer, x0, y0, x1, y1, radius, 1); // paint
strokeSegment(buffer, x0, y0, x1, y1, radius, 0); // erase
const snapshot = buffer.snapshot(); // tightly cropped
```

## Codecs

```ts
const registry = createMaskCodecRegistry(canonicalMaskCodec, cocoRleCodec);
const segmentation = registry.require('coco-rle').encode(denseRaster(snapshot));
// -> { size: [imageHeight, imageWidth], counts: '...' }
```

COCO RLE is **column-major over the full image** with counts alternating from
background, and the compressed string uses pycocotools' delta + 5-bit chunk
scheme — all of which this package implements faithfully, including counts
larger than 32 bits (a gigapixel image has more pixels than a 32-bit integer
can hold). Only the mask's bounding box is walked during encoding; the
surrounding background is accounted for arithmetically.

COCO has no downsample, so a downsampled mask is exported as the level-0
mask it stands for. Export is bounded at `MAX_COCO_RUNS` runs, the worst case
of a full-resolution mask within the cell cap, at every downsample: a counting
pass (`countCocoRuns` gives the exact figure) stops as soon as it passes the
bound and throws `CocoRunLimitExceededError`, so no full-resolution mask is
refused and a refusal allocates nothing. Below the bound a coarse mask with
fine structure still exports, slowly: 6.7 kB of d=16 alternating cell rows
needs 125 million runs, about 13 s and a 125 MB counts string. Where the runs
come back as an array (`snapshotToCocoCounts`, the uncompressed codec) the
bound is `MAX_COCO_ARRAY_RUNS` (2^27, an engine's array limit), so the single
most extreme mask is refused by name there and exports through the compressed
codec. Decoding takes `{ downsample }` in its
options and writes the runs straight into cells at it, refusing a payload that
is not constant within each cell; osdlabel's `deserialize` passes the
annotation's `geometry.downsample`.

Register your own `MaskCodec` for any other format; `decode` is optional for
export-only formats. A codec reads its input through `MaskRaster` and returns
one from `decode`. It receives downsampled masks only if it declares
`encodesDownsampled: true` — a codec written for full-resolution masks would
otherwise read a coarse mask's cell box as image pixels and misplace it. The
COCO codecs opt in: they export the level-0 mask a downsampled one stands for.

### Verified against pycocotools

The COCO output is checked against the reference implementation, not just
against our own decoder: for a hand-computed fixture, a painted blob with an
erased hole, an edge-touching stroke, and a single pixel at the origin,
`pycocotools.mask.encode` produces **byte-identical** counts to ours, and its
`decode` returns pixel-identical masks.

### pycocotools limitations worth knowing (not enforced here)

`pycocotools`' C decoder misreads two kinds of count when it reads a mask
back, and the area stays correct while the mask _moves_:

- it stores run lengths in **32 bits**, so a run past `0xffffffff` is
  truncated — a mask at the centre of a 100000x100000 image comes back near
  the top-left corner;
- it reads each delta (`counts[i] - counts[i - 2]`) into an `int` and
  sign-extends the last chunk with a shift too wide for it, so a delta below
  **-2^29** is misread, and every count after it. A huge background gap
  followed two runs later by a short one is enough: three pixels on a 24,000 x
  24,000 image come back with the right area and the wrong box.

Within `COCO_MAX_INTEROP_IMAGE_PIXELS` (2^29, about 0.54 gigapixels) neither
can happen. Beyond it, whether a mask is safe depends on its runs, and
`isCocoInteropSafe` decides from them, stopping at the first one out of
range. Our encoder and decoder handle every case correctly, and this package
does not refuse, clamp, or warn — the output is valid COCO, and the
constraint belongs to one downstream reader:

```ts
if (!isCocoInteropSafe(snapshot)) {
  // pycocotools would misplace this mask. Use the canonical codec,
  // or export a cropped region.
}
```
