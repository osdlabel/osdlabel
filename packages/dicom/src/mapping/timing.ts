import type { DicomDataset } from '../dataset.js';
import { formatTag, num } from '../dataset.js';
import { TAGS } from '../tags.js';

/** What successive frames of a multi-frame image step through. */
export type FrameAxis =
  | 'single'
  | 'time'
  | 'space'
  | 'label'
  | 'tiles'
  | 'multi'
  | 'other'
  | 'unknown';

/** One dimension named by Frame Increment Pointer. */
export type FrameDimension = 'time' | 'space' | 'label' | 'energy' | 'detector' | 'other';

export interface FrameTiming {
  readonly frameCount: number;
  readonly axis: FrameAxis;
  /**
   * Every dimension Frame Increment Pointer names, in order. NM frames are
   * the product of several (energy window × detector × rotation × …), which
   * is why "a frame index" is not one axis in general.
   */
  readonly dimensions: readonly FrameDimension[];
  /** The attribute Frame Increment Pointer names, as `(gggg,eeee)`. */
  readonly incrementPointer: string | undefined;
  /** Start time of each frame relative to the first, in ms (time axis only). */
  readonly frameStartMs: readonly number[] | undefined;
  /** Nominal rate from the frame timing (1000 / Frame Time). */
  readonly acquisitionFps: number | undefined;
  /** Cine Rate or Recommended Display Frame Rate — how fast to *play*, which may differ. */
  readonly playbackFps: number | undefined;
  readonly playback: 'loop' | 'sweep' | undefined;
  readonly notes: readonly string[];
}

/** Frame Increment Pointer targets (PS3.3 C.7.6.6.1.1 and the NM vectors of C.8.4.8). */
const POINTER_DIMENSION: ReadonlyMap<number, FrameDimension> = new Map([
  [TAGS.FrameTime.tag, 'time'],
  [TAGS.FrameTimeVector.tag, 'time'],
  [TAGS.FrameLabelVector.tag, 'label'],
  [0x00540010, 'energy'], // Energy Window Vector
  [0x00540020, 'detector'], // Detector Vector
  [0x00540030, 'time'], // Phase Vector
  [0x00540050, 'space'], // Rotation Vector
  [0x00540060, 'time'], // R-R Interval Vector
  [0x00540070, 'time'], // Time Slot Vector
  [TAGS.SliceVector.tag, 'space'], // Slice Vector (0054,0080)
  [0x00540090, 'space'], // Angular View Vector
  [0x00540100, 'time'], // Time Slice Vector
] as const);

/**
 * Reads cine timing (Frame Time, Frame Time Vector, Cine Rate, Frame Increment
 * Pointer). The key finding it encodes: "multi-frame" does not mean "time".
 * The Frame Increment Pointer says what the frames step through — an US
 * multi-frame object can be a 3D sweep (Slice Vector), and NM/enhanced
 * objects use functional groups instead.
 */
export function readFrameTiming(ds: DicomDataset): FrameTiming {
  const notes: string[] = [];
  const frameCount = num(ds, TAGS.NumberOfFrames.tag) ?? 1;
  const pointers = ds.numbers(TAGS.FrameIncrementPointer.tag) ?? [];
  const frameTime = num(ds, TAGS.FrameTime.tag);
  const vector = ds.numbers(TAGS.FrameTimeVector.tag);
  const cineRate = num(ds, TAGS.CineRate.tag);
  const recommended = num(ds, TAGS.RecommendedDisplayFrameRate.tag);
  const seq = num(ds, TAGS.PreferredPlaybackSequencing.tag);

  const dimensions = pointers.map((p) => POINTER_DIMENSION.get(p) ?? 'other');
  let axis: FrameAxis;
  if (frameCount <= 1) axis = 'single';
  else if (
    ds.has(TAGS.DimensionOrganizationType.tag) &&
    /^TILED/.test(ds.strings(TAGS.DimensionOrganizationType.tag)?.[0] ?? '')
  ) {
    axis = 'tiles';
  } else if (dimensions.length > 1) {
    axis = 'multi';
    notes.push(`frames index ${dimensions.length} dimensions: ${dimensions.join(' × ')}`);
  } else if (dimensions.length === 1) {
    const d = dimensions[0]!;
    axis = d === 'time' || d === 'space' || d === 'label' ? d : 'other';
  } else if (ds.has(TAGS.PerFrameFunctionalGroupsSequence.tag)) {
    axis = 'unknown';
    notes.push('enhanced multi-frame: frame semantics are in the dimension index, not timing tags');
  } else if (frameTime !== undefined) {
    axis = 'time';
    notes.push('no Frame Increment Pointer; Frame Time present, assuming time');
  } else axis = 'unknown';

  let frameStartMs: number[] | undefined;
  if (axis === 'time') {
    if (vector && vector.length === frameCount) {
      // Frame Time Vector holds increments; the first entry is 0.
      frameStartMs = [];
      let t = 0;
      for (const dt of vector) {
        t += dt;
        frameStartMs.push(t);
      }
      const first = frameStartMs[0]!;
      frameStartMs = frameStartMs.map((x) => x - first);
    } else if (frameTime !== undefined && frameTime > 0) {
      frameStartMs = Array.from({ length: frameCount }, (_, i) => i * frameTime);
    } else {
      notes.push('time axis without Frame Time or a matching Frame Time Vector');
    }
  }
  const acquisitionFps = frameTime !== undefined && frameTime > 0 ? 1000 / frameTime : undefined;
  const playbackFps = cineRate ?? recommended ?? acquisitionFps;
  if (
    acquisitionFps !== undefined &&
    cineRate !== undefined &&
    Math.abs(acquisitionFps - cineRate) > 0.5
  ) {
    notes.push(
      `Cine Rate ${cineRate} differs from 1000/Frame Time = ${acquisitionFps.toFixed(2)}: play at Cine Rate, timestamp by Frame Time`,
    );
  }
  return {
    frameCount,
    axis,
    dimensions,
    incrementPointer: pointers[0] !== undefined ? formatTag(pointers[0]) : undefined,
    frameStartMs,
    acquisitionFps,
    playbackFps,
    playback: seq === 0 ? 'loop' : seq === 1 ? 'sweep' : undefined,
    notes,
  };
}
