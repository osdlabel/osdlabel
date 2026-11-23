// @vitest-environment jsdom
// (`osdlabel` loads OpenSeadragon, which needs a DOM.)
import { describe, expect, it } from 'vitest';
import contractJson from '../../contract/snapshot.json';
import type { AnnotationContext } from '@osdlabel/annotation-context';
import type { AnnotationState } from '@osdlabel/viewer-api';
import {
  computeConstraintStatus,
  createAnnotationContextId,
  createAnnotationId,
  createImageId,
  createInitialAnnotationState,
  createInitialContextState,
  createInitialUIState,
  type OsdAnnotation,
  type OsdFields,
} from 'osdlabel';
import { buildSnapshot, type SnapshotInput } from '../../src/snapshot.js';

/** The same fixture the crate's tests decode. */
const contract: Record<string, unknown> = contractJson;

const landscape = createImageId('landscape');
const portrait = createImageId('portrait');
const fracture = createAnnotationContextId('ctx-1');
const general = createAnnotationContextId('ctx-3');

const CONTEXTS: AnnotationContext[] = [
  { id: fracture, label: 'Fracture', tools: [{ type: 'rectangle', maxCount: 2 }] },
  { id: general, label: 'General', tools: [{ type: 'line' }] },
];

function ann(id: string, contextId: typeof fracture, createdAt: string): OsdAnnotation {
  return {
    id: createAnnotationId(id),
    imageId: landscape,
    contextId,
    toolType: 'rectangle',
    geometry: { type: 'rectangle', origin: { x: 0, y: 0 }, width: 1, height: 1, rotation: 0 },
    rawAnnotationData: { format: 'fabric', fabricVersion: '7.4.0', data: {} },
    createdAt,
    updatedAt: createdAt,
  };
}

function input(): SnapshotInput {
  const ui = createInitialUIState();
  ui.gridAssignments[0] = landscape;
  const contexts = createInitialContextState();
  contexts.contexts = CONTEXTS;
  contexts.activeContextId = fracture;
  const annotations: AnnotationState<OsdFields> = createInitialAnnotationState();
  // Inserted newest first, to check the snapshot sorts by creation time.
  const later = ann('b', general, '2026-01-02T00:00:00Z');
  const earlier = ann('a', fracture, '2026-01-01T00:00:00Z');
  annotations.byImage[landscape] = { [later.id]: later, [earlier.id]: earlier };
  return {
    ui,
    contexts,
    annotations,
    constraints: computeConstraintStatus(contexts, annotations, landscape),
    images: [
      { id: landscape, tileSource: 'l.png', label: 'Landscape' },
      { id: portrait, tileSource: 'p.png' },
    ],
    canUndo: true,
    canRedo: false,
    notice: { seq: 3, text: 'hi' },
  };
}

/** The key paths of a JSON value: objects by key, arrays by their first item. */
function shape(value: unknown, path = ''): string[] {
  if (Array.isArray(value)) return value.length ? shape(value[0], `${path}[]`) : [`${path}[]`];
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) =>
      // `constraints` is keyed by tool; compare one entry's shape.
      path === '.constraints' ? shape(v, `${path}.*`) : shape(v, `${path}.${k}`),
    );
  }
  return [path];
}

describe('buildSnapshot', () => {
  it('has exactly the shape of the contract the Rust shell decodes', () => {
    expect([...new Set(shape(buildSnapshot(input())))].sort()).toEqual(
      [...new Set(shape(contract))].sort(),
    );
  });

  it('lists the active image’s annotations oldest first, marking other contexts hidden', () => {
    const s = buildSnapshot(input());
    expect(s.annotations).toEqual([
      { id: 'a', tool: 'rectangle', context: 'Fracture', visible: true },
      { id: 'b', tool: 'rectangle', context: 'General', visible: false },
    ]);
  });

  it('counts per image and falls back to the id for an unlabelled image', () => {
    const s = buildSnapshot(input());
    expect(s.images).toEqual([
      { id: 'landscape', label: 'Landscape', count: 2 },
      { id: 'portrait', label: 'portrait', count: 0 },
    ]);
  });

  it('reports the constraint status the toolbar would', () => {
    const s = buildSnapshot(input());
    expect(s.constraints['rectangle']).toEqual({ enabled: true, current: 1, max: 2 });
    expect(s.constraints['line']?.enabled).toBe(false);
  });

  it('describes an empty cell as no image and no annotations', () => {
    const i = input();
    i.ui.activeCellIndex = 1;
    i.ui.gridColumns = 2;
    const s = buildSnapshot(i);
    expect(s.activeImageId).toBeNull();
    expect(s.annotations).toEqual([]);
    expect(s.grid).toEqual({ columns: 2, rows: 1 });
    expect(s.activeCell).toBe(1);
  });

  it('shows every annotation when no context is active or displayed', () => {
    const i = input();
    i.contexts.activeContextId = null;
    expect(buildSnapshot(i).annotations.every((a) => a.visible)).toBe(true);
  });
});
