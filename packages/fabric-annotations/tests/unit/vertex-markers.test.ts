import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Circle } from 'fabric';
import { DEFAULT_ANNOTATION_STYLE, type Point } from '@osdlabel/annotation';
import {
  VertexMarkerLayer,
  DEFAULT_VERTEX_MARKER_RADIUS_PX,
  DEFAULT_FIRST_VERTEX_MARKER_RADIUS_PX,
} from '../../src/vertex-markers.js';
import type { ToolOverlay } from '../../src/types.js';

describe('VertexMarkerLayer', () => {
  let canvas: {
    add: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
    getZoom: ReturnType<typeof vi.fn>;
  };
  let overlay: ToolOverlay;

  const added = (): Circle[] => canvas.add.mock.calls.map((call) => call[0] as Circle);
  const removed = (): Circle[] => canvas.remove.mock.calls.map((call) => call[0] as Circle);
  const vertices = (...points: readonly [number, number][]): Point[] =>
    points.map(([x, y]) => ({ x, y }));

  beforeEach(() => {
    canvas = { add: vi.fn(), remove: vi.fn(), getZoom: vi.fn().mockReturnValue(1) };
    overlay = { canvas, imageToScreen: (p: Point) => p } as unknown as ToolOverlay;
  });

  it('adds one marker per vertex, positioned in image space', () => {
    const layer = new VertexMarkerLayer();

    layer.sync(overlay, vertices([10, 10], [50, 20]), DEFAULT_ANNOTATION_STYLE);

    const markers = added();
    expect(markers).toHaveLength(2);
    expect(markers[1]!.left).toBe(50);
    expect(markers[1]!.top).toBe(20);
  });

  it('reuses markers across syncs instead of re-adding them', () => {
    const layer = new VertexMarkerLayer();
    const points = vertices([10, 10], [50, 20]);

    layer.sync(overlay, points, DEFAULT_ANNOTATION_STYLE);
    layer.sync(overlay, [...points, { x: 90, y: 30 }], DEFAULT_ANNOTATION_STYLE);

    expect(canvas.add).toHaveBeenCalledTimes(3);
    expect(added()[0]!.left).toBe(10);
  });

  it('removes markers for vertices that disappeared', () => {
    const layer = new VertexMarkerLayer();
    const points = vertices([10, 10], [50, 20], [90, 30]);

    layer.sync(overlay, points, DEFAULT_ANNOTATION_STYLE);
    const third = added()[2]!;
    layer.sync(overlay, points.slice(0, 2), DEFAULT_ANNOTATION_STYLE);

    expect(removed()).toEqual([third]);
  });

  it('derives marker colour from the resolved style', () => {
    const layer = new VertexMarkerLayer();

    layer.sync(overlay, vertices([10, 10], [50, 20]), {
      ...DEFAULT_ANNOTATION_STYLE,
      strokeColor: '#00e5ff',
    });

    expect(added()[1]!.fill).toBe('#00e5ff');
    expect(added()[0]!.stroke).toBe('#00e5ff');
  });

  it('lets callers override radius and colour', () => {
    const layer = new VertexMarkerLayer({
      radius: 2,
      firstRadius: 9,
      color: '#111111',
      firstColor: '#222222',
    });

    layer.sync(overlay, vertices([10, 10], [50, 20]), DEFAULT_ANNOTATION_STYLE, true);

    const [first, second] = added();
    expect(first!.radius).toBe(9);
    expect(first!.fill).toBe('#222222');
    expect(second!.radius).toBe(2);
    expect(second!.fill).toBe('#111111');
  });

  it('draws the first vertex larger, hollow until it becomes the close target', () => {
    const layer = new VertexMarkerLayer();
    const points = vertices([10, 10], [50, 20]);

    layer.sync(overlay, points, DEFAULT_ANNOTATION_STYLE);
    const [first, second] = added();
    expect(first!.radius).toBe(DEFAULT_FIRST_VERTEX_MARKER_RADIUS_PX);
    expect(second!.radius).toBe(DEFAULT_VERTEX_MARKER_RADIUS_PX);
    expect(first!.fill).toBe('transparent');
    expect(first!.strokeWidth).toBeGreaterThan(0);

    layer.sync(overlay, points, DEFAULT_ANNOTATION_STYLE, true);
    expect(first!.fill).toBe(DEFAULT_ANNOTATION_STYLE.strokeColor);
  });

  it('scales radii by zoom so markers keep a constant screen size', () => {
    canvas.getZoom.mockReturnValue(4);
    const layer = new VertexMarkerLayer();

    layer.sync(overlay, vertices([10, 10]), DEFAULT_ANNOTATION_STYLE);

    expect(added()[0]!.radius).toBeCloseTo(DEFAULT_FIRST_VERTEX_MARKER_RADIUS_PX / 4);
  });

  it('flags markers as inert chrome, never annotation objects', () => {
    const layer = new VertexMarkerLayer();

    layer.sync(overlay, vertices([10, 10]), DEFAULT_ANNOTATION_STYLE);

    const marker = added()[0]!;
    expect(marker.id).toBeUndefined();
    expect(marker._readOnly).toBe(true);
    expect(marker.selectable).toBe(false);
    expect(marker.evented).toBe(false);
    expect(marker.hasControls).toBe(false);
  });

  it('clear() removes every marker and resets the layer', () => {
    const layer = new VertexMarkerLayer();
    layer.sync(overlay, vertices([10, 10], [50, 20]), DEFAULT_ANNOTATION_STYLE);
    const markers = added();

    layer.clear();
    expect(removed()).toEqual(markers);

    canvas.add.mockClear();
    layer.sync(overlay, vertices([10, 10]), DEFAULT_ANNOTATION_STYLE);
    expect(canvas.add).toHaveBeenCalledTimes(1);
  });

  it('draws nothing when disabled', () => {
    const layer = new VertexMarkerLayer({ enabled: false });

    layer.sync(overlay, vertices([10, 10], [50, 20]), DEFAULT_ANNOTATION_STYLE);

    expect(canvas.add).not.toHaveBeenCalled();
  });
});
