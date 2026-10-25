import { describe, it, expect } from 'vitest';
import { createAnnotationContextId } from '@osdlabel/annotation-context';
import { createImageId } from '@osdlabel/viewer-api';
import { snapshotImageBox, snapshotPixelCount, type MaskSnapshot } from '@osdlabel/mask';
import { initFabricModule } from '../../src/fabric-module.js';
import { SegmentationBrushTool } from '../../src/tools/segmentation-brush-tool.js';
import type { BrushStrokeCommit } from '../../src/tools/segmentation-brush-tool.js';
import type { ToolOverlay } from '../../src/types.js';
import type { ToolCallbacks } from '../../src/tools/base-tool.js';
import { createTestKeyboardShortcuts } from './test-helpers.js';
initFabricModule();
function harness(
  viewport: { zoom: number; width: number; height: number } | null,
  radius: number,
  target: { annotationId: never; snapshot: MaskSnapshot } | null = null,
) {
  const commits: BrushStrokeCommit[] = [];
  const capacity: unknown[] = [];
  const canvas = {
    add: () => {},
    remove: () => {},
    getObjects: () => [],
    getActiveObjects: () => [],
    discardActiveObject: () => {},
    bringObjectToFront: () => {},
    requestRenderAll: () => {},
    ...(viewport
      ? {
          viewportTransform: [viewport.zoom, 0, 0, viewport.zoom, 0, 0],
          getWidth: () => viewport.width,
          getHeight: () => viewport.height,
        }
      : {}),
  };
  const callbacks: ToolCallbacks = {
    getActiveContextId: () => createAnnotationContextId('ctx'),
    getToolConstraint: (type) => ({ type }),
    canAddAnnotation: () => true,
    addAnnotation: () => {},
    updateAnnotation: () => {},
    deleteAnnotation: () => {},
    setSelectedAnnotation: () => {},
    getAnnotation: () => undefined,
  };
  const tool = new SegmentationBrushTool({
    getBrushRadius: () => radius,
    getImageSize: () => ({ width: 100_000, height: 80_000 }),
    getTarget: () => target,
    onCommit: (c) => commits.push(c),
    onCapacityExceeded: (e) => capacity.push(e),
  });
  tool.activate(
    { canvas } as unknown as ToolOverlay,
    createImageId('wsi'),
    callbacks,
    createTestKeyboardShortcuts(),
  );
  return { tool, commits, capacity };
}
describe('crit probe', () => {
  it('a small stroke at a moderate zoom-out', () => {
    // 1920x1080 css cell at 8 image px per css px (zoom 0.125): view 15360x8640 image px.
    for (const [label, vp] of [
      ['no viewport (#149 behaviour)', null],
      ['1920x1080 @ 1/8', { zoom: 0.125, width: 1920, height: 1080 }],
      ['1920x1080 @ 1/16', { zoom: 1 / 16, width: 1920, height: 1080 }],
    ] as const) {
      const h = harness(vp, 12);
      h.tool.onPointerDown({ altKey: false } as PointerEvent, { x: 5000, y: 5000 });
      h.tool.onPointerMove({} as PointerEvent, { x: 5300, y: 5300 });
      h.tool.onPointerUp({} as PointerEvent, { x: 5300, y: 5300 });
      const s = h.commits[0]!.snapshot;
      (
        globalThis as unknown as { process: { stdout: { write(t: string): void } } }
      ).process.stdout.write(
        [
          label,
          JSON.stringify({
            d: s.downsample ?? 1,
            cells: `${s.width}x${s.height}`,
            box: snapshotImageBox(s),
            pixelCount: snapshotPixelCount(s),
          }),
        ].join(' ') + '\n',
      );
    }
  });
  it('a 4px-radius stroke on a d=16 mask', () => {
    const h = harness({ zoom: 1 / 64, width: 1600, height: 1250 }, 4);
    h.tool.onPointerDown({ altKey: false } as PointerEvent, { x: 5000, y: 5000 });
    h.tool.onPointerMove({} as PointerEvent, { x: 5400, y: 5000 });
    h.tool.onPointerUp({} as PointerEvent, { x: 5400, y: 5000 });
    const s = h.commits[0]!.snapshot;
    (
      globalThis as unknown as { process: { stdout: { write(t: string): void } } }
    ).process.stdout.write(
      [
        'r=4 on chosen d',
        JSON.stringify({
          d: s.downsample ?? 1,
          box: snapshotImageBox(s),
          pixelCount: snapshotPixelCount(s),
          brushArea: Math.round(400 * 8 + Math.PI * 16),
        }),
      ].join(' ') + '\n',
    );
    expect(h.capacity.length).toBe(0);
  });
});
