import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createComponent, createRoot, createSignal, untrack, type Setter } from 'solid-js';
import type { FabricOverlay } from '@osdlabel/fabric-osd';
import {
  PolylineTool,
  type AnnotationTool,
  type VertexMarkerOptions,
} from '@osdlabel/fabric-annotations';
import { createImageId, type KeyboardShortcutMap } from '@osdlabel/viewer-api';
import { createAnnotationContextId } from '@osdlabel/annotation-context';
import { AnnotatorProvider, useAnnotator } from '../../../src/state/annotator-context.js';
import { useAnnotationTool } from '../../../src/hooks/useAnnotationTool.js';

/**
 * The provider config a host can change after mount — `keyboardShortcuts`,
 * `vertexMarkers`, `vertexEditLongPressMs`, `vertexEditMoveTolerancePx` — as the
 * tool sees it (#219). It needs the real provider, whose value-compared memos
 * are what is under test, so it cannot live in `useAnnotationTool.test.ts`,
 * which mocks the provider module. React covers the same behaviour in its
 * `useAnnotationTool.test.tsx` ("is rebuilt when a real input changes").
 */

interface CreatedTool {
  readonly tool: AnnotationTool;
  readonly options: unknown;
}
const createdTools: CreatedTool[] = [];

vi.mock('osdlabel', async () => {
  const actual = (await vi.importActual('osdlabel')) as Record<string, unknown>;
  const realFactory = actual.createAnnotationTool as (
    type: unknown,
    options: unknown,
  ) => AnnotationTool | null;
  return {
    ...actual,
    createAnnotationTool: (type: unknown, options: unknown) => {
      const tool = realFactory(type, options);
      if (tool) createdTools.push({ tool, options });
      return tool;
    },
  };
});

const imageId = createImageId('img-1');
const contextId = createAnnotationContextId('ctx-1');

/** A stand-in overlay: only what the hook and an idle polyline tool touch. */
function makeOverlay(): FabricOverlay {
  const canvas = {
    on: vi.fn(),
    off: vi.fn(),
    requestRenderAll: vi.fn(),
    discardActiveObject: vi.fn(),
    getObjects: vi.fn().mockReturnValue([]),
    remove: vi.fn(),
    add: vi.fn(),
  };
  return {
    canvas,
    setMode: vi.fn(),
    screenToImage: vi.fn(),
    onDoubleClick: vi.fn(() => () => {}),
  } as unknown as FabricOverlay;
}

interface Harness {
  readonly setShortcuts: Setter<Partial<KeyboardShortcutMap> | undefined>;
  readonly setMarkers: Setter<VertexMarkerOptions | undefined>;
  readonly setLongPress: Setter<number | undefined>;
  readonly setTolerance: Setter<number | undefined>;
  readonly annotator: ReturnType<typeof useAnnotator>;
}

let dispose: (() => void) | undefined;

/** Mounts the real provider with a polyline tool active on one cell. */
function setup(): Harness {
  const [shortcuts, setShortcuts] = createSignal<Partial<KeyboardShortcutMap> | undefined>({
    rectangleTool: 'b',
  });
  const [markers, setMarkers] = createSignal<VertexMarkerOptions | undefined>({ radius: 4 });
  const [longPress, setLongPress] = createSignal<number | undefined>(500);
  const [tolerance, setTolerance] = createSignal<number | undefined>(6);
  let annotator: ReturnType<typeof useAnnotator> | undefined;
  const overlay = makeOverlay();

  createRoot((d) => {
    dispose = d;
    createComponent(AnnotatorProvider, {
      get keyboardShortcuts() {
        return shortcuts();
      },
      get vertexMarkers() {
        return markers();
      },
      get vertexEditLongPressMs() {
        return longPress();
      },
      get vertexEditMoveTolerancePx() {
        return tolerance();
      },
      get children() {
        // Untracked, as a component body is: Solid evaluates `children` inside
        // a tracking memo, so without this a setup-time read of the config
        // would re-mount the whole subtree on a change and pass the rebuild
        // tests for the wrong reason. `ViewerCell`, the real call site, runs
        // the hook inside `createComponent`, which untracks.
        untrack(() => {
          annotator = useAnnotator();
          annotator.actions.setContexts([
            {
              id: contextId,
              label: 'Test',
              tools: [{ type: 'polyline' }, { type: 'rectangle' }],
            },
          ]);
          annotator.actions.setActiveContext(contextId);
          annotator.actions.assignImageToCell(0, imageId);
          annotator.actions.setActiveTool('polyline');
          useAnnotationTool(
            () => overlay,
            () => imageId,
            () => true,
          );
        });
        return null;
      },
    });
  });

  expect(annotator).toBeDefined();
  return { setShortcuts, setMarkers, setLongPress, setTolerance, annotator: annotator! };
}

describe('useAnnotationTool with the provider config (#219)', () => {
  let activate: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    createdTools.length = 0;
    activate = vi.spyOn(PolylineTool.prototype, 'activate');
  });

  afterEach(() => {
    dispose?.();
    dispose = undefined;
    activate.mockRestore();
  });

  it('builds the tool once on mount', () => {
    setup();
    expect(createdTools).toHaveLength(1);
  });

  describe('is not rebuilt for a re-created object with the same values', () => {
    it('keyboardShortcuts', () => {
      const h = setup();
      h.setShortcuts({ rectangleTool: 'b' });
      expect(createdTools).toHaveLength(1);
    });

    it('vertexMarkers', () => {
      const h = setup();
      h.setMarkers({ radius: 4 });
      expect(createdTools).toHaveLength(1);
    });

    it('the vertex-edit tuning, when an explicit value gives way to the equal default', () => {
      // A signal set to the same number never notifies, so the case that
      // reaches the memo's comparison is a new input resolving to the same
      // config: 500 is DEFAULT_VERTEX_EDIT_LONG_PRESS_MS.
      const h = setup();
      h.setLongPress(undefined);
      expect(h.annotator.vertexEditConfig.longPressMs).toBe(500);
      expect(createdTools).toHaveLength(1);
    });
  });

  describe('is rebuilt, with the new value, when it changes', () => {
    it('keyboardShortcuts', () => {
      const h = setup();
      h.setShortcuts({ rectangleTool: 'b', polylineFinish: 'f' });

      expect(createdTools).toHaveLength(2);
      expect(activate).toHaveBeenCalledTimes(2);
      const shortcuts = activate.mock.calls[1]![3] as KeyboardShortcutMap;
      expect(shortcuts.polylineFinish).toBe('f');
    });

    it('vertexMarkers', () => {
      const h = setup();
      h.setMarkers({ radius: 9 });

      expect(createdTools).toHaveLength(2);
      expect(createdTools[1]!.options).toMatchObject({ vertexMarkers: { radius: 9 } });
    });

    it('vertexEditLongPressMs', () => {
      const h = setup();
      h.setLongPress(900);

      expect(createdTools).toHaveLength(2);
      expect(createdTools[1]!.options).toMatchObject({
        vertexEdit: { longPressMs: 900, moveTolerancePx: 6 },
      });
    });

    it('vertexEditMoveTolerancePx', () => {
      const h = setup();
      h.setTolerance(12);

      expect(createdTools).toHaveLength(2);
      expect(createdTools[1]!.options).toMatchObject({
        vertexEdit: { longPressMs: 500, moveTolerancePx: 12 },
      });
    });

    it('deactivates the tool it replaces', () => {
      const h = setup();
      const first = createdTools[0]!.tool;
      const deactivate = vi.spyOn(first, 'deactivate');
      h.setMarkers({ radius: 9 });
      expect(deactivate).toHaveBeenCalledTimes(1);
    });
  });

  it('the keyboard follows a changed binding without remounting', () => {
    const h = setup();
    const press = (key: string) =>
      window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));

    press('b');
    expect(h.annotator.uiState.activeTool).toBe('rectangle');

    h.annotator.actions.setActiveTool('polyline');
    h.setShortcuts({ rectangleTool: 'j' });

    press('b');
    expect(h.annotator.uiState.activeTool).toBe('polyline');
    press('j');
    expect(h.annotator.uiState.activeTool).toBe('rectangle');
  });
});
