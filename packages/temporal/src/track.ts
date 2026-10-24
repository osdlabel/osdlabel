import type { Geometry, GeometryType } from '@osdlabel/annotation';
import type { FrameIndex } from './frame-axis.js';

export declare const trackIdBrand: unique symbol;
/** Identity of one object followed across frames. */
export type TrackId = string & { readonly __brand: typeof trackIdBrand };

export function createTrackId(value?: string): TrackId {
  if (value !== undefined) return value as TrackId;
  const c = globalThis.crypto;
  if (c !== undefined && typeof c.randomUUID === 'function') return c.randomUUID() as TrackId;
  return `trk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}` as TrackId;
}

/**
 * Whether the tracked object is present at a keyframe.
 *
 * - `visible`: present and seen.
 * - `occluded`: present but hidden behind something; its geometry is still
 *   meaningful (and still interpolated), the UI draws it differently.
 * - `outside`: not in the frame at all. The track has no shape from this
 *   keyframe until the next one, which is how a track ends or has gaps.
 *
 * These are CVAT's semantics, so CVAT video XML maps onto them one to one.
 */
export type Visibility = 'visible' | 'occluded' | 'outside';

/**
 * A keyframe: the geometry an annotator set on one frame.
 *
 * `payload` carries whatever the geometry alone cannot: for a mask it is the
 * pixel envelope (`rawAnnotationData`), since `MaskGeometry` is only a
 * summary. Payloads are never interpolated; a sample takes the payload of the
 * keyframe whose geometry it holds, or of the earlier keyframe when it
 * interpolates.
 */
export interface Keyframe<P = undefined> {
  readonly frame: FrameIndex;
  readonly geometry: Geometry;
  readonly visibility: Visibility;
  readonly payload?: P;
}

/** How to fill frames between two keyframes. */
export type InterpolationMode = 'linear' | 'hold';

/** For `hold` and masks: which neighbouring keyframe a between frame shows. */
export type HoldPolicy = 'previous' | 'nearest';

/**
 * One object over time: an id, a geometry type every keyframe shares, and
 * keyframes sorted by frame with no two on the same frame.
 *
 * `E` adds application fields (label, context id, colour) by intersection,
 * exactly as `Annotation<E>` does.
 */
export type Track<P = undefined, E extends object = Record<never, never>> = TrackBase<P> & E;

export interface TrackBase<P = undefined> {
  readonly id: TrackId;
  readonly geometryType: GeometryType;
  readonly keyframes: readonly Keyframe<P>[];
  /** Default `'linear'`; masks always hold, whatever this says. */
  readonly interpolation?: InterpolationMode;
  /** Default `'nearest'`. Used by `hold` tracks and by masks. */
  readonly holdPolicy?: HoldPolicy;
  /**
   * Frames after the last keyframe: `'hold'` keeps showing it (CVAT), `'end'`
   * shows nothing. Default `'hold'`.
   */
  readonly afterLast?: 'hold' | 'end';
}

/** Index of the keyframe at `frame`, or `-(insertionPoint + 1)` if none. */
export function findKeyframe<P>(keyframes: readonly Keyframe<P>[], frame: FrameIndex): number {
  let lo = 0;
  let hi = keyframes.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const f = keyframes[mid]!.frame;
    if (f === frame) return mid;
    if (f < frame) lo = mid + 1;
    else hi = mid - 1;
  }
  return -(lo + 1);
}

function checkKeyframe<P>(geometryType: GeometryType, kf: Keyframe<P>): void {
  if (!Number.isInteger(kf.frame) || kf.frame < 0) {
    throw new Error(`keyframe frame must be a non-negative integer, got ${kf.frame}`);
  }
  if (kf.geometry.type !== geometryType) {
    throw new Error(
      `keyframe geometry '${kf.geometry.type}' does not match track type '${geometryType}'`,
    );
  }
}

/** Build a track, validating and sorting its keyframes. */
export function createTrack<P = undefined>(
  init: Omit<TrackBase<P>, 'keyframes' | 'id'> & {
    readonly id?: TrackId;
    readonly keyframes: readonly Keyframe<P>[];
  },
): TrackBase<P> {
  const sorted = [...init.keyframes].sort((a, b) => a.frame - b.frame);
  for (let i = 0; i < sorted.length; i++) {
    checkKeyframe(init.geometryType, sorted[i]!);
    if (i > 0 && sorted[i]!.frame === sorted[i - 1]!.frame) {
      throw new Error(`two keyframes on frame ${sorted[i]!.frame}`);
    }
  }
  return { ...init, id: init.id ?? createTrackId(), keyframes: sorted };
}

/**
 * Set the keyframe on `kf.frame`, replacing one already there. Returns a new
 * track; every other keyframe object is kept by identity, so per-pair caches
 * keyed on keyframes stay valid for the untouched spans.
 */
export function upsertKeyframe<T extends TrackBase<P>, P>(track: T, kf: Keyframe<P>): T {
  checkKeyframe(track.geometryType, kf);
  const at = findKeyframe(track.keyframes, kf.frame);
  const next = [...track.keyframes];
  if (at >= 0) next[at] = kf;
  else next.splice(-(at + 1), 0, kf);
  return { ...track, keyframes: next };
}

/** Remove the keyframe on `frame`, if any. Returns the same track when there is none. */
export function removeKeyframe<T extends TrackBase<P>, P>(track: T, frame: FrameIndex): T {
  const at = findKeyframe(track.keyframes, frame);
  if (at < 0) return track;
  const next = [...track.keyframes];
  next.splice(at, 1);
  return { ...track, keyframes: next };
}
