import type { FrameIndex } from './frame-axis.js';
import type { TrackSample } from './sample-track.js';
import { CorrespondenceCache, sampleTrack } from './sample-track.js';
import type { TrackBase } from './track.js';

/**
 * Turns tracks into the per-frame objects the rest of osdlabel already
 * renders: for each track present on `frame`, `build(track, sample)` returns
 * an ordinary annotation (the caller decides its shape, typically
 * `OsdAnnotation` with `id` derived from the track id, so the Fabric object
 * for a track survives frame changes and only its geometry updates).
 *
 * Identity-preserving, as CLAUDE.md requires of transforms feeding reactive
 * layers: when a track's sample on this frame has the same geometry object
 * and visibility as on the previous call (a held keyframe, or the same
 * keyframe), the previous built object is returned unchanged.
 */
export interface FrameMaterializer<T, A> {
  (tracks: readonly T[], frame: FrameIndex): A[];
  readonly cache: CorrespondenceCache;
}

export function createFrameMaterializer<P, T extends TrackBase<P>, A>(
  build: (track: T, sample: TrackSample<P>) => A,
): FrameMaterializer<T, A> {
  const cache = new CorrespondenceCache();
  const last = new WeakMap<T, { sample: TrackSample<P>; built: A }>();
  const fn = (tracks: readonly T[], frame: FrameIndex): A[] => {
    const out: A[] = [];
    for (const track of tracks) {
      const sample = sampleTrack<P>(track, frame, cache);
      if (sample === null) continue;
      const prev = last.get(track);
      if (
        prev !== undefined &&
        prev.sample.geometry === sample.geometry &&
        prev.sample.visibility === sample.visibility &&
        prev.sample.payload === sample.payload
      ) {
        out.push(prev.built);
        continue;
      }
      const built = build(track, sample);
      last.set(track, { sample, built });
      out.push(built);
    }
    return out;
  };
  return Object.assign(fn, { cache });
}

/** Wire format for a set of tracks. Tracks are plain data, so this is their JSON. */
export interface TrackDocument<T> {
  readonly format: 'osdlabel-tracks';
  readonly version: 1;
  readonly tracks: readonly T[];
}

export function toTrackDocument<T>(tracks: readonly T[]): TrackDocument<T> {
  return { format: 'osdlabel-tracks', version: 1, tracks };
}
