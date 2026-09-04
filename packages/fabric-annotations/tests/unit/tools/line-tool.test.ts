import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LineTool } from '../../../src/tools/line-tool.js';
import type { ToolOverlay } from '../../../src/types.js';
import type { ToolCallbacks, AddAnnotationParams } from '../../../src/tools/base-tool.js';
import { createImageId } from '@osdlabel/viewer-api';
import type { KeyboardShortcutMap } from '@osdlabel/viewer-api';
import { createAnnotationContextId } from '@osdlabel/annotation-context';
import { Line } from 'fabric';
import { createTestKeyboardShortcuts } from '../test-helpers.js';

describe('LineTool', () => {
  let tool: LineTool;
  let mockOverlay: ToolOverlay;
  let mockCanvas: {
    add: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
    requestRenderAll: ReturnType<typeof vi.fn>;
    getZoom: ReturnType<typeof vi.fn>;
  };
  let mockCallbacks: ToolCallbacks;
  let addedParams: AddAnnotationParams[];
  const imageId = createImageId('test-image');
  const contextId = createAnnotationContextId('test-context');
  const mockShortcuts: KeyboardShortcutMap = createTestKeyboardShortcuts();

  beforeEach(() => {
    vi.clearAllMocks();
    addedParams = [];

    mockCanvas = {
      add: vi.fn(),
      remove: vi.fn(),
      requestRenderAll: vi.fn(),
      getZoom: vi.fn().mockReturnValue(1),
    };

    mockOverlay = {
      canvas: mockCanvas,
    } as unknown as ToolOverlay;

    mockCallbacks = {
      getActiveContextId: () => contextId,
      getToolConstraint: (type) => ({ type }),
      canAddAnnotation: () => true,
      addAnnotation: (params) => {
        addedParams.push(params);
      },
      updateAnnotation: vi.fn(),
      deleteAnnotation: vi.fn(),
      setSelectedAnnotation: vi.fn(),
      getAnnotation: vi.fn().mockReturnValue(undefined),
    };
  });

  it('should create a preview line on pointer down', () => {
    tool = new LineTool();
    tool.activate(mockOverlay, imageId, mockCallbacks, mockShortcuts);

    const event = { type: 'pointerdown' } as PointerEvent;
    tool.onPointerDown(event, { x: 10, y: 10 });

    expect(mockCanvas.add).toHaveBeenCalled();
    const addedObj = mockCanvas.add.mock.calls[0]![0];
    expect(addedObj).toBeInstanceOf(Line);
    expect(addedObj.x1).toBe(10);
    expect(addedObj.y1).toBe(10);
    expect(addedObj.x2).toBe(10);
    expect(addedObj.y2).toBe(10);
  });

  it('should update preview line on pointer move', () => {
    tool = new LineTool();
    tool.activate(mockOverlay, imageId, mockCallbacks, mockShortcuts);

    tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 10, y: 10 });

    const preview = mockCanvas.add.mock.calls[0]![0];

    tool.onPointerMove({ type: 'pointermove' } as PointerEvent, { x: 50, y: 50 });

    expect(preview.x2).toBe(50);
    expect(preview.y2).toBe(50);
    expect(mockCanvas.requestRenderAll).toHaveBeenCalled();
  });

  it('should commit annotation on pointer up with fabricObject', () => {
    tool = new LineTool();
    tool.activate(mockOverlay, imageId, mockCallbacks, mockShortcuts);

    tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 10, y: 10 });
    tool.onPointerMove({ type: 'pointermove' } as PointerEvent, { x: 50, y: 50 });
    tool.onPointerUp({ type: 'pointerup' } as PointerEvent, { x: 50, y: 50 });

    expect(addedParams).toHaveLength(1);
    const params = addedParams[0]!;

    expect(params.type).toBe('line');
    expect(params.imageId).toBe(imageId);
    expect(params.contextId).toBe(contextId);
    expect(params.fabricObject).toBeInstanceOf(Line);

    // Object stays on canvas
    expect(mockCanvas.remove).not.toHaveBeenCalled();
  });

  it('should not create annotation when no active context', () => {
    const noContextCallbacks: ToolCallbacks = {
      ...mockCallbacks,
      getActiveContextId: () => null,
    };

    tool = new LineTool();
    tool.activate(mockOverlay, imageId, noContextCallbacks, mockShortcuts);

    tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 10, y: 10 });
    tool.onPointerMove({ type: 'pointermove' } as PointerEvent, { x: 50, y: 50 });
    tool.onPointerUp({ type: 'pointerup' } as PointerEvent, { x: 50, y: 50 });

    expect(addedParams).toHaveLength(0);
    expect(mockCanvas.add).not.toHaveBeenCalled();
  });
});
