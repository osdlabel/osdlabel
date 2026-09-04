import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RectangleTool } from '../../../src/tools/rectangle-tool.js';
import type { ToolOverlay } from '../../../src/types.js';
import type { ToolCallbacks, AddAnnotationParams } from '../../../src/tools/base-tool.js';
import { createImageId } from '@osdlabel/viewer-api';
import type { KeyboardShortcutMap } from '@osdlabel/viewer-api';
import { createAnnotationContextId } from '@osdlabel/annotation-context';
import { Rect } from 'fabric';
import { createTestKeyboardShortcuts } from '../test-helpers.js';

describe('RectangleTool', () => {
  let tool: RectangleTool;
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

  it('should create a preview rectangle on pointer down', () => {
    tool = new RectangleTool();
    tool.activate(mockOverlay, imageId, mockCallbacks, mockShortcuts);

    const event = { type: 'pointerdown' } as PointerEvent;
    tool.onPointerDown(event, { x: 10, y: 10 });

    expect(mockCanvas.add).toHaveBeenCalled();
    const addedObj = mockCanvas.add.mock.calls[0]![0];
    expect(addedObj).toBeInstanceOf(Rect);
    expect(addedObj.left).toBe(10);
    expect(addedObj.top).toBe(10);
    expect(addedObj.width).toBe(0);
  });

  it('should update preview rectangle on pointer move', () => {
    tool = new RectangleTool();
    tool.activate(mockOverlay, imageId, mockCallbacks, mockShortcuts);

    const event = { type: 'pointerdown' } as PointerEvent;
    tool.onPointerDown(event, { x: 10, y: 10 });

    const preview = mockCanvas.add.mock.calls[0]![0];

    const moveEvent = { type: 'pointermove' } as PointerEvent;
    tool.onPointerMove(moveEvent, { x: 30, y: 40 });

    expect(preview.width).toBe(20);
    expect(preview.height).toBe(30);
    expect(mockCanvas.requestRenderAll).toHaveBeenCalled();
  });

  it('should commit annotation on pointer up with fabricObject', () => {
    tool = new RectangleTool();
    tool.activate(mockOverlay, imageId, mockCallbacks, mockShortcuts);

    const event = { type: 'pointerdown' } as PointerEvent;
    tool.onPointerDown(event, { x: 10, y: 10 });

    const moveEvent = { type: 'pointermove' } as PointerEvent;
    tool.onPointerMove(moveEvent, { x: 30, y: 40 });

    const upEvent = { type: 'pointerup' } as PointerEvent;
    tool.onPointerUp(upEvent, { x: 30, y: 40 });

    expect(addedParams).toHaveLength(1);
    const params = addedParams[0]!;

    expect(params.type).toBe('rectangle');
    expect(params.imageId).toBe(imageId);
    expect(params.contextId).toBe(contextId);
    expect(params.fabricObject).toBeInstanceOf(Rect);
    expect(params.fabricObject.width).toBe(20);
    expect(params.fabricObject.height).toBe(30);

    // Object stays on canvas (no remove call)
    expect(mockCanvas.remove).not.toHaveBeenCalled();
  });

  it('should handle negative drag direction', () => {
    tool = new RectangleTool();
    tool.activate(mockOverlay, imageId, mockCallbacks, mockShortcuts);

    const event = { type: 'pointerdown' } as PointerEvent;
    tool.onPointerDown(event, { x: 30, y: 40 });

    const preview = mockCanvas.add.mock.calls[0]![0];

    const moveEvent = { type: 'pointermove' } as PointerEvent;
    tool.onPointerMove(moveEvent, { x: 10, y: 10 });

    expect(preview.width).toBe(20);
    expect(preview.height).toBe(30);
    expect(preview.left).toBe(10);
    expect(preview.top).toBe(10);
  });

  it('should set id on preview object', () => {
    tool = new RectangleTool();
    tool.activate(mockOverlay, imageId, mockCallbacks, mockShortcuts);

    tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 10, y: 10 });

    const preview = mockCanvas.add.mock.calls[0]![0];
    expect(preview.id).toBeDefined();
    expect(typeof preview.id).toBe('string');
  });

  it('should not create annotation when no active context', () => {
    const noContextCallbacks: ToolCallbacks = {
      ...mockCallbacks,
      getActiveContextId: () => null,
    };

    tool = new RectangleTool();
    tool.activate(mockOverlay, imageId, noContextCallbacks, mockShortcuts);

    tool.onPointerDown({ type: 'pointerdown' } as PointerEvent, { x: 10, y: 10 });
    tool.onPointerMove({ type: 'pointermove' } as PointerEvent, { x: 30, y: 40 });
    tool.onPointerUp({ type: 'pointerup' } as PointerEvent, { x: 30, y: 40 });

    expect(addedParams).toHaveLength(0);
    // No preview should have been added either
    expect(mockCanvas.add).not.toHaveBeenCalled();
  });
});
