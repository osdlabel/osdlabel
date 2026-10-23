/**
 * Coalesces a stream of values (frame indices from a wheel) to at most one
 * `apply` per display frame.
 *
 * Leading edge: the first request in a display frame applies at once, so a
 * 60 Hz wheel on a 60 Hz display is never delayed. Trailing edge: requests
 * arriving before the next frame collapse to the newest, applied when it
 * comes. A 120 Hz trackpad therefore costs one swap per paint, not two, and a
 * slow swap cannot queue a backlog.
 *
 * Framework-neutral; both bindings drive their "presented frame" through it.
 */
export interface FrameThrottle<T> {
  request(value: T): void;
  cancel(): void;
}

export function createFrameThrottle<T>(
  apply: (value: T) => void,
  schedule: (cb: () => void) => unknown = (cb) => requestAnimationFrame(cb),
): FrameThrottle<T> {
  let busy = false;
  let cancelled = false;
  let pending: { value: T } | undefined;
  const release = (): void => {
    if (cancelled) return;
    if (pending === undefined) {
      busy = false;
      return;
    }
    const { value } = pending;
    pending = undefined;
    apply(value);
    schedule(release);
  };
  return {
    request(value) {
      if (cancelled) return;
      if (busy) {
        pending = { value };
        return;
      }
      busy = true;
      apply(value);
      schedule(release);
    },
    cancel() {
      cancelled = true;
      pending = undefined;
    },
  };
}
