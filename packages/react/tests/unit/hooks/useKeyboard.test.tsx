import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createAnnotationId } from '@osdlabel/annotation';
import { createImageId, type ImageId, type UIState } from '@osdlabel/viewer-api';
import {
  createAnnotationContextId,
  type AnnotationContext,
  type ContextState,
} from '@osdlabel/annotation-context';
import { createInitialUIState, type ConstraintStatus } from 'osdlabel';
import type { KeyboardShortcutMap } from '@osdlabel/viewer-api';
import { useKeyboard, DEFAULT_KEYBOARD_SHORTCUTS } from '../../../src/hooks/useKeyboard.js';
import type { ActiveToolKeyHandlerRef } from '../../../src/state/annotator-context.js';
import { mount, unmountAll, type Mounted } from '../mount.js';
import { allEnabled, createMockActions, type MockActions } from './mock-annotator.js';

/**
 * The React counterpart of Solid's `hooks/useKeyboard.test.ts`.
 *
 * Solid's hook reads the annotator context itself and its handler reads the
 * live store on every keypress. React's takes the state as arguments and
 * closes over them in a `useCallback`, re-subscribing the window listener
 * whenever a dependency changes. So besides the shared behaviour, the tests
 * here re-render with new arguments and press a key afterwards: a dependency
 * missing from the `useCallback` list leaves the listener acting on the state
 * of an earlier render.
 */

const makeContext = (id: string): AnnotationContext => ({
  id: createAnnotationContextId(id),
  label: id,
  tools: [],
});

interface KeyboardArgs {
  readonly shortcuts: KeyboardShortcutMap;
  readonly activeToolKeyHandlerRef: ActiveToolKeyHandlerRef;
  readonly actions: MockActions;
  readonly uiState: UIState;
  readonly contextState: ContextState;
  readonly activeImageId: ImageId | undefined;
  readonly constraintStatus: ConstraintStatus;
  readonly shouldSkipTargetPredicate?: ((target: HTMLElement) => boolean) | undefined;
}

function KeyboardHost({ args }: { readonly args: KeyboardArgs }) {
  useKeyboard(
    args.shortcuts,
    args.activeToolKeyHandlerRef,
    args.actions,
    args.uiState,
    args.contextState,
    args.activeImageId,
    args.constraintStatus,
    args.shouldSkipTargetPredicate,
  );
  return null;
}

/** Dispatches a keydown on `window` with `target` standing in for the focused element. */
function dispatchKeyDown(key: string, target?: Partial<HTMLElement>, shiftKey = false) {
  const event = new KeyboardEvent('keydown', { key, shiftKey });
  Object.defineProperty(event, 'target', {
    value: target ?? document.createElement('div'),
    enumerable: true,
  });
  window.dispatchEvent(event);
}

describe('useKeyboard', () => {
  let actions: MockActions;
  let activeToolKeyHandlerRef: ActiveToolKeyHandlerRef;
  let args: KeyboardArgs;
  let mounted: Mounted;

  /** Re-renders the host with `patch` merged into the previous arguments. */
  function update(patch: Partial<KeyboardArgs>): void {
    args = { ...args, ...patch };
    mounted.rerender(<KeyboardHost args={args} />);
  }

  /** Re-renders with `patch` merged into the previous `uiState`. */
  function updateUi(patch: Partial<UIState>): void {
    update({ uiState: { ...args.uiState, ...patch } });
  }

  function updateContexts(patch: Partial<ContextState>): void {
    update({ contextState: { ...args.contextState, ...patch } });
  }

  beforeEach(() => {
    actions = createMockActions();
    activeToolKeyHandlerRef = { handler: null };
    const gridAssignments: Record<number, ImageId> = {};
    for (let i = 0; i < 9; i++) gridAssignments[i] = createImageId(`img-${i + 1}`);
    args = {
      shortcuts: DEFAULT_KEYBOARD_SHORTCUTS,
      activeToolKeyHandlerRef,
      actions,
      uiState: { ...createInitialUIState(), gridAssignments },
      contextState: {
        contexts: [makeContext('ctx-a'), makeContext('ctx-b'), makeContext('ctx-c')],
        activeContextId: createAnnotationContextId('ctx-a'),
        displayedContextIds: [],
      },
      activeImageId: createImageId('img-1'),
      constraintStatus: allEnabled(),
    };
    mounted = mount(<KeyboardHost args={args} />);
  });

  afterEach(unmountAll);

  it('should ignore events when target is INPUT, TEXTAREA, or contentEditable', () => {
    dispatchKeyDown('v', { tagName: 'INPUT' });
    dispatchKeyDown('v', { tagName: 'TEXTAREA' });
    dispatchKeyDown('v', { isContentEditable: true });

    expect(actions.setActiveTool).not.toHaveBeenCalled();
  });

  describe('a focused button (#189)', () => {
    const button = (): HTMLButtonElement => document.createElement('button');

    it('leaves Enter and Space to the button, not the active tool', () => {
      const handler = vi.fn().mockReturnValue(true);
      activeToolKeyHandlerRef.handler = handler;

      dispatchKeyDown('Enter', button());
      dispatchKeyDown(' ', button());

      expect(handler).not.toHaveBeenCalled();
    });

    it('still lets other shortcuts through', () => {
      dispatchKeyDown('v', button());
      expect(actions.setActiveTool).toHaveBeenCalledWith('select');
    });

    it('treats role="button" the same way', () => {
      const handler = vi.fn().mockReturnValue(true);
      activeToolKeyHandlerRef.handler = handler;
      const div = document.createElement('div');
      div.setAttribute('role', 'button');

      dispatchKeyDown('Enter', div);

      expect(handler).not.toHaveBeenCalled();
    });

    it('still delivers Enter to the active tool from a non-button target', () => {
      const handler = vi.fn().mockReturnValue(true);
      activeToolKeyHandlerRef.handler = handler;

      dispatchKeyDown('Enter');

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  it('should ignore events when shouldSkipTargetPredicate returns true', () => {
    const predicate = vi.fn((target: HTMLElement) => target.className === 'ignore-me');
    update({ shouldSkipTargetPredicate: predicate });

    dispatchKeyDown('v', { className: 'ignore-me', tagName: 'DIV' });
    expect(predicate).toHaveBeenCalled();
    expect(actions.setActiveTool).not.toHaveBeenCalled();

    dispatchKeyDown('v', { className: 'process-me', tagName: 'DIV' });
    expect(actions.setActiveTool).toHaveBeenCalledWith('select');
  });

  it('should pass event to activeToolKeyHandlerRef and stop if consumed', () => {
    const handler = vi.fn().mockReturnValue(true);
    activeToolKeyHandlerRef.handler = handler;

    dispatchKeyDown('v');

    expect(handler).toHaveBeenCalled();
    expect(actions.setActiveTool).not.toHaveBeenCalled();
  });

  it('should process event if activeToolKeyHandlerRef returns false', () => {
    const handler = vi.fn().mockReturnValue(false);
    activeToolKeyHandlerRef.handler = handler;

    dispatchKeyDown('v');

    expect(handler).toHaveBeenCalled();
    expect(actions.setActiveTool).toHaveBeenCalledWith('select');
  });

  it('reads the handler slot at keypress time, not at subscription', () => {
    // useAnnotationTool writes the slot from its own effect, after this hook
    // has subscribed; the slot is a mutable object precisely so no re-render
    // is needed for the listener to see it.
    const handler = vi.fn().mockReturnValue(true);
    dispatchKeyDown('v');
    expect(actions.setActiveTool).toHaveBeenCalledTimes(1);

    activeToolKeyHandlerRef.handler = handler;
    dispatchKeyDown('v');

    expect(handler).toHaveBeenCalledTimes(1);
    expect(actions.setActiveTool).toHaveBeenCalledTimes(1);
  });

  describe('Tool Selection Shortcuts', () => {
    it('should set tool on matching key press if enabled', () => {
      dispatchKeyDown(DEFAULT_KEYBOARD_SHORTCUTS.selectTool);
      expect(actions.setActiveTool).toHaveBeenCalledWith('select');

      dispatchKeyDown(DEFAULT_KEYBOARD_SHORTCUTS.rectangleTool);
      expect(actions.setActiveTool).toHaveBeenCalledWith('rectangle');

      dispatchKeyDown(DEFAULT_KEYBOARD_SHORTCUTS.circleTool);
      expect(actions.setActiveTool).toHaveBeenCalledWith('circle');

      dispatchKeyDown(DEFAULT_KEYBOARD_SHORTCUTS.lineTool);
      expect(actions.setActiveTool).toHaveBeenCalledWith('line');

      dispatchKeyDown(DEFAULT_KEYBOARD_SHORTCUTS.pointTool);
      expect(actions.setActiveTool).toHaveBeenCalledWith('point');

      dispatchKeyDown(DEFAULT_KEYBOARD_SHORTCUTS.polylineTool);
      expect(actions.setActiveTool).toHaveBeenCalledWith('polyline');
    });

    it('should handle uppercase tool shortcuts', () => {
      dispatchKeyDown('V');
      expect(actions.setActiveTool).toHaveBeenCalledWith('select');
    });

    it('should NOT set tool when the constraint status reports it disabled', () => {
      update({
        constraintStatus: allEnabled({
          rectangle: { enabled: false, currentCount: 1, maxCount: 1 },
        }),
      });

      dispatchKeyDown(DEFAULT_KEYBOARD_SHORTCUTS.rectangleTool);
      expect(actions.setActiveTool).not.toHaveBeenCalledWith('rectangle');

      dispatchKeyDown(DEFAULT_KEYBOARD_SHORTCUTS.circleTool);
      expect(actions.setActiveTool).toHaveBeenCalledWith('circle');
    });
  });

  describe('View Transform Shortcuts', () => {
    it('should rotate CW on Shift+R', () => {
      dispatchKeyDown('R', undefined, true);
      expect(actions.rotateActiveImageCW).toHaveBeenCalled();
    });

    it('should rotate CCW on Shift+L', () => {
      dispatchKeyDown('L', undefined, true);
      expect(actions.rotateActiveImageCCW).toHaveBeenCalled();
    });

    it('should flip horizontal on Shift+H', () => {
      dispatchKeyDown('H', undefined, true);
      expect(actions.flipActiveImageH).toHaveBeenCalled();
    });

    it('should flip vertical on Shift+V', () => {
      dispatchKeyDown('V', undefined, true);
      expect(actions.flipActiveImageV).toHaveBeenCalled();
    });

    it('should reset view on Reset View key', () => {
      dispatchKeyDown(DEFAULT_KEYBOARD_SHORTCUTS.resetView);
      expect(actions.resetActiveImageView).toHaveBeenCalled();
    });

    it('should reset view on Shift+0', () => {
      dispatchKeyDown(')', undefined, true);
      expect(actions.resetActiveImageView).toHaveBeenCalled();
      dispatchKeyDown('0', undefined, true);
      expect(actions.resetActiveImageView).toHaveBeenCalledTimes(2);
    });

    it('plain r should still trigger rectangle tool, not rotation', () => {
      dispatchKeyDown('r', undefined, false);
      expect(actions.rotateActiveImageCW).not.toHaveBeenCalled();
      expect(actions.setActiveTool).toHaveBeenCalledWith('rectangle');
    });

    it('plain l should still trigger line tool, not rotation', () => {
      dispatchKeyDown('l', undefined, false);
      expect(actions.rotateActiveImageCCW).not.toHaveBeenCalled();
      expect(actions.setActiveTool).toHaveBeenCalledWith('line');
    });

    it('routes the image-adjustment shortcuts to their actions', () => {
      // React's `dispatchAction` switch is hand-maintained in parallel with
      // Solid's; a dropped case is a shortcut that silently does nothing.
      dispatchKeyDown(DEFAULT_KEYBOARD_SHORTCUTS.toggleNegative, undefined, true);
      dispatchKeyDown(DEFAULT_KEYBOARD_SHORTCUTS.increaseExposure, undefined, true);
      dispatchKeyDown(DEFAULT_KEYBOARD_SHORTCUTS.decreaseExposure, undefined, true);
      dispatchKeyDown(DEFAULT_KEYBOARD_SHORTCUTS.increaseContrast, undefined, true);
      dispatchKeyDown(DEFAULT_KEYBOARD_SHORTCUTS.decreaseContrast, undefined, true);

      expect(actions.toggleActiveImageNegative).toHaveBeenCalledTimes(1);
      expect(actions.increaseActiveImageExposure).toHaveBeenCalledTimes(1);
      expect(actions.decreaseActiveImageExposure).toHaveBeenCalledTimes(1);
      expect(actions.increaseActiveImageContrast).toHaveBeenCalledTimes(1);
      expect(actions.decreaseActiveImageContrast).toHaveBeenCalledTimes(1);
    });
  });

  describe('Cancel / Escape Shortcut', () => {
    it('should deselect annotation if one is selected', () => {
      updateUi({ selectedAnnotationId: createAnnotationId('ann-1') });
      dispatchKeyDown(DEFAULT_KEYBOARD_SHORTCUTS.cancel);

      expect(actions.setSelectedAnnotation).toHaveBeenCalledWith(null);
      expect(actions.setActiveTool).not.toHaveBeenCalled();
    });

    it('should set active tool to null if no annotation is selected', () => {
      dispatchKeyDown(DEFAULT_KEYBOARD_SHORTCUTS.cancel);

      expect(actions.setActiveTool).toHaveBeenCalledWith(null);
      expect(actions.setSelectedAnnotation).not.toHaveBeenCalled();
    });

    describe('while an element is displayed fullscreen', () => {
      // jsdom implements no part of the Fullscreen API, so the property has to
      // be defined rather than assigned.
      function setFullscreenElement(element: Element | null): void {
        Object.defineProperty(document, 'fullscreenElement', {
          configurable: true,
          get: () => element,
        });
      }

      afterEach(() => {
        delete (document as unknown as Record<string, unknown>).fullscreenElement;
      });

      it('should ignore Escape entirely', () => {
        updateUi({ selectedAnnotationId: createAnnotationId('ann-1') });
        setFullscreenElement(document.createElement('div'));

        dispatchKeyDown(DEFAULT_KEYBOARD_SHORTCUTS.cancel);

        expect(actions.setSelectedAnnotation).not.toHaveBeenCalled();
        expect(actions.setActiveTool).not.toHaveBeenCalled();
      });

      it('should not reach the active tool key handler on Escape', () => {
        const handler = vi.fn().mockReturnValue(true);
        activeToolKeyHandlerRef.handler = handler;
        setFullscreenElement(document.createElement('div'));

        dispatchKeyDown(DEFAULT_KEYBOARD_SHORTCUTS.cancel);

        expect(handler).not.toHaveBeenCalled();
      });

      it('should leave every other shortcut working', () => {
        setFullscreenElement(document.createElement('div'));

        dispatchKeyDown(DEFAULT_KEYBOARD_SHORTCUTS.rectangleTool);

        expect(actions.setActiveTool).toHaveBeenCalledWith('rectangle');
      });

      it('should still handle Escape once fullscreen has been left', () => {
        updateUi({ selectedAnnotationId: createAnnotationId('ann-1') });
        setFullscreenElement(null);

        dispatchKeyDown(DEFAULT_KEYBOARD_SHORTCUTS.cancel);

        expect(actions.setSelectedAnnotation).toHaveBeenCalledWith(null);
      });
    });
  });

  describe('Delete Shortcut', () => {
    it('should delete selected annotation on active cell image', () => {
      updateUi({ selectedAnnotationId: createAnnotationId('ann-1') });

      dispatchKeyDown(DEFAULT_KEYBOARD_SHORTCUTS.delete);

      expect(actions.deleteAnnotation).toHaveBeenCalledWith('ann-1', 'img-1');
      expect(actions.setSelectedAnnotation).toHaveBeenCalledWith(null);
    });

    it('should also work with deleteAlt shortcut', () => {
      update({
        uiState: {
          ...args.uiState,
          selectedAnnotationId: createAnnotationId('ann-2'),
          activeCellIndex: 1,
        },
        activeImageId: createImageId('img-2'),
      });

      dispatchKeyDown(DEFAULT_KEYBOARD_SHORTCUTS.deleteAlt);

      expect(actions.deleteAnnotation).toHaveBeenCalledWith('ann-2', 'img-2');
      expect(actions.setSelectedAnnotation).toHaveBeenCalledWith(null);
    });

    it('should do nothing if no annotation is selected', () => {
      dispatchKeyDown(DEFAULT_KEYBOARD_SHORTCUTS.delete);
      expect(actions.deleteAnnotation).not.toHaveBeenCalled();
    });

    it('should do nothing if active image id is missing', () => {
      // A cell the grid renders but nothing is assigned to.
      update({
        uiState: {
          ...args.uiState,
          selectedAnnotationId: createAnnotationId('ann-1'),
          gridColumns: 2,
          activeCellIndex: 1,
        },
        activeImageId: undefined,
      });

      dispatchKeyDown(DEFAULT_KEYBOARD_SHORTCUTS.delete);

      expect(actions.deleteAnnotation).not.toHaveBeenCalled();
    });
  });

  describe('Grid Shortcuts', () => {
    it('should set active cell 0-8 for keys 1-9', () => {
      updateUi({ gridColumns: 3, gridRows: 3 });

      dispatchKeyDown(DEFAULT_KEYBOARD_SHORTCUTS.gridCell1);
      expect(actions.setActiveCell).toHaveBeenCalledWith(0);

      dispatchKeyDown(DEFAULT_KEYBOARD_SHORTCUTS.gridCell9);
      expect(actions.setActiveCell).toHaveBeenCalledWith(8);
    });

    it('should ignore a cell shortcut past the end of the grid', () => {
      updateUi({ gridColumns: 2, gridRows: 1 });

      dispatchKeyDown(DEFAULT_KEYBOARD_SHORTCUTS.gridCell2);
      expect(actions.setActiveCell).toHaveBeenCalledWith(1);

      vi.mocked(actions.setActiveCell).mockClear();

      dispatchKeyDown(DEFAULT_KEYBOARD_SHORTCUTS.gridCell3);
      expect(actions.setActiveCell).not.toHaveBeenCalled();
    });

    it('should increase grid columns up to maximum', () => {
      updateUi({ gridColumns: 2, gridRows: 2 });
      dispatchKeyDown(DEFAULT_KEYBOARD_SHORTCUTS.increaseGridColumns);
      expect(actions.setGridDimensions).toHaveBeenCalledWith(3, 2);
    });

    it('should handle "=" as "+" for increasing columns', () => {
      updateUi({ gridColumns: 2, gridRows: 2 });
      if (DEFAULT_KEYBOARD_SHORTCUTS.increaseGridColumns === '=') {
        dispatchKeyDown('+');
        expect(actions.setGridDimensions).toHaveBeenCalledWith(3, 2);
      }
    });

    it('should decrease grid columns down to 1', () => {
      updateUi({ gridColumns: 3, gridRows: 2 });
      dispatchKeyDown(DEFAULT_KEYBOARD_SHORTCUTS.decreaseGridColumns);
      expect(actions.setGridDimensions).toHaveBeenCalledWith(2, 2);
    });

    it('should NOT decrease grid columns below 1', () => {
      updateUi({ gridColumns: 1, gridRows: 2 });
      dispatchKeyDown(DEFAULT_KEYBOARD_SHORTCUTS.decreaseGridColumns);
      expect(actions.setGridDimensions).not.toHaveBeenCalled();
    });
  });

  describe('Annotation Context Cycling Shortcuts', () => {
    it('should activate the next context', () => {
      dispatchKeyDown(DEFAULT_KEYBOARD_SHORTCUTS.nextContext);
      expect(actions.setActiveContext).toHaveBeenCalledWith('ctx-b');
    });

    it('should activate the previous context', () => {
      updateContexts({ activeContextId: createAnnotationContextId('ctx-b') });
      dispatchKeyDown(DEFAULT_KEYBOARD_SHORTCUTS.previousContext);
      expect(actions.setActiveContext).toHaveBeenCalledWith('ctx-a');
    });

    it('should wrap around past the last context', () => {
      updateContexts({ activeContextId: createAnnotationContextId('ctx-c') });
      dispatchKeyDown(DEFAULT_KEYBOARD_SHORTCUTS.nextContext);
      expect(actions.setActiveContext).toHaveBeenCalledWith('ctx-a');
    });

    it('should do nothing when there is only one context', () => {
      updateContexts({ contexts: [makeContext('ctx-a')] });
      dispatchKeyDown(DEFAULT_KEYBOARD_SHORTCUTS.nextContext);
      expect(actions.setActiveContext).not.toHaveBeenCalled();
    });

    it('should do nothing when no contexts are configured', () => {
      updateContexts({ contexts: [], activeContextId: null });
      dispatchKeyDown(DEFAULT_KEYBOARD_SHORTCUTS.nextContext);
      expect(actions.setActiveContext).not.toHaveBeenCalled();
    });

    it('should not change the active tool or selection', () => {
      updateUi({ selectedAnnotationId: createAnnotationId('ann-1') });
      dispatchKeyDown(DEFAULT_KEYBOARD_SHORTCUTS.nextContext);

      expect(actions.setActiveContext).toHaveBeenCalledWith('ctx-b');
      expect(actions.setActiveTool).not.toHaveBeenCalled();
      expect(actions.setSelectedAnnotation).not.toHaveBeenCalled();
    });
  });

  /**
   * React-specific: every input reaches the listener through the
   * `useCallback` dependency list. Each test presses a key once before the
   * re-render, so the old listener is known to be live, and once after.
   */
  describe('after a re-render with new arguments', () => {
    it('sees a selection made after mount', () => {
      dispatchKeyDown(DEFAULT_KEYBOARD_SHORTCUTS.cancel);
      expect(actions.setActiveTool).toHaveBeenLastCalledWith(null);

      updateUi({ selectedAnnotationId: createAnnotationId('ann-9') });
      dispatchKeyDown(DEFAULT_KEYBOARD_SHORTCUTS.cancel);

      expect(actions.setSelectedAnnotation).toHaveBeenCalledWith(null);
      expect(actions.setActiveTool).toHaveBeenCalledTimes(1);
    });

    it('sees a constraint status change', () => {
      dispatchKeyDown(DEFAULT_KEYBOARD_SHORTCUTS.rectangleTool);
      expect(actions.setActiveTool).toHaveBeenCalledTimes(1);

      update({
        constraintStatus: allEnabled({
          rectangle: { enabled: false, currentCount: 1, maxCount: 1 },
        }),
      });
      dispatchKeyDown(DEFAULT_KEYBOARD_SHORTCUTS.rectangleTool);

      expect(actions.setActiveTool).toHaveBeenCalledTimes(1);
    });

    it('sees a new contexts list', () => {
      updateContexts({ contexts: [makeContext('ctx-a'), makeContext('ctx-z')] });
      dispatchKeyDown(DEFAULT_KEYBOARD_SHORTCUTS.nextContext);
      expect(actions.setActiveContext).toHaveBeenCalledWith('ctx-z');
    });

    it('sees a new active context', () => {
      dispatchKeyDown(DEFAULT_KEYBOARD_SHORTCUTS.nextContext);
      expect(actions.setActiveContext).toHaveBeenLastCalledWith('ctx-b');

      updateContexts({ activeContextId: createAnnotationContextId('ctx-b') });
      dispatchKeyDown(DEFAULT_KEYBOARD_SHORTCUTS.nextContext);

      expect(actions.setActiveContext).toHaveBeenLastCalledWith('ctx-c');
    });

    it('deletes on the new active image', () => {
      updateUi({ selectedAnnotationId: createAnnotationId('ann-1') });
      update({ activeImageId: createImageId('img-7') });

      dispatchKeyDown(DEFAULT_KEYBOARD_SHORTCUTS.delete);

      expect(actions.deleteAnnotation).toHaveBeenCalledWith('ann-1', 'img-7');
    });

    it('uses a new shortcut map', () => {
      update({ shortcuts: { ...DEFAULT_KEYBOARD_SHORTCUTS, rectangleTool: 'b' } });

      dispatchKeyDown('b');

      expect(actions.setActiveTool).toHaveBeenCalledWith('rectangle');
    });

    it('uses a new skip predicate', () => {
      update({ shouldSkipTargetPredicate: () => true });
      dispatchKeyDown('v');
      expect(actions.setActiveTool).not.toHaveBeenCalled();
    });

    it('keeps exactly one window listener across re-renders', () => {
      // A re-subscription that skipped the cleanup would leave every earlier
      // render's listener attached, each firing the action again.
      for (let i = 0; i < 3; i++) updateUi({ gridColumns: i + 1 });

      dispatchKeyDown(DEFAULT_KEYBOARD_SHORTCUTS.selectTool);

      expect(actions.setActiveTool).toHaveBeenCalledTimes(1);
    });
  });

  it('should remove event listener on unmount', () => {
    mounted.unmount();

    dispatchKeyDown(DEFAULT_KEYBOARD_SHORTCUTS.selectTool);
    expect(actions.setActiveTool).not.toHaveBeenCalled();
  });
});
