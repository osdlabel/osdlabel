import type { Annotation } from '@osdlabel/annotation';
import type { FrameAxis } from './frame-axis.js';
import type { FrameRef } from './frame-ref.js';
import { resolveFrameRef } from './frame-ref.js';
import type { Keyframe, TrackBase, TrackId, Visibility } from './track.js';
import { createTrack } from './track.js';

/**
 * The fields that make an ordinary annotation a track keyframe. A track is
 * then not a stored entity at all: it is the set of keyframe annotations
 * sharing a `trackId`, grouped on load by {@link groupKeyframeAnnotations}.
 * Everything else (id, geometry, label, context, the Fabric or mask payload)
 * is the annotation's own, so the existing store, serialization and
 * validation carry keyframes like any other annotation.
 */
export interface KeyframeFields {
  readonly trackId: TrackId;
  /** The frame the keyframe was set on: its index and its start time in integer µs. */
  readonly frame: FrameRef;
  readonly visibility: Visibility;
}

/** Two keyframe annotations of one track that resolved to the same frame. */
export interface KeyframeConflict {
  readonly trackId: TrackId;
  readonly frame: number;
  /** Ids of the annotations involved; the last one listed was kept. */
  readonly annotationIds: readonly string[];
}

export interface GroupedKeyframes<A> {
  /** One track per `trackId`; each keyframe's payload is its source annotation. */
  readonly tracks: TrackBase<A>[];
  readonly conflicts: KeyframeConflict[];
  /** Annotations dropped because their geometry type differs from their track's first keyframe. */
  readonly mismatched: A[];
}

/**
 * Group keyframe annotations into tracks on `axis`, resolving every stored
 * frame with {@link resolveFrameRef}. The payload of each keyframe is the
 * annotation it came from, so a materialised frame can carry the source
 * keyframe's fields (label, context, mask pixels) unchanged.
 *
 * On a frame collision (two annotations of one track on one frame, e.g. a
 * document merged from two writers), the later `updatedAt` wins and the
 * collision is reported.
 */
export function groupKeyframeAnnotations<E extends object = Record<never, never>>(
  annotations: readonly Annotation<KeyframeFields & E>[],
  axis: FrameAxis,
): GroupedKeyframes<Annotation<KeyframeFields & E>> {
  type A = Annotation<KeyframeFields & E>;
  const byTrack = new Map<TrackId, Map<number, A>>();
  const conflicts: KeyframeConflict[] = [];
  const mismatched: A[] = [];
  const typeOf = new Map<TrackId, string>();
  for (const a of annotations) {
    const t = typeOf.get(a.trackId);
    if (t === undefined) typeOf.set(a.trackId, a.geometry.type);
    else if (t !== a.geometry.type) {
      mismatched.push(a);
      continue;
    }
    const frame = resolveFrameRef(axis, a.frame);
    let frames = byTrack.get(a.trackId);
    if (frames === undefined) {
      frames = new Map();
      byTrack.set(a.trackId, frames);
    }
    const prev = frames.get(frame);
    if (prev !== undefined) {
      const keep = prev.updatedAt > a.updatedAt ? prev : a;
      const drop = keep === prev ? a : prev;
      conflicts.push({ trackId: a.trackId, frame, annotationIds: [drop.id, keep.id] });
      frames.set(frame, keep);
    } else frames.set(frame, a);
  }
  const tracks: TrackBase<A>[] = [];
  for (const [trackId, frames] of byTrack) {
    const keyframes: Keyframe<A>[] = [];
    for (const [frame, a] of frames) {
      keyframes.push({ frame, geometry: a.geometry, visibility: a.visibility, payload: a });
    }
    tracks.push(
      createTrack<A>({ id: trackId, geometryType: keyframes[0]!.geometry.type, keyframes }),
    );
  }
  return { tracks, conflicts, mismatched };
}
