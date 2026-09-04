import { vi } from 'vitest';
import type OpenSeadragon from 'openseadragon';

/**
 * A stub OpenSeadragon viewer that satisfies exactly the surface
 * {@link FabricOverlay}'s constructor and mode switching touch — a real DOM
 * element for `canvas` (OSD's MouseTracker and Fabric both need one), a
 * viewport with the handful of methods the overlay calls, and spies for the
 * two things mode switching drives outwards (`setMouseNavEnabled`, handler
 * registration).
 *
 * Deliberately *not* a reimplementation of anything under test: the overlay
 * itself is constructed for real, so `setMode` runs the production code path.
 */
export interface TestViewer {
  readonly viewer: OpenSeadragon.Viewer;
  readonly container: HTMLElement;
  readonly setMouseNavEnabled: ReturnType<typeof vi.fn>;
  readonly handlers: Map<string, Array<(...args: unknown[]) => void>>;
  /** Dispose the DOM this viewer added to the document. */
  cleanup(): void;
}

export interface TestViewerOptions {
  readonly containerWidth?: number;
  readonly containerHeight?: number;
  readonly isOpen?: boolean;
}

export function createTestViewer(options: TestViewerOptions = {}): TestViewer {
  const width = options.containerWidth ?? 800;
  const height = options.containerHeight ?? 600;

  const container = document.createElement('div');
  container.style.width = `${width}px`;
  container.style.height = `${height}px`;
  document.body.appendChild(container);

  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const setMouseNavEnabled = vi.fn();

  const viewport = {
    getContainerSize: () => ({ x: width, y: height }),
    getFlip: () => false,
    setFlip: vi.fn(),
    getRotation: () => 0,
    setRotation: vi.fn(),
    applyConstraints: vi.fn(),
    resize: vi.fn(),
    zoomBy: vi.fn(),
    pointFromPixel: (p: { x: number; y: number }) => p,
    imageToViewerElementCoordinates: (p: { x: number; y: number }) => ({ x: p.x, y: p.y }),
    viewerElementToImageCoordinates: (p: { x: number; y: number }) => ({ x: p.x, y: p.y }),
  };

  const viewer = {
    canvas: container,
    viewport,
    drawer: { canvas: document.createElement('canvas') },
    isOpen: () => options.isOpen ?? false,
    forceResize: vi.fn(),
    setMouseNavEnabled,
    addHandler: (name: string, fn: (...args: unknown[]) => void) => {
      const list = handlers.get(name) ?? [];
      list.push(fn);
      handlers.set(name, list);
    },
    removeHandler: (name: string, fn: (...args: unknown[]) => void) => {
      const list = (handlers.get(name) ?? []).filter((h) => h !== fn);
      handlers.set(name, list);
    },
  } as unknown as OpenSeadragon.Viewer;

  return {
    viewer,
    container,
    setMouseNavEnabled,
    handlers,
    cleanup: () => {
      container.remove();
    },
  };
}
