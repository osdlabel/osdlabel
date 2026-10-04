import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

/** A React tree mounted into a fresh `<div>` appended to `document.body`. */
export interface Mounted {
  readonly container: HTMLDivElement;
  /** Renders `node` into the same root, as a parent re-render would. */
  rerender(node: ReactNode): void;
  /** Unmounts the root (running every effect cleanup) and removes the container. */
  unmount(): void;
}

const mountedRoots = new Set<Mounted>();

/**
 * Unmounts everything `mount` mounted and has not yet been unmounted. Call it
 * from `afterEach`, so a failed assertion cannot leave a root (and its window
 * listeners) alive into the next test.
 */
export function unmountAll(): void {
  for (const m of [...mountedRoots]) m.unmount();
}

/**
 * Mounts `node` with `react-dom/client` and flushes it with React 19's `act`,
 * so every effect has run by the time this returns. `@testing-library/react`
 * would do the same and nothing more that these tests need.
 *
 * `rerender` and `unmount` are wrapped in `act` too. Anything else that
 * triggers a React update — an action dispatch, a captured Fabric/OSD handler
 * — must be wrapped by the caller.
 */
export function mount(node: ReactNode): Mounted {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  let unmounted = false;
  const mounted: Mounted = {
    container,
    rerender(next) {
      act(() => {
        root.render(next);
      });
    },
    unmount() {
      if (unmounted) return;
      unmounted = true;
      mountedRoots.delete(mounted);
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
  mountedRoots.add(mounted);
  return mounted;
}
