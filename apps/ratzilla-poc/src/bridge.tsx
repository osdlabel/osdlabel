/**
 * The bridge between the Ratzilla shell (Rust/WASM) and the osdlabel viewer.
 *
 * osdlabel renders only the image and its annotation canvas, into a `<div>`
 * laid over the terminal area the shell reserves for it. Every control — tools,
 * contexts, images, view transforms, selection, delete, export — lives in the
 * TUI, which drives the annotator through the {@link Bridge} handle:
 *
 * - Rust → JS: `dispatch(json)` with a {@link Command}.
 * - JS → Rust: `subscribe(cb)` delivers a {@link Snapshot} (JSON) whenever the
 *   annotator's state changes, coalesced to one per microtask.
 * - Keys: `onKey(cb)`. The bridge owns the single `keydown` listener. A key the
 *   active tool consumes (Escape / Enter / Backspace mid-polyline, vertex edit)
 *   stops there; every other key goes to the TUI. osdlabel's own shortcut map
 *   is switched off, so a key never does two things.
 * - Layout: `setViewerRect(col, row, cols, rows)` places the viewer over those
 *   terminal cells.
 */
import { createEffect, untrack } from 'solid-js';
import { render } from 'solid-js/web';
import {
  AnnotatorProvider,
  GridView,
  useAnnotator,
  serialize,
  shouldSkipKeyboardShortcut,
  shouldSuppressEscapeKey,
  DEFAULT_CELL_TRANSFORM,
  type AnnotationContext,
  type AnnotationContextId,
  type AnnotationId,
  type ImageId,
  type ImageSource,
  type ToolType,
} from '@osdlabel/solid';

export type ViewOp =
  | 'rotateCW'
  | 'rotateCCW'
  | 'flipH'
  | 'flipV'
  | 'invert'
  | 'exposureUp'
  | 'exposureDown'
  | 'contrastUp'
  | 'contrastDown'
  | 'reset';

/** What the TUI can ask the annotator to do. */
export type Command =
  | { readonly t: 'tool'; readonly tool: ToolType | 'select' | null }
  | { readonly t: 'context'; readonly id: string }
  | { readonly t: 'image'; readonly id: string }
  | { readonly t: 'select'; readonly id: string | null }
  | { readonly t: 'delete' }
  | { readonly t: 'view'; readonly op: ViewOp }
  | { readonly t: 'export' };

/** What the TUI is told after every state change. */
export interface Snapshot {
  readonly activeTool: ToolType | 'select' | null;
  readonly activeContextId: string | null;
  readonly contexts: readonly { readonly id: string; readonly label: string }[];
  readonly images: readonly {
    readonly id: string;
    readonly label: string;
    readonly count: number;
  }[];
  readonly activeImageId: string | null;
  readonly selectedAnnotationId: string | null;
  readonly constraints: Readonly<
    Record<
      string,
      { readonly enabled: boolean; readonly current: number; readonly max: number | null }
    >
  >;
  readonly annotations: readonly {
    readonly id: string;
    readonly tool: string;
    readonly geometry: string;
    readonly context: string;
    /** Painted on the canvas: its context is the active or a displayed one (ViewerCell's rule). */
    readonly visible: boolean;
  }[];
  readonly transform: {
    readonly rotation: number;
    readonly flippedH: boolean;
    readonly flippedV: boolean;
    readonly inverted: boolean;
    readonly exposure: number;
    readonly contrast: number;
  };
}

/** The handle passed to the WASM `start()` function. */
export interface Bridge {
  /** Applies a JSON-encoded {@link Command}. Returns a status message for the TUI. */
  dispatch(json: string): string;
  /** Adds a listener; it is called at once with the latest snapshot, if any. */
  subscribe(cb: (snapshotJson: string) => void): void;
  /** The latest snapshot (JSON), or `''` before the first. */
  getSnapshot(): string;
  onKey(cb: (event: KeyboardEvent) => void): void;
  setViewerRect(col: number, row: number, cols: number, rows: number): void;
}

export interface MountOptions {
  readonly host: HTMLElement;
  /** The Ratzilla grid element, used to turn terminal cells into pixels. */
  readonly gridElement: () => HTMLElement | null;
  readonly images: readonly ImageSource[];
  readonly contexts: readonly AnnotationContext[];
}

export function mountBridge(options: MountOptions): Bridge {
  const snapshotListeners = new Set<(json: string) => void>();
  let keyListener: ((event: KeyboardEvent) => void) | null = null;
  let lastSnapshot = '';
  let pending = false;
  let annotator: ReturnType<typeof useAnnotator> | null = null;

  const push = (json: string) => {
    lastSnapshot = json;
    if (pending) return;
    pending = true;
    // Deliver outside the Solid update (and outside any Rust call that caused
    // it): the shell holds a borrow of its state while it dispatches.
    queueMicrotask(() => {
      pending = false;
      for (const listener of snapshotListeners) listener(lastSnapshot);
    });
  };

  const Wiring = () => {
    const a = useAnnotator();
    annotator = a;
    untrack(() => {
      a.actions.setContexts([...options.contexts]);
      a.actions.setActiveContext(options.contexts[0]?.id ?? null);
      const first = options.images[0];
      if (first) a.actions.assignImageToCell(0, first.id);
    });

    createEffect(() => {
      const ui = a.uiState;
      const ctx = a.contextState;
      const imageId = a.activeImageId() ?? null;
      const status = a.constraintStatus();
      const byImage = a.annotationState.byImage;
      const labelOf = (id: AnnotationContextId) =>
        ctx.contexts.find((c) => c.id === id)?.label ?? id;
      const current = imageId ? Object.values(byImage[imageId] ?? {}) : [];
      const shown = new Set<string>(ctx.displayedContextIds);
      if (ctx.activeContextId) shown.add(ctx.activeContextId);
      const t = ui.cellTransforms[ui.activeCellIndex] ?? DEFAULT_CELL_TRANSFORM;
      const snapshot: Snapshot = {
        activeTool: ui.activeTool,
        activeContextId: ctx.activeContextId,
        contexts: ctx.contexts.map((c) => ({ id: c.id, label: c.label })),
        images: options.images.map((img) => ({
          id: img.id,
          label: img.label ?? img.id,
          count: Object.keys(byImage[img.id] ?? {}).length,
        })),
        activeImageId: imageId,
        selectedAnnotationId: ui.selectedAnnotationId,
        constraints: Object.fromEntries(
          Object.entries(status).map(([tool, s]) => [
            tool,
            { enabled: s.enabled, current: s.currentCount, max: s.maxCount },
          ]),
        ),
        annotations: current
          .slice()
          .sort((x, y) => x.createdAt.localeCompare(y.createdAt))
          .map((ann) => ({
            id: ann.id,
            tool: ann.toolType,
            geometry: ann.geometry.type,
            context: labelOf(ann.contextId),
            visible: shown.size === 0 || shown.has(ann.contextId),
          })),
        transform: {
          rotation: t.rotation,
          flippedH: t.flippedH,
          flippedV: t.flippedV,
          inverted: t.inverted,
          exposure: t.exposure,
          contrast: t.contrast,
        },
      };
      push(JSON.stringify(snapshot));
    });
    return null;
  };

  render(
    () => (
      <AnnotatorProvider shouldSkipKeyboardShortcutPredicate={() => true}>
        <Wiring />
        <GridView columns={1} rows={1} maxColumns={1} maxRows={1} images={options.images} />
      </AnnotatorProvider>
    ),
    options.host,
  );

  window.addEventListener('keydown', (e) => {
    if (shouldSuppressEscapeKey(e.key)) return;
    if (e.target instanceof HTMLElement && shouldSkipKeyboardShortcut(e.target, e.key)) return;
    // A tool mid-gesture gets first refusal: Escape cancels a polyline, Enter
    // finishes it, Backspace drops its last vertex.
    if (annotator?.activeToolKeyHandlerRef.handler?.(e)) return;
    keyListener?.(e);
  });

  const requireAnnotator = () => {
    if (!annotator) throw new Error('annotator not mounted');
    return annotator;
  };

  return {
    dispatch(json) {
      const a = requireAnnotator();
      const cmd = JSON.parse(json) as Command;
      const { actions, uiState } = a;
      switch (cmd.t) {
        case 'tool':
          actions.setActiveTool(cmd.tool);
          return cmd.tool === null ? 'Navigate' : `Tool: ${cmd.tool}`;
        case 'context':
          actions.setActiveContext(cmd.id as AnnotationContextId);
          actions.setActiveTool(null);
          return `Context: ${a.contextState.contexts.find((c) => c.id === cmd.id)?.label ?? cmd.id}`;
        case 'image':
          actions.setActiveTool(null);
          actions.assignImageToCell(uiState.activeCellIndex, cmd.id as ImageId);
          return `Image: ${cmd.id}`;
        case 'select':
          actions.setSelectedAnnotation(cmd.id as AnnotationId | null);
          return cmd.id ? `Selected ${cmd.id.slice(0, 8)}` : 'Selection cleared';
        case 'delete': {
          const id = uiState.selectedAnnotationId;
          const imageId = a.activeImageId();
          if (!id || !imageId) return 'Nothing selected';
          actions.deleteAnnotation(id, imageId);
          return `Deleted ${id.slice(0, 8)}`;
        }
        case 'view':
          runViewOp(actions, cmd.op);
          return `View: ${cmd.op}`;
        case 'export': {
          const doc = serialize(a.annotationState);
          const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
          const link = document.createElement('a');
          link.href = URL.createObjectURL(blob);
          link.download = 'annotations.json';
          link.click();
          URL.revokeObjectURL(link.href);
          return `Exported ${doc.length} annotation(s) to annotations.json`;
        }
      }
    },
    subscribe(cb) {
      snapshotListeners.add(cb);
      if (lastSnapshot) cb(lastSnapshot);
    },
    getSnapshot() {
      return lastSnapshot;
    },
    onKey(cb) {
      keyListener = cb;
    },
    setViewerRect(col, row, cols, rows) {
      const grid = options.gridElement();
      const first = grid?.children[row]?.children[col];
      const last = grid?.children[row + rows - 1]?.children[col + cols - 1];
      if (!first || !last || cols <= 0 || rows <= 0) {
        options.host.style.display = 'none';
        return;
      }
      const a = first.getBoundingClientRect();
      const b = last.getBoundingClientRect();
      Object.assign(options.host.style, {
        display: 'block',
        left: `${a.left}px`,
        top: `${a.top}px`,
        width: `${b.right - a.left}px`,
        height: `${b.bottom - a.top}px`,
      });
    },
  };
}

function runViewOp(actions: ReturnType<typeof useAnnotator>['actions'], op: ViewOp): void {
  switch (op) {
    case 'rotateCW':
      return actions.rotateActiveImageCW();
    case 'rotateCCW':
      return actions.rotateActiveImageCCW();
    case 'flipH':
      return actions.flipActiveImageH();
    case 'flipV':
      return actions.flipActiveImageV();
    case 'invert':
      return actions.toggleActiveImageNegative();
    case 'exposureUp':
      return actions.increaseActiveImageExposure();
    case 'exposureDown':
      return actions.decreaseActiveImageExposure();
    case 'contrastUp':
      return actions.increaseActiveImageContrast();
    case 'contrastDown':
      return actions.decreaseActiveImageContrast();
    case 'reset':
      return actions.resetActiveImageView();
  }
}
