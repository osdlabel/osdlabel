import type { CDPSession, Page } from '@playwright/test';

/**
 * Multi-touch input through CDP's `Input.dispatchTouchEvent`, which produces
 * genuine (trusted) touch pointer events with the platform's own `pointerId`s
 * and `isPrimary`. Playwright's `page.touchscreen` can only tap. Chromium
 * only, as the suite is.
 */

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** One finger: the id CDP knows it by, and where it is, in page px. */
export interface Finger {
  readonly id: number;
  readonly at: Point;
}

const touchPoints = (fingers: readonly Finger[]) =>
  fingers.map(({ id, at }) => ({ x: at.x, y: at.y, id }));

/**
 * Put fingers down. List every finger that is to be down afterwards: CDP
 * presses those it does not yet know and leaves the others where they are.
 */
export async function touchStart(cdp: CDPSession, fingers: readonly Finger[]): Promise<void> {
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: touchPoints(fingers),
  });
}

/** Move fingers that are down, each to its `at`. */
export async function touchMove(cdp: CDPSession, fingers: readonly Finger[]): Promise<void> {
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: touchPoints(fingers),
  });
}

/**
 * Lift the fingers listed, and only those: the others stay down. Chromium
 * releases exactly the points a `touchEnd` lists, though the protocol's
 * documentation says a `touchEnd` takes none; a test relying on this should
 * check the page saw it so (see `recordTouchPointers`).
 */
export async function touchLift(cdp: CDPSession, fingers: readonly Finger[]): Promise<void> {
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: touchPoints(fingers),
  });
}

/** Lift every finger still down. */
export async function touchLiftAll(cdp: CDPSession): Promise<void> {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

/** Press at `path[0]` and drag through the rest of `path`, without lifting. */
export async function touchPressAndDrag(
  cdp: CDPSession,
  id: number,
  path: readonly Point[],
): Promise<void> {
  const [start, ...rest] = path;
  if (!start) throw new Error('a touch path needs a start');
  await touchStart(cdp, [{ id, at: start }]);
  for (const at of rest) await touchMove(cdp, [{ id, at }]);
}

/** `steps` points from `from`, each `step` further on, `from` included. */
export function straightPath(from: Point, step: Point, steps: number): Point[] {
  return Array.from({ length: steps + 1 }, (_, k) => ({
    x: from.x + step.x * k,
    y: from.y + step.y * k,
  }));
}

/** A touch `pointerdown`, `pointerup` or `pointercancel` the page received. */
export interface TouchPointerEvent {
  readonly type: string;
  readonly pointerId: number;
  readonly isPrimary: boolean;
}

/**
 * Start recording the trusted touch `pointerdown` / `pointerup` /
 * `pointercancel` events the page receives, so a test can check the platform
 * produced the gesture it meant to drive. Read with `takeTouchPointers`.
 */
export async function recordTouchPointers(page: Page): Promise<void> {
  await page.evaluate(() => {
    const log: TouchPointerEvent[] = [];
    (window as unknown as { __touchPointers: TouchPointerEvent[] }).__touchPointers = log;
    for (const type of ['pointerdown', 'pointerup', 'pointercancel']) {
      window.addEventListener(
        type,
        (event) => {
          const e = event as PointerEvent;
          if (!e.isTrusted || e.pointerType !== 'touch') return;
          log.push({ type, pointerId: e.pointerId, isPrimary: e.isPrimary });
        },
        true,
      );
    }
  });
}

/** The touch pointer events recorded since the last call. */
export async function takeTouchPointers(page: Page): Promise<TouchPointerEvent[]> {
  return page.evaluate(() =>
    (window as unknown as { __touchPointers: TouchPointerEvent[] }).__touchPointers.splice(0),
  );
}
