---
title: Auto-Segmentation
description: The Segment-Anything-style auto-segmentation tool — provider contract, modular encode/decode strategies, caching & abort mechanics, and the mask-to-polygon algorithms.
---

osdlabel ships an **auto-segmentation** tool: the user gives a cheap prompt — a
dragged box and/or a few foreground/background clicks — and a Segment-Anything-style
model returns a mask that becomes an ordinary, editable polygon annotation. The
model itself is never bundled. Instead, the library defines a small **provider
contract** that you implement (in-browser ONNX, a server endpoint, SAM 2/SAM 3, …),
mirroring the [`DecorationProvider`](/osdlabel/guides/decorations/) injection pattern.

This guide covers the contract, the modular encode/decode decomposition, the
caching and cancellation mechanics, and the pure mask-to-polygon algorithms —
with references for further reading and notes on planned work (holes / inner rings).

All types below live in `@osdlabel/segmentation` and are re-exported from the
`osdlabel`, `@osdlabel/solid`, and `@osdlabel/react` barrels.

## The provider contract

The tool consumes a single interface. Everything else is a way to build one.

```ts
interface SegmentationProvider {
  /** Heavy, once-per-image step: compute/cache the image embedding. Idempotent. */
  prepare(image: SegmentationImageRef, signal: AbortSignal): Promise<void>;
  /** Cheap, per-prompt step: run the decoder for the current prompt. */
  segment(
    image: SegmentationImageRef,
    prompt: SegmentationPrompt,
    signal: AbortSignal,
  ): Promise<SegmentationResult>;
  /** Optionally release cached per-image state. */
  dispose?(imageId: ImageId): void;
}
```

The `prepare` / `segment` split mirrors SAM's cost model: an expensive **image
encode** runs once per image, then a lightweight **decoder** runs per prompt for
instant interactivity.

```ts
interface SegmentationImageRef {
  readonly imageId: ImageId;
  readonly tileSource: string; // the ImageSource URL — resolve full-res yourself
  getViewportCanvas(): HTMLCanvasElement | null; // best-effort snapshot at current zoom
}

interface SegmentationPrompt {
  readonly box?: { x: number; y: number; width: number; height: number };
  readonly points?: ReadonlyArray<{ x: number; y: number; label: 0 | 1 }>; // 1=fg, 0=bg
}

interface SegmentationResult {
  readonly contours: ReadonlyArray<ReadonlyArray<Point>>; // closed rings, image-space px, largest-first
  readonly score?: number;
  readonly maskRle?: string;
}
```

All coordinates are **image-space pixels** — the same space annotation geometry is
stored in (see [Coordinate Systems](/osdlabel/guides/coordinate-systems/)). A
server-backed provider can ignore `getViewportCanvas()` entirely and use
`imageId` / `tileSource` to locate its own full-resolution copy; the model used is
implicit in the implementation, so the tool and annotation model stay
model-agnostic.

### Wiring it up

Pass a provider to the annotator and add a `segmentation` tool to a context:

```tsx
<Annotator
  images={images}
  contexts={[{ id: ctxId, label: 'Lesions', tools: [{ type: 'segmentation' }] }]}
  segmentationProvider={myProvider}
/>
```

When no provider is configured the `segmentation` tool is simply unavailable, so
the feature degrades gracefully. Interaction: drag a box or click foreground
points (Alt-click for background), watch the live preview, and press the finish
key (`Enter` by default) to commit the polygon — or `Escape` to discard.

## Modular encode/decode strategies

Rather than implement `prepare` + `segment` together, you can supply the two
halves separately and let the library join them. This is what makes running the
**encoder on a server** and the **decoder in the browser** a single, type-checked
composition.

```ts
interface SegmentationEncoder<TEmbedding> {
  encode(image: SegmentationImageRef, signal: AbortSignal): Promise<TEmbedding>;
  dispose?(imageId: ImageId): void;
}
interface SegmentationDecoder<TEmbedding> {
  decode(
    embedding: TEmbedding,
    image: SegmentationImageRef,
    prompt: SegmentationPrompt,
    signal: AbortSignal,
  ): Promise<SegmentationResult>;
  dispose?(): void;
}

const provider = composeSegmentationProvider(encoder, decoder);
```

The shared `TEmbedding` type parameter forces a compatible encoder/decoder pair at
compile time — and _is_ what distinguishes the decode topologies:

| Topology                          | `TEmbedding`                            | When                                                                                    |
| --------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------- |
| **Server encode → client decode** | the embedding tensor the server returns | heavy model server-side, instant per-click decode in the browser (the SAM-web standard) |
| **All-server (thin client)**      | an opaque `{ sessionId }` handle        | browser sends prompts, server returns contours                                          |
| **All-client (offline)**          | an in-memory tensor                     | small model, fully in-browser                                                           |

The model-agnostic math each real decoder needs (`maskToContours`, the
`resize-transform` helpers) ships in the same package so every decoder shares it.

## Caching & cancellation mechanics

There are **two independent cancellation lifetimes**, and keeping them separate is
the core of the design. `composeSegmentationProvider` owns one; the tool owns the
other.

### Layer 1 — the embedding cache (`composeSegmentationProvider`)

The cache stores a **promise**, not a resolved value:

```ts
function getEmbedding(image) {
  const existing = cache.get(image.imageId);
  if (existing) return existing.promise; // cache hit — even mid-flight
  const controller = new AbortController(); // the cache's OWN controller
  const promise = encoder.encode(image, controller.signal);
  cache.set(image.imageId, { promise, controller });
  promise.catch(() => {
    // evict failures so the next call retries
    if (cache.get(image.imageId)?.promise === promise) cache.delete(image.imageId);
  });
  return promise;
}
```

This yields four properties:

- **In-flight de-duplication.** Caching the promise the instant the encode starts
  means concurrent callers (e.g. `prepare` then a quick `segment`) share _one_
  encode. `prepare` is therefore an optional performance hint, not a correctness
  requirement — `segment` works without it.
- **The encode is cache-owned, not prompt-owned.** `encode` runs under the cache's
  _own_ `AbortController`, never the caller's `signal`. So when a prompt is
  superseded and its signal aborts, only the **decode** is cancelled; the
  expensive image encode keeps running and stays cached. (If it were tied to the
  prompt, rapid clicking would abort the encoder on every click and you'd never
  get an embedding.)
- **Failure eviction with an identity guard.** A rejected encode is removed so the
  next call retries instead of awaiting a poisoned promise. The
  `?.promise === promise` check ensures a late-firing failure from an old attempt
  can't delete a newer, healthy entry.
- **`dispose(imageId)`** is the only thing that aborts an encode: it cancels the
  in-flight encode, drops the cache entry (so a later request re-encodes), and
  forwards to `encoder.dispose` so per-image GPU/session resources are freed.

### Layer 2 — per-prompt supersession (`SegmentationTool`)

The tool decides when one prompt replaces the previous one. It pairs an
`AbortController` with a monotonic **request sequence number**:

```ts
const seq = ++this.requestSeq;
this.segmentController?.abort(); // cancel the previous decode
const controller = new AbortController();
this.segmentController = controller;
const result = await this.provider.segment(this.imageRef, prompt, controller.signal);
if (seq !== this.requestSeq || controller.signal.aborted) return; // drop stale results
```

The `seq` guard matters because an already-issued decode might still **resolve**
after a newer prompt started; comparing `seq` to the latest discards that stale
result even though its promise completed. So: the tool owns _prompt_ lifetime
(abort + seq), and `compose` guarantees that aborting a decode never harms the
shared encode.

## The mask-to-polygon algorithms

`maskToContours` turns a dense raster mask into ordered polygon rings in
image-space, ready to become a `PolygonGeometry`:

```ts
function maskToContours(mask: SegmentationMask, options?: MaskToContoursOptions): Point[][];

interface SegmentationMask {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array | Float32Array; // row-major; data[y*width + x]
}
interface MaskToContoursOptions {
  readonly threshold?: number; // values >= threshold are foreground (default 0.5)
  readonly simplifyTolerance?: number; // Douglas–Peucker epsilon in px; 0 disables (default 1)
  readonly minArea?: number; // drop components below this pixel area (default 0)
}
```

The pipeline chains four classic algorithms:

1. **Threshold.** One predicate handles both mask kinds: a `Uint8Array` (0/1)
   trivially passes `>= 0.5`, and a `Float32Array` of probabilities/logits is
   compared against the cutoff. Out-of-bounds reads count as background so the
   tracer can safely walk the grid edge.

2. **Connected components — flood fill (4-connectivity).** A raster scan finds the
   first unvisited foreground pixel; an iterative-stack flood fill (no recursion,
   so big blobs can't overflow) marks the whole component visited and returns its
   pixel **area**. Marking the entire component — interior included — guarantees
   we never start a second trace inside the same blob or on a hole's inner border,
   so we emit exactly **one outer ring per component**. Raster order also gives the
   tracer a free precondition: the first pixel found is top-most then left-most, so
   its west neighbour is background — the tracer's starting "came-from" direction.

3. **Boundary tracing — Moore-neighbour tracing.** Flood fill yields an _unordered_
   set; we need an ordered path. Standing on a boundary pixel, the tracer looks
   back at the cell it arrived from and sweeps the 8 neighbours **clockwise**
   starting just past that backtrack; the first foreground neighbour is the next
   step, and the background cell examined just before it becomes the new backtrack.
   Repeating until it returns to the start traces the outline in order.

   :::note
   The implementation stops when it **returns to the start pixel**, rather than
   using the stricter _Jacob's stopping criterion_ (start pixel **and** same entry
   direction). For the blob-shaped masks SAM produces this is correct; it can stop
   one step early only on a one-pixel-wide pinch point. A generous iteration cap
   guards against pathological non-termination.
   :::

4. **Simplification — Douglas–Peucker.** Raw tracing yields one vertex per boundary
   pixel (a 6×6 block → 20 vertices); Douglas–Peucker collapses near-collinear runs
   to their endpoints within `simplifyTolerance` (a square → ~4 corners). Because
   Douglas–Peucker is defined for _open_ polylines, the closed ring is split at two
   anchors — `points[0]` and the vertex farthest from it — and each half is
   simplified independently, then stitched. This avoids the degenerate
   "first == last collapses everything" failure of naive closed-ring simplification.

Finally, each ring's area is computed with the **shoelace formula** and rings are
sorted **largest-first**, matching the `SegmentationResult.contours` convention the
tool consumes (it previews/commits the largest ring). Note `minArea` filters on the
flood-fill _pixel_ area (the honest mask area) while ordering uses the _polygon_
area of the simplified ring.

### Coordinate transforms

For the server-encode → client-decode topology, the in-browser decoder must
express prompt coordinates in the **same** resized frame the encoder used, and map
mask coordinates back. The `resize-transform` helpers provide that invertible,
SAM-style longest-side letterbox:

```ts
const t = computeResizeTransform(srcWidth, srcHeight, /* inputSize */ 1024);
const modelPt = imageToModel({ x, y }, t); // image-space → model input
const imagePt = modelToImage(modelPt, t); // and back (exact inverse)
```

`scale = inputSize / max(srcWidth, srcHeight)`; padding defaults to top-left
(SAM-style, zero offset) with an optional `{ pad: 'center' }` mode.

## Future work: holes / inner rings

The current `maskToContours` emits only each component's **outer** boundary —
masks with holes (e.g. an annulus, or an object with an interior gap) lose the
inner contour. This is a deliberate v1 simplification, bounded by two factors:

- **Geometry model.** `PolygonGeometry` is a single ring (`points: readonly Point[]`).
  Representing holes needs either a multi-ring polygon (outer ring + inner rings
  with opposite winding, rendered even-odd) or storing the auxiliary rings in the
  annotation's `rawAnnotationData`. Both are additive but touch geometry,
  rendering, measurement, and serialization.
- **Tracing.** Moore-neighbour tracing finds outer borders; extracting holes and
  their nesting needs a border-following algorithm that recovers contour
  **hierarchy** (parent/child outer/hole relationships).

The intended path is to replace the flood-fill + Moore-trace step with a
**Suzuki–Abe** border-following pass (the algorithm behind OpenCV's
`findContours`), which returns the full outer/hole hierarchy in one traversal, and
to extend `PolygonGeometry` (or the raw data) to carry inner rings rendered with
even-odd fill. **Marching squares** is an alternative tracer that yields
sub-pixel-accurate, smoother contours and handles holes naturally, at the cost of
a segment-stitching step. Until then, the full mask can be retained in
`rawAnnotationData` for lossless round-tripping.

Other parked refinements: Jacob's stopping criterion for fully robust tracing, an
LRU bound on the embedding cache, hover-preview prompting, and optional model
metadata (`SegmentationResult.modelId` / a `describe()` method) stored into the
annotation.

## Further reading

**Models**

- Kirillov, Mintun, Ravi, et al. — _Segment Anything_ (2023). [arXiv:2304.02643](https://arxiv.org/abs/2304.02643) · [project site](https://segment-anything.com/)
- Ravi, et al. — _SAM 2: Segment Anything in Images and Videos_ (2024). [arXiv:2408.00714](https://arxiv.org/abs/2408.00714)
- ONNX Runtime Web — running models in the browser (WASM/WebGPU). [onnxruntime.ai](https://onnxruntime.ai/docs/tutorials/web/)

**Algorithms**

- Connected-component labeling / flood fill. [Wikipedia](https://en.wikipedia.org/wiki/Connected-component_labeling)
- Boundary tracing (Moore-neighbour tracing & Jacob's stopping criterion). [Wikipedia](https://en.wikipedia.org/wiki/Boundary_tracing)
- Suzuki, S. & Abe, K. — _Topological Structural Analysis of Digitized Binary Images by Border Following_ (CVGIP, 1985) — the contour-hierarchy algorithm behind OpenCV `findContours`, the basis for the planned holes support.
- Marching squares (sub-pixel contour extraction). [Wikipedia](https://en.wikipedia.org/wiki/Marching_squares)
- Ramer–Douglas–Peucker line simplification (Douglas & Peucker, 1973). [Wikipedia](https://en.wikipedia.org/wiki/Ramer%E2%80%93Douglas%E2%80%93Peucker_algorithm)
- Shoelace formula (Gauss's area formula). [Wikipedia](https://en.wikipedia.org/wiki/Shoelace_formula)

**Web platform**

- `AbortController` / `AbortSignal`. [MDN](https://developer.mozilla.org/en-US/docs/Web/API/AbortController)

## See also

- [Coordinate Systems](/osdlabel/guides/coordinate-systems/) — the image/screen spaces these contours live in.
- [Packages & Architecture](/osdlabel/guides/packages-and-architecture/) — where `@osdlabel/segmentation` sits.
- [Decorations](/osdlabel/guides/decorations/) — the injection pattern the provider mirrors.
