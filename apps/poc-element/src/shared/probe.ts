/**
 * Page-side instrumentation shared by every host page.
 *
 * - `recordHostEvent` appends what the HOST FRAMEWORK received (after its own
 *   event binding ran), so a spec reads the framework's view, not a raw
 *   listener the test added itself.
 * - `startInteractiveProbe` polls once per animation frame for the first cell
 *   to be interactive: OSD has opened the image, its first tiled image is
 *   fully loaded, and the Fabric overlay exists (testMode exposes it on the
 *   OSD canvas). It walks open shadow roots, so it measures the shadow-DOM
 *   element and the light-DOM bindings the same way.
 */

export interface HostEventRecord {
  readonly type: string;
  /** `annotations.length` for annotationschange; otherwise null. */
  readonly count: number | null;
  readonly geometryTypes: readonly string[];
  readonly at: number;
}

export interface InteractiveMark {
  /** ms since navigation start (performance.timeOrigin). */
  readonly interactiveAt: number;
  readonly frames: number;
}

interface ProbeWindow {
  __hostEvents?: HostEventRecord[];
  __interactive?: InteractiveMark;
  __marks?: Record<string, number>;
}

const w = window as unknown as ProbeWindow;

export function mark(name: string): void {
  (w.__marks ??= {})[name] = performance.now();
}

export function recordHostEvent(type: string, detail: unknown): HostEventRecord {
  const annotations =
    typeof detail === 'object' && detail !== null && 'annotations' in detail
      ? (
          detail as {
            readonly annotations: readonly { readonly geometry: { readonly type: string } }[];
          }
        ).annotations
      : null;
  const record: HostEventRecord = {
    type,
    count: annotations ? annotations.length : null,
    geometryTypes: annotations ? annotations.map((a) => a.geometry.type) : [],
    at: performance.now(),
  };
  (w.__hostEvents ??= []).push(record);
  return record;
}

interface OsdCanvasProbe extends Element {
  __osdOverlay?: unknown;
  __osdViewer?: {
    readonly world: {
      getItemCount(): number;
      getItemAt(i: number): { getFullyLoaded(): boolean } | undefined;
    };
  };
}

/** Every element matching `selector`, in the document and in every open shadow root under it. */
export function deepQueryAll(root: Document | ShadowRoot | Element, selector: string): Element[] {
  const found = [...root.querySelectorAll(selector)];
  for (const el of root.querySelectorAll('*')) {
    if (el.shadowRoot) found.push(...deepQueryAll(el.shadowRoot, selector));
  }
  return found;
}

function firstCellInteractive(): boolean {
  for (const el of deepQueryAll(document, '.openseadragon-canvas')) {
    const c = el as OsdCanvasProbe;
    const item = c.__osdViewer?.world.getItemCount() ? c.__osdViewer.world.getItemAt(0) : undefined;
    if (c.__osdOverlay && item?.getFullyLoaded()) return true;
  }
  return false;
}

/** The element events each host page subscribes to through its framework's own binding syntax. */
export const HOST_EVENT_NAMES = [
  'annotationschange',
  'selectedannotationchange',
  'activetoolchange',
] as const;

function setStatus(testId: string, text: string): void {
  const el = document.querySelector(`[data-testid="${testId}"]`);
  if (el) el.textContent = text;
}

/**
 * Records the event (see `recordHostEvent`) and mirrors it into the page's
 * static status line, which every host page carries.
 */
export function reportHostEvent(type: string, detail: unknown): HostEventRecord {
  const record = recordHostEvent(type, detail);
  const d = (typeof detail === 'object' && detail !== null ? detail : {}) as Record<
    string,
    unknown
  >;
  if (type === 'annotationschange') setStatus('host-annotation-count', String(record.count));
  if (type === 'selectedannotationchange') {
    setStatus('host-selected', String(d['annotationId'] ?? 'none'));
  }
  if (type === 'activetoolchange') setStatus('host-tool', String(d['tool'] ?? 'navigate'));
  return record;
}

export function startInteractiveProbe(): void {
  let frames = 0;
  const tick = (): void => {
    frames++;
    if (firstCellInteractive()) {
      w.__interactive = { interactiveAt: performance.now(), frames };
      return;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
