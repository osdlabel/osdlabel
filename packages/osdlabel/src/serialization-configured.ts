import type { Annotation, AnnotationId, RawAnnotationData } from '@osdlabel/annotation';
import { MASK_RAW_FORMAT } from '@osdlabel/annotation';
import type { ImageId } from '@osdlabel/viewer-api';
import type { AnnotationState } from '@osdlabel/viewer-api';
import { getAllAnnotationsFlat } from '@osdlabel/viewer-api';
import { OsdAnnotationSchema } from '@osdlabel/validation';
import { DEFAULT_MAX_MASK_PIXELS, decodeCanonical } from '@osdlabel/mask';
import type { CanonicalMaskData, MaskCodec, MaskCodecRegistry, MaskSnapshot } from '@osdlabel/mask';
import { maskAnnotationFields, maskGeometryFromSnapshot } from './create-mask-annotation.js';
import type { OsdFields } from './types.js';
import * as v from 'valibot';

/** Error type for serialization/deserialization failures */
export class SerializationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SerializationError';
  }
}

/** An annotation that could not be loaded, and why. */
export interface DeserializeSkip {
  /** The annotation's `id` if it had a usable one, else `null`. */
  readonly id: string | null;
  readonly reason: string;
}

/** Result of deserializing an annotation array */
export interface DeserializeResult<E extends object = Record<string, never>> {
  readonly byImage: Record<ImageId, Record<AnnotationId, Annotation<E>>>;
  /**
   * Mask annotations dropped because their pixels could not be decoded.
   *
   * A malformed mask used to fail the whole document, so one bad annotation in
   * forty lost the other thirty-nine. Dropping it alone is the better trade,
   * but only if the loss is visible — check this before treating a load as
   * clean, and refuse the document yourself if partial data is not acceptable
   * for your use.
   *
   * Empty on a clean load. Everything else — a schema violation, a blown
   * budget — still throws, because those are properties of the document rather
   * than of one annotation in it.
   */
  readonly skipped: readonly DeserializeSkip[];
}

/** Options controlling how mask payloads are written. */
export interface SerializeOptions {
  /**
   * Re-encodes mask pixels into a downstream format (e.g. COCO RLE) on the way
   * out. Required when options are given at all — call `serialize(state)` with
   * no options to keep osdlabel's canonical encoding, which round-trips exactly.
   */
  readonly maskCodec: MaskCodec;
}

/**
 * An annotation whose mask payload has been re-encoded for export, so its
 * raw-data envelope is no longer one of the formats the annotator itself reads.
 */
export type ExportedAnnotation = Omit<Annotation<OsdFields>, 'rawAnnotationData'> & {
  readonly rawAnnotationData: RawAnnotationData<string, Record<string, unknown>>;
};

/** Options controlling how mask payloads are read. */
export interface DeserializeOptions {
  /**
   * Codecs used to recognise mask payloads written in a downstream format and
   * convert them back to the canonical encoding before validation.
   */
  readonly maskCodecs?: MaskCodecRegistry | undefined;
  /**
   * Cap on the pixels any one mask may decode to. Defaults to
   * `DEFAULT_MAX_MASK_PIXELS` (64 megapixels), which is also the ceiling — a
   * larger value is clamped, because the validation schema enforces the same
   * bound a moment later and is not per-call configurable.
   *
   * Worth lowering when the document is genuinely untrusted: the default is
   * sized for what a user can paint, not for what an attacker can declare.
   */
  readonly maxMaskPixels?: number | undefined;
  /**
   * Cap on the pixels *all* masks in the document may decode to together.
   * Defaults to {@link DEFAULT_MAX_TOTAL_MASK_PIXELS}.
   *
   * Without this, a per-mask cap is no bound at all — a document can hold
   * arbitrarily many masks that are each individually legal.
   */
  readonly maxTotalMaskPixels?: number | undefined;
}

/**
 * Default document-wide decode budget: thirty-two masks at the per-mask cap.
 *
 * **No finite default makes `serialize` and `deserialize` symmetric.** `serialize`
 * imposes no budget and a document may hold any number of masks, so for any
 * bound there is a legitimate session that exceeds it. The previous value
 * refused 100 solid 3000x2000 masks — an ordinary dense day's work, 40 KB on
 * disk — which is the wrong side of that trade to be on. This one clears it
 * with room to spare, and the error names the option to raise when something
 * genuinely larger comes along.
 *
 * **This is not an adversarial boundary, and cannot be one.** Decode cost per
 * charged pixel varies about fortyfold with a mask's run structure, so any
 * budget generous enough for real documents still buys a crafted one seconds of
 * blocking. The two goals are in direct conflict and this default resolves them
 * toward not breaking real work, because losing a user's annotations is certain
 * while a hostile file is hypothetical.
 *
 * Measured on this default: 130 solid 1024x1024 masks — an ordinary dense
 * session, 50 KB on disk — load in 0.2s, while a deliberately crafted 1.6 MB
 * document of column-striped gigapixel COCO masks is refused after about a
 * minute. Against the hours, or never, that an unbounded document could take,
 * that is the bound doing its job; it is not protection from a determined
 * attacker.
 *
 * **If you load documents you did not produce, set `maxTotalMaskPixels`
 * explicitly.** Sized to what your own workflow actually needs, it turns the
 * crafted case from a minute into milliseconds.
 */
export const DEFAULT_MAX_TOTAL_MASK_PIXELS = 32 * DEFAULT_MAX_MASK_PIXELS;

/** Serialize OSD annotation state into a flat array of annotations */
export function serialize(state: AnnotationState<OsdFields>): Annotation<OsdFields>[];
export function serialize(
  state: AnnotationState<OsdFields>,
  options: SerializeOptions,
): ExportedAnnotation[];
export function serialize(
  state: AnnotationState<OsdFields>,
  options?: SerializeOptions,
): Annotation<OsdFields>[] | ExportedAnnotation[] {
  const annotations = getAllAnnotationsFlat(state);
  if (!options) return annotations;

  const codec = options.maskCodec;
  return annotations.map((annotation): ExportedAnnotation => {
    if (annotation.rawAnnotationData.format !== MASK_RAW_FORMAT) return annotation;
    // Re-encoding has to decode first, and that can fail on a mask that reached
    // state through some path other than `deserialize`. Wrapped so a caller
    // catches one error type from this module rather than a decoder's.
    // Both halves wrapped, not just the decode: `encode` is the one that raises
    // domain errors — a box outside its own image, a format's own limits — and
    // leaving it bare let a `RangeError` from a codec escape a documented API.
    let snapshot: MaskSnapshot;
    let encoded: unknown;
    try {
      snapshot = decodeCanonical(annotation.rawAnnotationData.data);
      encoded = codec.encode(snapshot);
    } catch (err) {
      throw new SerializationError(
        `Could not re-encode mask ${annotation.id}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return {
      ...annotation,
      rawAnnotationData: {
        format: codec.format,
        // Codec payloads are opaque to the annotator; the codec owns the shape.
        data: encoded as Record<string, unknown>,
      },
    };
  });
}

/** Deserialize with OSD field validation (contextId + rawAnnotationData) */
export function deserialize(
  doc: unknown,
  options?: DeserializeOptions,
): DeserializeResult<OsdFields> {
  // Runs on payloads that have not been validated yet — the schema accepts only
  // the formats the annotator itself reads, so a foreign mask has to be
  // converted first, and a canonical one has to be proved decodable before it
  // is admitted. Failures here are malformed input, not crashes.
  const skipped: DeserializeSkip[] = [];
  let normalized: unknown;
  try {
    normalized = normalizeMasks(doc, options?.maskCodecs, options ?? {}, skipped);
  } catch (err) {
    throw new SerializationError(
      `Failed to decode mask payload: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let annotations: Annotation<OsdFields>[];
  try {
    annotations = v.parse(
      v.array(OsdAnnotationSchema),
      normalized,
    ) as unknown as Annotation<OsdFields>[];
  } catch (err) {
    throw new SerializationError(
      `Validation failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Null-prototype maps: `imageId` and `id` are arbitrary strings from an
  // untrusted document, and they are used here as keys. With an ordinary object
  // an `imageId` of `"__proto__"` reads back `Object.prototype` as an existing
  // entry, and the write that follows lands on the prototype — an annotation
  // named `"toString"` then breaks string coercion process-wide, with nothing
  // in the returned value to show for it.
  const byImage = Object.create(null) as Record<
    ImageId,
    Record<AnnotationId, Annotation<OsdFields>>
  >;
  for (const ann of annotations) {
    let forImage = byImage[ann.imageId];
    if (!forImage) {
      forImage = Object.create(null) as Record<AnnotationId, Annotation<OsdFields>>;
      byImage[ann.imageId] = forImage;
    }
    forImage[ann.id] = ann;
  }

  return { byImage, skipped };
}

/**
 * Decodes every mask in the document and rebuilds it from its own pixels.
 *
 * Three things happen here, and they are the same operation:
 *
 * 1. **Foreign formats become canonical.** Validation deliberately accepts only
 *    the two envelopes the annotator reads, so a COCO payload has to be
 *    converted before it gets there — which is why this runs *before* Valibot
 *    rather than after.
 * 2. **Canonical payloads are proved decodable.** The schema bounds a payload's
 *    dimensions and its `counts` length, but cannot tell whether those counts
 *    actually fill that box. Admitting one that does not only defers the throw
 *    to render time, where `ViewerCell` has already cleared its canvas — so a
 *    single malformed mask takes every annotation in the cell down with it.
 *    Failing here instead makes it one rejected import.
 * 3. **Geometry is recomputed from the pixels.** The pixels are the mask; a
 *    bounding box or pixel count that disagrees with them — stale, hand-written,
 *    or from a tool that never had them — would otherwise reach state and show
 *    up as a wrong area or a selection box in the wrong place.
 *
 * A tint recorded at paint time survives on the canonical path and is lost on
 * the foreign one: export formats carry pixels, not styling.
 */
function normalizeMasks(
  doc: unknown,
  registry: MaskCodecRegistry | undefined,
  options: DeserializeOptions,
  skipped: DeserializeSkip[],
): unknown {
  if (!Array.isArray(doc)) return doc;

  // Per-mask caps bound one allocation; they say nothing about a thousand of
  // them. A few kilobytes of COCO can name a thousand at-cap masks, each
  // individually legal, and decoding them in sequence blocks the main thread
  // for minutes. The document-wide budget is what makes import cost
  // proportional to the document rather than to what it claims.
  // `perMask` is clamped down to the shared ceiling: `MAX_MASK_PIXELS` in the
  // validation schema is a module constant, so a mask above it is rejected a
  // moment later no matter what was asked for here. Honouring a larger value
  // would only move the failure, not remove it.
  //
  // `budget` is not clamped — it bounds a whole document, and its own default
  // is several times the per-mask ceiling.
  //
  // Validated, not just defaulted: `NaN` propagates through every comparison
  // below as `false`, so an unvalidated bound does not merely misbehave — it
  // removes the bound entirely, on the one path that exists to have one.
  const bound = (value: number | undefined, fallback: number, name: string): number => {
    if (value === undefined) return fallback;
    // `Infinity` is allowed, and means "no budget". The message raised when a
    // budget is exceeded tells the caller to raise it; rejecting the value that
    // most obviously does so would point them at a fix the API declines.
    // `typeof` first: `Number.isNaN` does not coerce, so a string sails past it
    // and past `value < 0` too, and `Math.min('big', cap)` is `NaN` — which
    // fails every later comparison and removes the bound entirely, on the one
    // path that exists to have one. The sibling checks in `brush-config.ts` and
    // the tool use `Number.isFinite`, which rejects strings for free; loosening
    // this one to allow `Infinity` lost that.
    if (typeof value !== 'number' || Number.isNaN(value) || value < 0) {
      throw new RangeError(`${name} must be a non-negative number, got ${String(value)}`);
    }
    return value;
  };
  const perMask = Math.min(
    bound(options.maxMaskPixels, DEFAULT_MAX_MASK_PIXELS, 'maxMaskPixels'),
    DEFAULT_MAX_MASK_PIXELS,
  );
  const budget = bound(
    options.maxTotalMaskPixels,
    DEFAULT_MAX_TOTAL_MASK_PIXELS,
    'maxTotalMaskPixels',
  );
  let spent = 0;

  // The cap handed to each decode is whatever is left of the budget, so a
  // codec aborts before doing the work rather than after. Charging a mask only
  // once it had been decoded would let a document spend several at-cap decodes
  // — tens of seconds — before the budget noticed.
  //
  // Which cap applied also decides how a failure is reported: a mask rejected
  // against `perMask` is one bad annotation, while one rejected against the
  // remaining budget means the *document* asked for too much. The first is
  // survivable and skipped, the second is not.
  const capFor = (): { readonly cap: number; readonly limitedByBudget: boolean } => {
    const left = Math.max(0, budget - spent);
    return { cap: Math.min(perMask, left), limitedByBudget: left < perMask };
  };

  // Billed for area *and* for the runs the payload turns into.
  //
  // Area alone is a poor proxy for work: measured, a solid canonical mask costs
  // 3ms per megapixel and a COCO mask of alternating full columns costs 122 —
  // forty times more for the same charge — because a column-striped mask is one
  // run per pixel once re-encoded row-major. Adding the run count bills that
  // structure instead of pretending every megapixel is alike.
  const charge = (snapshot: MaskSnapshot, runs: number): MaskSnapshot => {
    spent += snapshot.width * snapshot.height + runs;
    return snapshot;
  };

  const decoded = doc.map((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null) return entry;
    const raw = (entry as { rawAnnotationData?: unknown }).rawAnnotationData;
    if (typeof raw !== 'object' || raw === null) return entry;

    const format = (raw as { format?: unknown }).format;
    if (typeof format !== 'string' || format === 'fabric') return entry;

    const data = (raw as { data?: unknown }).data;
    const codec = format === MASK_RAW_FORMAT ? undefined : registry?.get(format);
    if (format !== MASK_RAW_FORMAT && !codec?.decode) return entry;

    // Per annotation, so a mask whose pixels are corrupt is dropped alone
    // rather than taking the document with it — the same reasoning that made
    // rendering isolate each annotation. A blown budget is deliberately *not*
    // caught here: that is a property of the document, and quietly loading
    // half of one would be worse than refusing it.
    const decode = (maxPixels: number): MaskSnapshot =>
      codec?.decode !== undefined
        ? codec.decode(data, { maxPixels })
        : decodeCanonical(data as CanonicalMaskData, { maxPixels });

    const { cap, limitedByBudget } = capFor();
    try {
      const snapshot = decode(cap);
      // A canonical payload keeps its own bytes: it has just been proved to
      // decode, and re-encoding would reproduce what is already there at the
      // cost of the most expensive step on this path. Only the geometry needs
      // rebuilding, which is the reason for decoding at all.
      if (!codec) {
        const counts = (data as { counts?: unknown }).counts;
        charge(snapshot, typeof counts === 'string' ? counts.length : 0);
        return { ...entry, geometry: maskGeometryFromSnapshot(snapshot) };
      }
      const fields = maskAnnotationFields(snapshot);
      charge(snapshot, fields.rawAnnotationData.data.counts.length);
      return { ...entry, ...fields };
    } catch (err) {
      // Whose fault was that — this annotation's, or the document's?
      //
      // The cap that was applied cannot answer it. Once the budget is partly
      // spent every cap is budget-shrunk, so blaming the budget for any failure
      // under one made the outcome depend on the order the masks happened to be
      // in: the same six annotations loaded five and skipped one, or threw and
      // lost all six. Inspecting the error cannot answer it either — the codec
      // contract does not name an error type, so a third-party codec's own
      // failure would read as a per-mask skip and quietly load half a document.
      //
      // So ask directly: retry once at the per-mask cap. Succeeding means the
      // mask was fine and the *budget* ran out; failing again means the mask
      // itself is too big and only it is lost. The retry costs one bounded
      // decode, on an error path that ends the import either way.
      if (limitedByBudget) {
        let fitsAlone = false;
        try {
          decode(perMask);
          fitsAlone = true;
        } catch {
          fitsAlone = false;
        }
        if (fitsAlone) {
          throw new BudgetExceededError(
            `Document's masks decode to more than ${budget} pixels in total; ` +
              `raise maxTotalMaskPixels to allow it`,
          );
        }
      }
      const id = (entry as { id?: unknown }).id;
      skipped.push({
        id: typeof id === 'string' ? id : null,
        reason: err instanceof Error ? err.message : String(err),
      });
      return DROPPED;
    }
  });

  return decoded.filter((entry) => entry !== DROPPED);
}

/** Distinguishes the document-wide budget from a single mask's own failure. */
class BudgetExceededError extends RangeError {}

/**
 * Marks an entry dropped by {@link normalizeMasks}.
 *
 * Deliberately not `null`: a document may legitimately *contain* `null`, and
 * filtering on it swallowed that instead of letting validation reject it.
 */
const DROPPED = Symbol('dropped');
