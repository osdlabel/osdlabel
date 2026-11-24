/**
 * The bridge between a Rust/WASM shell (the Ratzilla TUI, the Leptos app) and
 * the osdlabel viewer.
 *
 * osdlabel renders only the image grid and its annotation canvas, into the
 * `host` element it is given. Where that element sits is the shell's business:
 * Ratzilla lays it over terminal cells, Leptos renders it as part of its own
 * DOM. Every control lives in the shell, which drives the annotator through the
 * {@link Bridge}:
 *
 * - Rust → JS: `dispatch(json)` with a {@link Command}, validated on arrival.
 * - JS → Rust: `subscribe(cb)` delivers a {@link Snapshot} (JSON) whenever the
 *   annotator's state changes, coalesced to one per microtask.
 * - Keys: `onKey(cb)`. The bridge owns the single `keydown` listener. A key the
 *   active tool consumes (Escape / Enter / Backspace mid-polyline, vertex edit)
 *   stops there; every other key goes to the shell. osdlabel's own shortcut
 *   map is switched off, so a key never does two things (#248 would let
 *   osdlabel do this routing itself).
 */
import { createEffect, createSignal, on, untrack } from 'solid-js';
import { render } from 'solid-js/web';
import { unwrap } from 'solid-js/store';
import {
  AnnotatorProvider,
  GridView,
  useAnnotator,
  serialize,
  deserialize,
  shouldSkipKeyboardShortcut,
  shouldSuppressEscapeKey,
  type AnnotationContext,
  type AnnotationState,
  type ImageId,
  type ImageSource,
  type OsdFields,
} from '@osdlabel/solid';
import { MAX_GRID, parseCommand, type Command, type ViewOp } from './commands.js';
import { History } from './history.js';
import { buildSnapshot, type Snapshot } from './snapshot.js';

export type { Command, Snapshot };

/** The handle passed to the WASM `start()` function. */
export interface Bridge {
  /** Applies a JSON-encoded {@link Command}. Returns a status line for the shell. */
  dispatch(json: string): string;
  /** Adds a listener; it is called at once with the latest snapshot, if any. */
  subscribe(cb: (snapshotJson: string) => void): void;
  /** The latest snapshot (JSON), or `''` before the first. */
  getSnapshot(): string;
  onKey(cb: (event: KeyboardEvent) => void): void;
  /** Unmounts the annotator and removes the key listener. */
  destroy(): void;
}

export interface MountOptions {
  /** Where osdlabel renders; it fills this element. */
  readonly host: HTMLElement;
  readonly images: readonly ImageSource[];
  readonly contexts: readonly AnnotationContext[];
}

type Annotator = ReturnType<typeof useAnnotator>;
type ByImage = AnnotationState<OsdFields>['byImage'];

export function mountBridge(options: MountOptions): Bridge {
  const snapshotListeners = new Set<(json: string) => void>();
  let keyListener: ((event: KeyboardEvent) => void) | null = null;
  let lastSnapshot = '';
  let pending = false;
  let annotator: Annotator | null = null;

  const history = new History<ByImage>();
  // The change counter `loadAnnotations` will produce for an undo/redo, so the
  // history effect can tell a restore from a new step.
  let restoringTo: number | null = null;
  const [historyVersion, bumpHistory] = createSignal(0);
  const [notice, setNotice] = createSignal<Snapshot['notice']>(null);
  const announce = (text: string) => setNotice((prev) => ({ seq: (prev?.seq ?? 0) + 1, text }));

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

    // History: one step per committed change.
    createEffect(
      on(
        () => a.annotationState.changeCounter,
        (counter) => {
          if (counter === restoringTo) {
            restoringTo = null;
          } else {
            history.record(structuredClone(unwrap(a.annotationState.byImage)));
          }
          bumpHistory((n) => n + 1);
        },
      ),
    );

    createEffect(() => {
      historyVersion();
      push(
        JSON.stringify(
          buildSnapshot({
            ui: a.uiState,
            contexts: a.contextState,
            annotations: a.annotationState,
            constraints: a.constraintStatus(),
            images: options.images,
            canUndo: history.canUndo,
            canRedo: history.canRedo,
            notice: notice(),
          }),
        ),
      );
    });
    return null;
  };

  const Viewer = () => {
    const { uiState } = useAnnotator();
    return (
      <GridView
        columns={uiState.gridColumns}
        rows={uiState.gridRows}
        maxColumns={MAX_GRID}
        maxRows={MAX_GRID}
        images={options.images}
      />
    );
  };

  const dispose = render(
    () => (
      <AnnotatorProvider shouldSkipKeyboardShortcutPredicate={() => true}>
        <Wiring />
        <Viewer />
      </AnnotatorProvider>
    ),
    options.host,
  );

  const onKeyDown = (e: KeyboardEvent) => {
    if (shouldSuppressEscapeKey(e.key)) return;
    if (e.target instanceof HTMLElement && shouldSkipKeyboardShortcut(e.target, e.key)) return;
    // A tool mid-gesture gets first refusal: Escape cancels a polyline, Enter
    // finishes it, Backspace drops its last vertex.
    if (annotator?.activeToolKeyHandlerRef.handler?.(e)) return;
    keyListener?.(e);
  };
  window.addEventListener('keydown', onKeyDown);

  const restore = (a: Annotator, state: ByImage | undefined, verb: string) => {
    if (!state) return `Nothing to ${verb}`;
    restoringTo = a.annotationState.changeCounter + 1;
    a.actions.setSelectedAnnotation(null);
    // A copy: the store adopts the object it is given, and the history keeps
    // its own.
    a.actions.loadAnnotations(structuredClone(state));
    return verb === 'undo' ? 'Undone' : 'Redone';
  };

  const importFile = (a: Annotator) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    // In the document: some browsers ignore click() on a detached input.
    input.hidden = true;
    document.body.append(input);
    input.addEventListener('cancel', () => input.remove());
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) return;
      file
        .text()
        .then((text) => {
          const { byImage } = deserialize(JSON.parse(text));
          a.actions.setSelectedAnnotation(null);
          a.actions.loadAnnotations(byImage);
          const n = Object.values(byImage).reduce((sum, anns) => sum + Object.keys(anns).length, 0);
          announce(`Imported ${n} annotation(s) from ${file.name}`);
        })
        .catch((err: unknown) =>
          announce(`Import failed: ${err instanceof Error ? err.message : String(err)}`),
        );
    });
    input.click();
  };

  const apply = (a: Annotator, cmd: Command): string => {
    const { actions, uiState } = a;
    switch (cmd.t) {
      case 'tool':
        actions.setActiveTool(cmd.tool);
        return cmd.tool === null ? 'Navigate' : `Tool: ${cmd.tool}`;
      case 'context': {
        const ctx = a.contextState.contexts.find((c) => c.id === cmd.id);
        if (!ctx) return `Unknown context ${cmd.id}`;
        actions.setActiveContext(ctx.id);
        actions.setActiveTool(null);
        return `Context: ${ctx.label}`;
      }
      case 'image': {
        const img = options.images.find((i) => i.id === cmd.id);
        if (!img) return `Unknown image ${cmd.id}`;
        actions.setActiveTool(null);
        actions.assignImageToCell(uiState.activeCellIndex, img.id);
        return `Image: ${img.label ?? img.id}`;
      }
      case 'select': {
        if (cmd.id === null) {
          actions.setSelectedAnnotation(null);
          return 'Selection cleared';
        }
        const imageId = a.activeImageId();
        const ann = imageId
          ? Object.values(a.annotationState.byImage[imageId] ?? {}).find((x) => x.id === cmd.id)
          : undefined;
        if (!ann) return `No annotation ${cmd.id.slice(0, 8)} on this image`;
        actions.setSelectedAnnotation(ann.id);
        return `Selected ${ann.id.slice(0, 8)}`;
      }
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
      case 'import':
        importFile(a);
        return 'Choose a file to import…';
      case 'undo':
        return restore(a, history.undo(), 'undo');
      case 'redo':
        return restore(a, history.redo(), 'redo');
      case 'grid': {
        actions.setGridDimensions(cmd.columns, cmd.rows);
        // Fill new, empty cells with images not on screen yet.
        const cells = cmd.columns * cmd.rows;
        const shown = new Set<ImageId>();
        for (let i = 0; i < cells; i++) {
          const id = uiState.gridAssignments[i];
          if (id) shown.add(id);
        }
        const spare = options.images.filter((img) => !shown.has(img.id));
        for (let i = 0; i < cells; i++) {
          if (uiState.gridAssignments[i]) continue;
          const next = spare.shift();
          if (next) actions.assignImageToCell(i, next.id);
        }
        return `Grid: ${cmd.columns}×${cmd.rows}`;
      }
      case 'cell':
        if (cmd.index >= uiState.gridColumns * uiState.gridRows) return `No cell ${cmd.index + 1}`;
        actions.setActiveCell(cmd.index);
        return `Cell ${cmd.index + 1}`;
    }
  };

  return {
    dispatch(json) {
      if (!annotator) return 'Annotator not mounted';
      const parsed = parseCommand(json);
      if (!parsed.ok) {
        console.error('Rejected command from the shell:', json, parsed.error);
        return `Rejected command: ${parsed.error}`;
      }
      return apply(annotator, parsed.command);
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
    destroy() {
      window.removeEventListener('keydown', onKeyDown);
      dispose();
      snapshotListeners.clear();
      keyListener = null;
      annotator = null;
    },
  };
}

function runViewOp(actions: Annotator['actions'], op: ViewOp): void {
  switch (op) {
    case 'rotateCw':
      return actions.rotateActiveImageCW();
    case 'rotateCcw':
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
