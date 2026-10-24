import type { Geometry } from '@osdlabel/annotation';
import type { Correspondence } from './contour-correspondence.js';
import type { FrameIndex } from './frame-axis.js';
import { correspondenceFor, interpolateGeometry, isInterpolable } from './interpolate-geometry.js';
import type { Keyframe, TrackBase, Visibility } from './track.js';
import { findKeyframe } from './track.js';

/** A track's state on one frame. */
export interface TrackSample<P = undefined> {
  readonly geometry: Geometry;
  /** `'visible'` or `'occluded'`; frames where the track is `outside` yield no sample. */
  readonly visibility: Exclude<Visibility, 'outside'>;
  /** The keyframe set on exactly this frame, if there is one. */
  readonly keyframe: Keyframe<P> | null;
  /** How the geometry was obtained. */
  readonly source: 'keyframe' | 'interpolated' | 'held';
  /** Payload of the keyframe the geometry came from (the earlier one when interpolated). */
  readonly payload: P | undefined;
}

/**
 * Per-keyframe-pair memo of contour correspondences. Keyed by the keyframe
 * objects themselves, which are immutable: editing a keyframe replaces its
 * object, so stale entries are unreachable and collected with it.
 */
export class CorrespondenceCache {
  private readonly _byFrom = new WeakMap<object, WeakMap<object, Correspondence | null>>();
  hits = 0;
  misses = 0;

  get(a: Keyframe<unknown>, b: Keyframe<unknown>): Correspondence | null {
    let inner = this._byFrom.get(a);
    if (inner === undefined) {
      inner = new WeakMap();
      this._byFrom.set(a, inner);
    }
    const cached = inner.get(b);
    if (cached !== undefined) {
      this.hits++;
      return cached;
    }
    this.misses++;
    const c = correspondenceFor(a.geometry, b.geometry);
    inner.set(b, c);
    return c;
  }
}

function sampleFrom<P>(
  kf: Keyframe<P>,
  source: TrackSample<P>['source'],
  isExact: boolean,
): TrackSample<P> | null {
  if (kf.visibility === 'outside') return null;
  return {
    geometry: kf.geometry,
    visibility: kf.visibility,
    keyframe: isExact ? kf : null,
    source,
    payload: kf.payload,
  };
}

/**
 * Evaluate a track on `frame`.
 *
 * - Before the first keyframe: nothing.
 * - On a keyframe: that keyframe (nothing if it is `outside`).
 * - Between keyframes `a` and `b`: nothing if `a` is `outside`; otherwise
 *   linear interpolation when the track is `linear`, both are interpolable
 *   and `b` is not `outside`, else hold (`previous` or `nearest`). The
 *   visibility is `a`'s, so occlusion holds until the next keyframe changes it.
 * - After the last keyframe: hold it, or nothing when `afterLast` is `'end'`.
 */
export function sampleTrack<P>(
  track: TrackBase<P>,
  frame: FrameIndex,
  cache?: CorrespondenceCache,
): TrackSample<P> | null {
  const kfs = track.keyframes;
  if (kfs.length === 0) return null;
  const at = findKeyframe(kfs, frame);
  if (at >= 0) return sampleFrom(kfs[at]!, 'keyframe', true);
  const ins = -(at + 1);
  if (ins === 0) return null;
  const a = kfs[ins - 1]!;
  if (ins === kfs.length) return track.afterLast === 'end' ? null : sampleFrom(a, 'held', false);
  if (a.visibility === 'outside') return null;
  const b = kfs[ins]!;

  const mode = track.interpolation ?? 'linear';
  const canBlend =
    mode === 'linear' &&
    b.visibility !== 'outside' &&
    isInterpolable(a.geometry.type) &&
    a.geometry.type === b.geometry.type;
  if (!canBlend) {
    const policy = track.holdPolicy ?? 'nearest';
    const useB =
      policy === 'nearest' && b.visibility !== 'outside' && frame - a.frame > b.frame - frame;
    return useB
      ? {
          geometry: b.geometry,
          visibility: a.visibility,
          keyframe: null,
          source: 'held',
          payload: b.payload,
        }
      : {
          geometry: a.geometry,
          visibility: a.visibility,
          keyframe: null,
          source: 'held',
          payload: a.payload,
        };
  }

  const t = (frame - a.frame) / (b.frame - a.frame);
  // Only contours need a correspondence; skipping the cache for the rest
  // avoids a WeakMap lookup per track per frame.
  const contour = a.geometry.type === 'polygon' || a.geometry.type === 'polyline';
  const corr = !contour
    ? null
    : cache !== undefined
      ? cache.get(a, b)
      : correspondenceFor(a.geometry, b.geometry);
  return {
    geometry: interpolateGeometry(a.geometry, b.geometry, t, corr),
    visibility: a.visibility,
    keyframe: null,
    source: 'interpolated',
    payload: a.payload,
  };
}
