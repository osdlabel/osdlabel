import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SelectTool } from '../../../src/tools/select-tool.js';
import type { ToolOverlay } from '../../../src/types.js';
import type { ToolCallbacks } from '../../../src/tools/base-tool.js';
import { createAnnotationId } from '@osdlabel/annotation';
import { createImageId } from '@osdlabel/viewer-api';
import type { KeyboardShortcutMap } from '@osdlabel/viewer-api';
import { createAnnotationContextId } from '@osdlabel/annotation-context';
import { FabricObject } from 'fabric';
import { createTestKeyboardShortcuts } from '../test-helpers.js';

describe('SelectTool', () => {
  let tool: SelectTool;
  let mockOverlay: ToolOverlay;
  let mockCanvas: {
    on: ReturnType<typeof vi.fn>;
    off: ReturnType<typeof vi.fn>;
    discardActiveObject: ReturnType<typeof vi.fn>;
    requestRenderAll: ReturnType<typeof vi.fn>;
    getActiveObject: ReturnType<typeof vi.fn>;
    getActiveObjects: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
  };
  let mockCallbacks: ToolCallbacks;
  // Fabric supports multiple handlers per event, so capture arrays and fire all
  // (the SelectTool and its PolyVertexEditor both subscribe to some events).
  let capturedHandlers: Record<string, Array<(...args: unknown[]) => void>>;
  const fire = (eventName: string, arg: unknown) => {
    for (const handler of capturedHandlers[eventName] ?? []) handler(arg);
  };
  const imageId = createImageId('test-image-select');
  const contextId = createAnnotationContextId('test-context');
  const mockShortcuts: KeyboardShortcutMap = createTestKeyboardShortcuts();

  beforeEach(() => {
    vi.clearAllMocks();
    capturedHandlers = {};

    mockCanvas = {
      on: vi.fn().mockImplementation((eventName: string, handler: (...args: unknown[]) => void) => {
        (capturedHandlers[eventName] ??= []).push(handler);
      }),
      off: vi.fn(),
      discardActiveObject: vi.fn(),
      requestRenderAll: vi.fn(),
      getActiveObject: vi.fn(),
      getActiveObjects: vi.fn().mockReturnValue([]),
      remove: vi.fn(),
    };

    mockOverlay = {
      canvas: mockCanvas,
    } as unknown as ToolOverlay;

    mockCallbacks = {
      getActiveContextId: () => contextId,
      getToolConstraint: (type) => ({ type }),
      canAddAnnotation: () => true,
      addAnnotation: vi.fn(),
      updateAnnotation: vi.fn(),
      deleteAnnotation: vi.fn(),
      setSelectedAnnotation: vi.fn(),
      getAnnotation: vi.fn().mockReturnValue(undefined),
    };

    tool = new SelectTool();
  });

  it('should attach event listeners on activate', () => {
    tool.activate(mockOverlay, imageId, mockCallbacks, mockShortcuts);
    expect(mockCanvas.on).toHaveBeenCalledWith('selection:created', expect.any(Function));
    expect(mockCanvas.on).toHaveBeenCalledWith('selection:cleared', expect.any(Function));
  });

  it('should detach event listeners on deactivate', () => {
    tool.activate(mockOverlay, imageId, mockCallbacks, mockShortcuts);
    tool.deactivate();
    expect(mockCanvas.off).toHaveBeenCalledWith('selection:created', expect.any(Function));
    expect(mockCanvas.off).toHaveBeenCalledWith('selection:cleared', expect.any(Function));
    expect(mockCanvas.discardActiveObject).toHaveBeenCalled();
  });

  it('should trigger setSelectedAnnotation on selection:created with single object', () => {
    tool.activate(mockOverlay, imageId, mockCallbacks, mockShortcuts);

    const annId = createAnnotationId('ann-1');
    const mockObj = { id: annId } as unknown as FabricObject;

    fire('selection:created', { selected: [mockObj] });

    expect(mockCallbacks.setSelectedAnnotation).toHaveBeenCalledWith(annId);
  });

  it('should trigger setSelectedAnnotation(null) on selection:created with multiple objects', () => {
    tool.activate(mockOverlay, imageId, mockCallbacks, mockShortcuts);

    const mockObj1 = { id: createAnnotationId('ann-1') } as unknown as FabricObject;
    const mockObj2 = { id: createAnnotationId('ann-2') } as unknown as FabricObject;

    fire('selection:created', { selected: [mockObj1, mockObj2] });

    expect(mockCallbacks.setSelectedAnnotation).toHaveBeenCalledWith(null);
  });

  it('should trigger setSelectedAnnotation(null) on selection:cleared', () => {
    tool.activate(mockOverlay, imageId, mockCallbacks, mockShortcuts);

    fire('selection:cleared', { deselected: [] });

    expect(mockCallbacks.setSelectedAnnotation).toHaveBeenCalledWith(null);
  });

  it('should trigger deleteAnnotation on Delete key', () => {
    tool.activate(mockOverlay, imageId, mockCallbacks, mockShortcuts);

    const annId = createAnnotationId('ann-1');
    const mockObj = { id: annId, type: 'rect' } as unknown as FabricObject;

    mockCanvas.getActiveObjects.mockReturnValue([mockObj]);

    tool.onKeyDown({ key: 'Delete' } as KeyboardEvent);

    expect(mockCallbacks.deleteAnnotation).toHaveBeenCalledWith(annId, imageId);
    expect(mockCanvas.discardActiveObject).toHaveBeenCalled();
  });

  it('should trigger deleteAnnotation on Backspace key', () => {
    tool.activate(mockOverlay, imageId, mockCallbacks, mockShortcuts);

    const annId = createAnnotationId('ann-2');
    const mockObj = { id: annId, type: 'circle' } as unknown as FabricObject;

    mockCanvas.getActiveObjects.mockReturnValue([mockObj]);

    tool.onKeyDown({ key: 'Backspace' } as KeyboardEvent);

    expect(mockCallbacks.deleteAnnotation).toHaveBeenCalledWith(annId, imageId);
  });
});
