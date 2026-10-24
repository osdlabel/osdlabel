/**
 * The index a frame-accurate video source needs: every packet's presentation
 * timestamp, its place in decode order, and which packets are keyframes.
 *
 * Frame `i` is the i-th packet in presentation order. With B-frames that is
 * not decode order, so the table keeps both and answers "which keyframe must
 * decoding start from to reach frame i" in O(log n).
 */
export interface PacketInfo {
  /** Presentation timestamp, microseconds. */
  readonly timestampUs: number;
  readonly durationUs: number;
  readonly key: boolean;
  /** Position in the container's decode order. */
  readonly decodeIndex: number;
}

export interface FrameTable {
  readonly frameCount: number;
  /** Presentation order: frame i's packet. */
  readonly frames: readonly PacketInfo[];
  /** Decode order: packet j. */
  readonly decodeOrder: readonly PacketInfo[];
  /** Decode indices of key packets, ascending. */
  readonly keyDecodeIndices: readonly number[];
  /** Presentation index of each decode-order packet. */
  readonly frameOfDecodeIndex: readonly number[];
}

export function buildFrameTable(decodeOrder: readonly PacketInfo[]): FrameTable {
  decodeOrder.forEach((p, j) => {
    if (p.decodeIndex !== j) throw new Error(`packet ${j} has decodeIndex ${p.decodeIndex}`);
  });
  const frames = [...decodeOrder].sort((a, b) => a.timestampUs - b.timestampUs);
  for (let i = 1; i < frames.length; i++) {
    if (frames[i]!.timestampUs === frames[i - 1]!.timestampUs) {
      throw new Error(`two packets share timestamp ${frames[i]!.timestampUs}`);
    }
  }
  const frameOfDecodeIndex = new Array<number>(decodeOrder.length);
  frames.forEach((p, i) => (frameOfDecodeIndex[p.decodeIndex] = i));
  const keyDecodeIndices = decodeOrder.filter((p) => p.key).map((p) => p.decodeIndex);
  if (keyDecodeIndices[0] !== 0) throw new Error('stream does not start with a key packet');
  return { frameCount: frames.length, frames, decodeOrder, keyDecodeIndices, frameOfDecodeIndex };
}

/**
 * Decode index of the key packet decoding must start from to produce frame
 * `i`: the last key packet at or before frame i's packet in decode order.
 * Correct for closed GOPs (what x264, libvpx and SVT-AV1 emit by default); an
 * open-GOP stream's leading B-frames would need the previous key packet.
 */
export function startKeyFor(table: FrameTable, i: number): number {
  const target = table.frames[i];
  if (target === undefined) throw new RangeError(`frame ${i} outside [0, ${table.frameCount - 1}]`);
  const keys = table.keyDecodeIndices;
  let lo = 0;
  let hi = keys.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (keys[mid]! <= target.decodeIndex) lo = mid;
    else hi = mid - 1;
  }
  return keys[lo]!;
}

/** Presentation index of the frame whose timestamp is exactly `timestampUs`, or -1. */
export function frameOfTimestamp(table: FrameTable, timestampUs: number, toleranceUs = 1): number {
  const f = table.frames;
  let lo = 0;
  let hi = f.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const t = f[mid]!.timestampUs;
    if (Math.abs(t - timestampUs) <= toleranceUs) return mid;
    if (t < timestampUs) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}
