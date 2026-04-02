import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'solid-js';
import { useKeyboard, DEFAULT_KEYBOARD_SHORTCUTS } from '../../../src/hooks/useKeyboard.js';

// Mock annotator actions
const mockActions = {
  setActiveTool: vi.fn(),
  setSelectedAnnotation: vi.fn(),
  deleteAnnotation: vi.fn(),
  setActiveCell: vi.fn(),
  setGridDimensions: vi.fn(),
  rotateActiveImageCW: vi.fn(),
  rotateActiveImageCCW: vi.fn(),
  flipActiveImageH: vi.fn(),
  flipActiveImageV: vi.fn(),
  resetActiveImageView: vi.fn(),
};

// Mock UI state
const mockUiState = {
  selectedAnnotationId: null as string | null,
  gridAssignments: [
    'img-1',
    'img-2',
    'img-3',
    'img-4',
    'img-5',
    'img-6',
    'img-7',
    'img-8',
    'img-9',
  ],
  activeCellIndex: 0,
  gridColumns: 1,
  gridRows: 1,
};

// Mock context state
const mockState = {
  uiState: mockUiState,
  actions: mockActions,
  activeImageId: () => mockUiState.gridAssignments[mockUiState.activeCellIndex],
};

// Mock constraints
const mockConstraints = {
  isToolEnabled: vi.fn().mockReturnValue(true),
};

vi.mock('../../../src/state/annotator-context.js', () => ({
  useAnnotator: () => mockState,
}));

vi.mock('../../../src/hooks/useConstraints.js', () => ({
  useConstraints: () => mockConstraints,
}));

// Helper to simulate a keyboard event
function dispatchKeyDown(key: string, target?: Partial<HTMLElement>, shiftKey = false) {
  const event = new KeyboardEvent('keydown', { key, shiftKey });
  if (target) {
    Object.defineProperty(event, 'target', { value: target, enumerable: true });
  } else {
    Object.defineProperty(event, 'target', {
      value: document.createElement('div'),
      enumerable: true,
    });
  }
  window.dispatchEvent(event);
}

describe('useKeyboard', () => {
  let activeToolKeyHandlerRef: { handler: ((event: KeyboardEvent) => boolean) | null };
  let disposeRoot: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    mockUiState.selectedAnnotationId = null;
    mockUiState.activeCellIndex = 0;
    mockUiState.gridColumns = 1;
    mockUiState.gridRows = 1;
    mockConstraints.isToolEnabled.mockReturnValue(true);

    activeToolKeyHandlerRef = { handler: null };

    // Setup hook within a reactive root
    createRoot((dispose) => {
      disposeRoot = dispose;
      useKeyboard(DEFAULT_KEYBOARD_SHORTCUTS, activeToolKeyHandlerRef);
    });
  });

  afterEach(() => {
    if (disposeRoot) {
      disposeRoot();
    }
  });

  it('should ignore events when target is INPUT, TEXTAREA, or contentEditable', () => {
    dispatchKeyDown('v', { tagName: 'INPUT' });
    dispatchKeyDown('v', { tagName: 'TEXTAREA' });
    dispatchKeyDown('v', { isContentEditable: true } as any);

    expect(mockActions.setActiveTool).not.toHaveBeenCalled();
  });

  it('should ignore events when shouldSkipTargetPredicate returns true', () => {
    // Re-initialize with a predicate
    disposeRoot();

    const predicate = vi.fn((target: HTMLElement) => target.className === 'ignore-me');

    createRoot((dispose) => {
      disposeRoot = dispose;
      useKeyboard(DEFAULT_KEYBOARD_SHORTCUTS, activeToolKeyHandlerRef, predicate);
    });

    dispatchKeyDown('v', { className: 'ignore-me', tagName: 'DIV' });
    expect(predicate).toHaveBeenCalled();
    expect(mockActions.setActiveTool).not.toHaveBeenCalled();

    dispatchKeyDown('v', { className: 'process-me', tagName: 'DIV' });
    expect(mockActions.setActiveTool).toHaveBeenCalledWith('select');
  });

  it('should pass event to activeToolKeyHandlerRef and stop if consumed', () => {
    const handler = vi.fn().mockReturnValue(true); // consumed
    activeToolKeyHandlerRef.handler = handler;

    dispatchKeyDown('v');

    expect(handler).toHaveBeenCalled();
    expect(mockActions.setActiveTool).not.toHaveBeenCalled();
  });

  it('should process event if activeToolKeyHandlerRef returns false', () => {
    const handler = vi.fn().mockReturnValue(false); // not consumed
    activeToolKeyHandlerRef.handler = handler;

    dispatchKeyDown('v');

    expect(handler).toHaveBeenCalled();
    expect(mockActions.setActiveTool).toHaveBeenCalledWith('select');
  });

  describe('Tool Selection Shortcuts', () => {
    it('should set tool on matching key press if enabled', () => {
      dispatchKeyDown(DEFAULT_KEYBOARD_SHORTCUTS.selectTool);
      expect(mockActions.setActiveTool).toHaveBeenCalledWith('select');

      dispatchKeyDown(DEFAULT_KEYBOARD_SHORTCUTS.rectangleTool);
      expect(mockActions.setActiveTool).toHaveBeenCalledWith('rectangle');

      dispatchKeyDown(DEFAULT_KEYBOARD_SHORTCUTS.circleTool);
      expect(mockActions.setActiveTool).toHaveBeenCalledWith('circle');

      dispatchKeyDown(DEFAULT_KEYBOARD_SHORTCUTS.lineTool);
      expect(mockActions.setActiveTool).toHaveBeenCalledWith('line');

      dispatchKeyDown(DEFAULT_KEYBOARD_SHORTCUTS.pointTool);
      expect(mockActions.setActiveTool).toHaveBeenCalledWith('point');

      dispatchKeyDown(DEFAULT_KEYBOARD_SHORTCUTS.polylineTool);
      expect(mockActions.setActiveTool).toHaveBeenCalledWith('polyline');
    });

    it('should handle uppercase tool shortcuts', () => {
      dispatchKeyDown('V'); // Uppercase of 'v'
      expect(mockActions.setActiveTool).toHaveBeenCalledWith('select');
    });

    it('should NOT set tool if isToolEnabled returns false', () => {
      mockConstraints.isToolEnabled.mockImplementation((tool) => tool !== 'rectangle');

      dispatchKeyDown(DEFAULT_KEYBOARD_SHORTCUTS.rectangleTool);
      expect(mockActions.setActiveTool).not.toHaveBeenCalledWith('rectangle');

      // But should allow others
      dispatchKeyDown(DEFAULT_KEYBOARD_SHORTCUTS.circleTool);
      expect(mockActions.setActiveTool).toHaveBeenCalledWith('circle');
    });
  });

  describe('View Transform Shortcuts', () => {
    it('should rotate CW on Shift+R', () => {
      dispatchKeyDown('R', undefined, true);
      expect(mockActions.rotateActiveImageCW).toHaveBeenCalled();
    });

    it('should rotate CCW on Shift+L', () => {
      dispatchKeyDown('L', undefined, true);
      expect(mockActions.rotateActiveImageCCW).toHaveBeenCalled();
    });

    it('should flip horizontal on Shift+H', () => {
      dispatchKeyDown('H', undefined, true);
      expect(mockActions.flipActiveImageH).toHaveBeenCalled();
    });

    it('should flip vertical on Shift+V', () => {
      dispatchKeyDown('V', undefined, true);
      expect(mockActions.flipActiveImageV).toHaveBeenCalled();
    });

    it('should reset view on Reset View key', () => {
      dispatchKeyDown(DEFAULT_KEYBOARD_SHORTCUTS.resetView);
      expect(mockActions.resetActiveImageView).toHaveBeenCalled();
    });

    it('should reset view on Shift+0', () => {
      dispatchKeyDown(')', undefined, true);
      expect(mockActions.resetActiveImageView).toHaveBeenCalled();
      dispatchKeyDown('0', undefined, true);
      expect(mockActions.resetActiveImageView).toHaveBeenCalledTimes(2);
    });

    it('plain r should still trigger rectangle tool, not rotation', () => {
      dispatchKeyDown('r', undefined, false);
      expect(mockActions.rotateActiveImageCW).not.toHaveBeenCalled();
      expect(mockActions.setActiveTool).toHaveBeenCalledWith('rectangle');
    });

    it('plain l should still trigger line tool, not rotation', () => {
      dispatchKeyDown('l', undefined, false);
      expect(mockActions.rotateActiveImageCCW).not.toHaveBeenCalled();
      expect(mockActions.setActiveTool).toHaveBeenCalledWith('line');
    });
  });

  describe('Cancel / Escape Shortcut', () => {
    it('should deselect annotation if one is selected', () => {
      mockUiState.selectedAnnotationId = 'ann-1';
      dispatchKeyDown(DEFAULT_KEYBOARD_SHORTCUTS.cancel);

      expect(mockActions.setSelectedAnnotation).toHaveBeenCalledWith(null);
      expect(mockActions.setActiveTool).not.toHaveBeenCalled();
    });

    it('should set active tool to null if no annotation is selected', () => {
      mockUiState.selectedAnnotationId = null;
      dispatchKeyDown(DEFAULT_KEYBOARD_SHORTCUTS.cancel);

      expect(mockActions.setActiveTool).toHaveBeenCalledWith(null);
      expect(mockActions.setSelectedAnnotation).not.toHaveBeenCalled();
    });
  });

  describe('Delete Shortcut', () => {
    it('should delete selected annotation on active cell image', () => {
      mockUiState.selectedAnnotationId = 'ann-1';
      mockUiState.activeCellIndex = 0; // points to 'img-1'

      dispatchKeyDown(DEFAULT_KEYBOARD_SHORTCUTS.delete);

      expect(mockActions.deleteAnnotation).toHaveBeenCalledWith('ann-1', 'img-1');
      expect(mockActions.setSelectedAnnotation).toHaveBeenCalledWith(null);
    });

    it('should also work with deleteAlt shortcut', () => {
      mockUiState.selectedAnnotationId = 'ann-2';
      mockUiState.activeCellIndex = 1; // points to 'img-2'

      dispatchKeyDown(DEFAULT_KEYBOARD_SHORTCUTS.deleteAlt);

      expect(mockActions.deleteAnnotation).toHaveBeenCalledWith('ann-2', 'img-2');
      expect(mockActions.setSelectedAnnotation).toHaveBeenCalledWith(null);
    });

    it('should do nothing if no annotation is selected', () => {
      mockUiState.selectedAnnotationId = null;
      dispatchKeyDown(DEFAULT_KEYBOARD_SHORTCUTS.delete);

      expect(mockActions.deleteAnnotation).not.toHaveBeenCalled();
    });

    it('should do nothing if active image id is missing', () => {
      mockUiState.selectedAnnotationId = 'ann-1';
      mockUiState.activeCellIndex = 10; // Out of bounds, undefined image
      dispatchKeyDown(DEFAULT_KEYBOARD_SHORTCUTS.delete);

      expect(mockActions.deleteAnnotation).not.toHaveBeenCalled();
    });
  });

  describe('Grid Shortcuts', () => {
    it('should set active cell 0-8 for keys 1-9', () => {
      dispatchKeyDown(DEFAULT_KEYBOARD_SHORTCUTS.gridCell1);
      expect(mockActions.setActiveCell).toHaveBeenCalledWith(0);

      dispatchKeyDown(DEFAULT_KEYBOARD_SHORTCUTS.gridCell9);
      expect(mockActions.setActiveCell).toHaveBeenCalledWith(8);
    });

    it('should increase grid columns up to maximum', () => {
      mockUiState.gridColumns = 2;
      mockUiState.gridRows = 2;

      dispatchKeyDown(DEFAULT_KEYBOARD_SHORTCUTS.increaseGridColumns);

      expect(mockActions.setGridDimensions).toHaveBeenCalledWith(3, 2);
    });

    it('should handle "=" as "+" for increasing columns', () => {
      mockUiState.gridColumns = 2;
      mockUiState.gridRows = 2;

      // If DEFAULT_KEYBOARD_SHORTCUTS.increaseGridColumns is '=', pressing '+' also works
      if (DEFAULT_KEYBOARD_SHORTCUTS.increaseGridColumns === '=') {
        dispatchKeyDown('+');
        expect(mockActions.setGridDimensions).toHaveBeenCalledWith(3, 2);
      }
    });

    it('should decrease grid columns down to 1', () => {
      mockUiState.gridColumns = 3;
      mockUiState.gridRows = 2;

      dispatchKeyDown(DEFAULT_KEYBOARD_SHORTCUTS.decreaseGridColumns);

      expect(mockActions.setGridDimensions).toHaveBeenCalledWith(2, 2);
    });

    it('should NOT decrease grid columns below 1', () => {
      mockUiState.gridColumns = 1;
      mockUiState.gridRows = 2;

      dispatchKeyDown(DEFAULT_KEYBOARD_SHORTCUTS.decreaseGridColumns);

      expect(mockActions.setGridDimensions).not.toHaveBeenCalled();
    });
  });

  it('should remove event listener on cleanup', () => {
    disposeRoot();
    vi.clearAllMocks();

    // After cleanup, shortcuts should not trigger actions
    dispatchKeyDown(DEFAULT_KEYBOARD_SHORTCUTS.selectTool);
    expect(mockActions.setActiveTool).not.toHaveBeenCalled();
  });
});
