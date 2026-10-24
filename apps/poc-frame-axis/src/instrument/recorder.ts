/**
 * In-page recorder: which frame each tile canvas holds, what OSD and Fabric
 * put on screen per display frame, and the display-frame clock itself.
 */
import type {
  DisplayEvent,
  DisplayEventKind,
  FrameLogEntry,
  RawDisplayEvent,
} from './display-log.js';
import { resolveLanding } from './display-log.js';

interface FrameClock {
  ts: number;
  seq: number;
  start: number;
}

declare global {
  interface Window {
    __frame: FrameClock;
    __inRaf: boolean;
    /** Inside a display frame's rendering phase (its rAF callbacks and their microtasks). */
    __renderPhase: boolean;
    __frameLog: FrameLogEntry[];
  }
}

const tags = new WeakMap<HTMLCanvasElement, number>();

/** Record that `canvas` now holds frame `index`. */
export function tagCanvas(canvas: HTMLCanvasElement, index: number): void {
  tags.set(canvas, index);
}

export function canvasTag(canvas: HTMLCanvasElement | undefined | null): number | undefined {
  return canvas ? tags.get(canvas) : undefined;
}

export class Recorder {
  readonly raw: RawDisplayEvent[] = [];
  recording = false;

  log(kind: DisplayEventKind, frame: number): void {
    if (!this.recording) return;
    this.raw.push({
      kind,
      frame,
      seq: window.__frame.seq,
      t: performance.now(),
      // A microtask of the frame's last rAF callback counts as in it: it runs
      // before the paint.
      inRaf: window.__inRaf || window.__renderPhase,
    });
  }

  /** Events placed in the paint they first show up in. */
  get events(): DisplayEvent[] {
    return resolveLanding(this.raw, window.__frameLog);
  }

  reset(): void {
    this.raw.length = 0;
  }
}

/**
 * Measures the display frame rate independently of the code under test: a
 * rAF loop recording each frame's timestamp. Long frames show up as gaps.
 */
export class FrameRateProbe {
  private _stamps: number[] = [];
  private _running = false;

  start(): void {
    this._stamps = [];
    this._running = true;
    const tick = (ts: number): void => {
      if (!this._running) return;
      this._stamps.push(ts);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  stop(): number[] {
    this._running = false;
    const intervals: number[] = [];
    for (let i = 1; i < this._stamps.length; i++) {
      intervals.push(this._stamps[i]! - this._stamps[i - 1]!);
    }
    return intervals;
  }
}

/** Wait `n` display frames. */
export function waitFrames(n: number): Promise<void> {
  return new Promise((resolve) => {
    let left = n;
    const tick = (): void => {
      if (--left <= 0) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
