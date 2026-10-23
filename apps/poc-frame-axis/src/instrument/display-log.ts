/**
 * The display log: what the image layer (OSD) and the annotation layer
 * (Fabric) put on screen, frame by frame, and the analysis that turns it into
 * latency, throughput, blank frames and image/annotation coherence. Pure.
 *
 * Every event carries the display-frame sequence number (`seq`) of the paint
 * it lands in. Code running inside a requestAnimationFrame callback lands in
 * that frame's paint; code running outside one (input handlers, timers) lands
 * in the next. `index.html` installs the rAF wrapper that makes this
 * knowable.
 */

export type DisplayEventKind =
  /** A frame was requested (the swap began). */
  | 'apply'
  /** OSD finished a draw; `frame` is what its drawn tiles hold (-1 blank, -2 mixed). */
  | 'img'
  /** Fabric finished a render; `frame` is the frame whose objects are on the canvas. */
  | 'ann';

export interface DisplayEvent {
  readonly kind: DisplayEventKind;
  readonly frame: number;
  /** The display frame whose paint this event first shows up in. */
  readonly seq: number;
  readonly t: number;
}

/** As recorded: the frame sequence current at `t`, and whether `t` was inside a rAF callback. */
export interface RawDisplayEvent {
  readonly kind: DisplayEventKind;
  readonly frame: number;
  readonly seq: number;
  readonly t: number;
  readonly inRaf: boolean;
}

/** When a display frame's first and last rAF callbacks started. */
export interface FrameLogEntry {
  readonly seq: number;
  readonly start: number;
  readonly last: number;
}

/**
 * Place each event in the paint it first shows up in.
 *
 * Inside a rAF callback: that frame. Outside one (an input handler, a timer,
 * a microtask after a callback): the same frame if another of its callbacks
 * started later — so the paint had not happened yet — else the next frame.
 * Work done after a frame's last callback can only reach the screen through
 * the next frame's callbacks, so the next frame is the earliest paint it can
 * affect either way.
 */
export function resolveLanding(
  events: readonly RawDisplayEvent[],
  frameLog: readonly FrameLogEntry[],
): DisplayEvent[] {
  const lastBySeq = new Map<number, number>();
  for (const f of frameLog) lastBySeq.set(f.seq, f.last);
  return events.map((e) => {
    if (e.inRaf) return { kind: e.kind, frame: e.frame, seq: e.seq, t: e.t };
    const last = lastBySeq.get(e.seq);
    const seq = last !== undefined && last > e.t ? e.seq : e.seq + 1;
    return { kind: e.kind, frame: e.frame, seq, t: e.t };
  });
}

export interface DisplayAnalysis {
  /** Display frames covered by the log. */
  readonly frames: number;
  readonly applies: number;
  /** Applies whose frame reached the screen before the next apply. */
  readonly delivered: number;
  /** Applies superseded before their frame was drawn. */
  readonly superseded: number;
  /** ms from apply to the OSD draw that showed it, per delivered apply. */
  readonly latencyMs: number[];
  /**
   * Paints between the request and the draw that showed it: 0 means the
   * frame was on screen at the first paint that could possibly show it.
   */
  readonly latencyFrames: number[];
  /** Distinct image frames that were on screen at some point. */
  readonly distinctImageFrames: number;
  /** Display frames on which the image changed (including to and from blank). */
  readonly imageChanges: number;
  /** Display frames on which a *different real frame* appeared (blank flashes excluded). */
  readonly slicesShown: number;
  /** Display frames showing no image (after the first image). */
  readonly blankFrames: number;
  /** Display frames showing a mixture of two frames' tiles. */
  readonly mixedFrames: number;
  /** Display frames where the image and the annotations showed different frames. */
  readonly incoherentFrames: number;
}

export function analyzeDisplayLog(events: readonly DisplayEvent[]): DisplayAnalysis {
  const sorted = [...events].sort((a, b) => a.seq - b.seq || a.t - b.t);
  const firstSeq = sorted[0]?.seq ?? 0;
  const lastSeq = sorted[sorted.length - 1]?.seq ?? 0;

  // Per display frame: what was on screen at its paint.
  let img: number | undefined;
  let ann: number | undefined;
  let prevImg: number | undefined;
  let prevReal: number | undefined;
  const seen = new Set<number>();
  let imageChanges = 0;
  let slicesShown = 0;
  let blankFrames = 0;
  let mixedFrames = 0;
  let incoherentFrames = 0;
  let k = 0;
  for (let seq = firstSeq; seq <= lastSeq; seq++) {
    while (k < sorted.length && (sorted[k]?.seq ?? Infinity) === seq) {
      const e = sorted[k]!;
      if (e.kind === 'img') img = e.frame;
      else if (e.kind === 'ann') ann = e.frame;
      k++;
    }
    if (img === undefined) continue;
    if (img === -1) blankFrames++;
    else if (img === -2) mixedFrames++;
    else {
      seen.add(img);
      if (prevReal !== undefined && img !== prevReal) slicesShown++;
      prevReal = img;
    }
    if (prevImg !== undefined && img !== prevImg) imageChanges++;
    prevImg = img;
    if (ann !== undefined && img >= 0 && ann !== img) incoherentFrames++;
  }

  // Apply -> first draw showing that frame, unless another apply came first.
  const applies = sorted.filter((e) => e.kind === 'apply');
  const draws = sorted.filter((e) => e.kind === 'img');
  const latencyMs: number[] = [];
  const latencyFrames: number[] = [];
  let delivered = 0;
  for (let i = 0; i < applies.length; i++) {
    const a = applies[i]!;
    const next = applies[i + 1];
    const hit = draws.find(
      (d) =>
        d.frame === a.frame &&
        (d.seq > a.seq || (d.seq === a.seq && d.t >= a.t)) &&
        (next === undefined || d.seq < next.seq || (d.seq === next.seq && d.t < next.t)),
    );
    if (hit) {
      delivered++;
      latencyMs.push(hit.t - a.t);
      latencyFrames.push(hit.seq - a.seq);
    }
  }
  return {
    frames: sorted.length === 0 ? 0 : lastSeq - firstSeq + 1,
    applies: applies.length,
    delivered,
    superseded: applies.length - delivered,
    latencyMs,
    latencyFrames,
    distinctImageFrames: seen.size,
    imageChanges,
    slicesShown,
    blankFrames,
    mixedFrames,
    incoherentFrames,
  };
}
