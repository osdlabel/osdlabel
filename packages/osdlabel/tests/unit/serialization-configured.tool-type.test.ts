// @vitest-environment jsdom
/**
 * `deserialize` rejects an annotation whose `toolType` is not a tool that
 * draws its geometry's type. Constraints count annotations by `toolType`
 * (`computeConstraintStatus`), so a rectangle recorded as drawn by the line
 * tool would use up one of the context's lines and free one of its
 * rectangles.
 *
 * Which pairings are valid is read off the tools themselves: each drawing
 * tool the factory makes is driven on a real Fabric canvas and its commit
 * kept, as the bindings keep it. Every one of them loads, as does a document
 * 0.21.0 exported, which holds every pairing. Every other pairing is refused
 * with a message naming the annotation, its geometry type and its toolType.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Canvas } from 'fabric';
import { createImageId, type AnnotationState, type ImageId } from '@osdlabel/viewer-api';
import { createAnnotationContextId } from '@osdlabel/annotation-context';
import {
  initFabricModule,
  type AddAnnotationParams,
  type ToolCallbacks,
  type ToolOverlay,
} from '@osdlabel/fabric-annotations';
import {
  type AnnotationId,
  type GeometryType,
  type Point,
  type ToolType,
} from '@osdlabel/annotation';
import { DEFAULT_KEYBOARD_SHORTCUTS } from '../../src/keyboard.js';
import { deserialize, serialize, SerializationError } from '../../src/serialization-configured.js';
import { createAnnotationTool, processToolAddAnnotation } from '../../src/tool-factory.js';
import type { OsdAnnotation, OsdFields } from '../../src/types.js';
import { DOCUMENT_0_21_0_JSON } from './document-0.21.0.js';

initFabricModule();

const imageId = createImageId('img-1');
const contextId = createAnnotationContextId('ctx-1');

const canvases: Canvas[] = [];
afterEach(() => {
  for (const canvas of canvases.splice(0)) {
    const element = canvas.getElement();
    void canvas.dispose().then(() => element.remove());
  }
});

/** A pointer event with only what the tools read. */
function pointer(shiftKey = false): PointerEvent {
  return { shiftKey } as PointerEvent;
}

/** One gesture on a tool: the presses, moves, releases and keys it receives. */
type Step =
  | { readonly kind: 'down' | 'move' | 'up'; readonly at: Point; readonly shiftKey?: boolean }
  | { readonly kind: 'key'; readonly key: string };

/**
 * Drive the tool the factory makes for `toolType` through `steps` on a real
 * Fabric canvas with an identity view, and return the annotation the bindings
 * would store from its commit: `processToolAddAnnotation` of what it added.
 */
function commitFrom(toolType: ToolType, steps: readonly Step[]): OsdAnnotation {
  const element = document.createElement('canvas');
  document.body.appendChild(element);
  const canvas = new Canvas(element, { width: 800, height: 600, renderOnAddRemove: false });
  canvases.push(canvas);
  const overlay: ToolOverlay = {
    canvas,
    imageToScreen: (p) => p,
    pressSeqOf: () => undefined,
  };
  const added: AddAnnotationParams[] = [];
  const callbacks: ToolCallbacks = {
    getActiveContextId: () => contextId,
    getToolConstraint: () => undefined,
    canAddAnnotation: () => true,
    addAnnotation: (params) => added.push(params),
    updateAnnotation: () => {},
    deleteAnnotation: () => {},
    setSelectedAnnotation: () => {},
    getAnnotation: () => undefined,
  };
  const tool = createAnnotationTool(toolType);
  expect(tool, `the factory makes a ${toolType} tool`).not.toBeNull();
  tool!.activate(overlay, imageId, callbacks, DEFAULT_KEYBOARD_SHORTCUTS);
  for (const step of steps) {
    if (step.kind === 'key') {
      tool!.onKeyDown(new KeyboardEvent('keydown', { key: step.key }));
      continue;
    }
    const event = pointer(step.shiftKey);
    if (step.kind === 'down') tool!.onPointerDown(event, step.at);
    else if (step.kind === 'move') tool!.onPointerMove(event, step.at);
    else tool!.onPointerUp(event, step.at);
  }
  tool!.deactivate();
  expect(added, `the ${toolType} tool committed one annotation`).toHaveLength(1);
  const fields = processToolAddAnnotation(added[0]!);
  expect(fields).not.toBeNull();
  const now = '2026-10-01T12:00:00.000Z';
  return { ...fields!, createdAt: now, updatedAt: now };
}

/** A press-drag-release from `from` to `to`. */
function drag(from: Point, to: Point, shiftKey = false): Step[] {
  const steps: Step[] = [{ kind: 'down', at: from, shiftKey }];
  for (let k = 1; k <= 6; k++) {
    const at = { x: from.x + ((to.x - from.x) * k) / 6, y: from.y + ((to.y - from.y) * k) / 6 };
    steps.push({ kind: 'move', at, shiftKey });
  }
  steps.push({ kind: 'up', at: to, shiftKey });
  return steps;
}

/** A click at each of `points`. */
function clicks(points: readonly Point[]): Step[] {
  return points.flatMap((at) => [
    { kind: 'down', at },
    { kind: 'up', at },
  ]);
}

/** A freehand stroke through `points`, with Shift held throughout when `open`. */
function stroke(points: readonly Point[], open: boolean): Step[] {
  const [first, ...rest] = points;
  return [
    { kind: 'down', at: first!, shiftKey: open },
    ...rest.map((at): Step => ({ kind: 'move', at, shiftKey: open })),
    { kind: 'up', at: rest[rest.length - 1]!, shiftKey: open },
  ];
}

const triangle: readonly Point[] = [
  { x: 100, y: 100 },
  { x: 300, y: 120 },
  { x: 200, y: 260 },
];

/** What each drawing tool commits, for every kind of shape it draws. */
function toolCommits(): OsdAnnotation[] {
  return [
    commitFrom('rectangle', drag({ x: 100, y: 100 }, { x: 300, y: 200 })),
    commitFrom('circle', drag({ x: 200, y: 200 }, { x: 260, y: 200 })),
    commitFrom('line', drag({ x: 100, y: 100 }, { x: 300, y: 250 })),
    commitFrom('point', clicks([{ x: 150, y: 150 }])),
    // Open: Enter finishes the path where it is.
    commitFrom('polyline', [
      ...clicks(triangle),
      { kind: 'key', key: DEFAULT_KEYBOARD_SHORTCUTS.polylineFinish },
    ]),
    // Closed: a click on the first vertex closes it.
    commitFrom('polyline', clicks([...triangle, triangle[0]!])),
    // Closed by default.
    commitFrom('freeHandPath', stroke(triangle, false)),
    // Open while Shift is held.
    commitFrom('freeHandPath', stroke(triangle, true)),
  ];
}

/** The pairings the tools draw, as [toolType, geometry type]. */
const DRAWN: readonly (readonly [ToolType, GeometryType])[] = [
  ['rectangle', 'rectangle'],
  ['circle', 'circle'],
  ['line', 'line'],
  ['point', 'point'],
  ['polyline', 'polyline'],
  ['polyline', 'polygon'],
  ['freeHandPath', 'polygon'],
  ['freeHandPath', 'polyline'],
];

const TOOL_TYPES: readonly ToolType[] = [
  'rectangle',
  'circle',
  'line',
  'point',
  'polyline',
  'freeHandPath',
];

function draws(toolType: ToolType, geometryType: string): boolean {
  return DRAWN.some(([t, g]) => t === toolType && g === geometryType);
}

/** The tool types that draw `geometryType`, as the error message lists them. */
function toolsDrawing(geometryType: string): string {
  return TOOL_TYPES.filter((t) => draws(t, geometryType))
    .map((t) => `"${t}"`)
    .join(' or ');
}

/** `annotations` exported and read back, as a host saves and loads them. */
function roundTrip(annotations: readonly OsdAnnotation[]): OsdAnnotation[] {
  const stored: Record<ImageId, Record<AnnotationId, OsdAnnotation>> = {};
  for (const a of annotations) stored[a.imageId] = { ...stored[a.imageId], [a.id]: a };
  const state: AnnotationState<OsdFields> = { byImage: stored, changeCounter: 0 };
  const { byImage } = deserialize(JSON.parse(JSON.stringify(serialize(state))));
  return Object.values(byImage).flatMap((forImage) => Object.values(forImage));
}

function rejection(doc: unknown): SerializationError {
  try {
    deserialize(doc);
  } catch (err) {
    expect(err).toBeInstanceOf(SerializationError);
    return err as SerializationError;
  }
  throw new Error('deserialize accepted the document');
}

/** The fields of a saved annotation these tests read; the rest passes through. */
type SavedAnnotation = Record<string, unknown> & {
  readonly id: string;
  readonly toolType: string;
  readonly geometry: { readonly type: string };
};

/** The document 0.21.0 exported, parsed. */
function savedDocument(): SavedAnnotation[] {
  const saved: unknown = JSON.parse(DOCUMENT_0_21_0_JSON);
  if (!Array.isArray(saved)) throw new Error('the 0.21.0 document is not an array');
  return saved as SavedAnnotation[];
}

const pairsOf = (annotations: readonly { toolType: string; geometry: { type: string } }[]) =>
  annotations.map((a) => [a.toolType, a.geometry.type]);

describe('deserialize: the toolType must draw the geometry', () => {
  it('the drawing tools commit exactly these pairings', () => {
    expect(pairsOf(toolCommits())).toEqual(DRAWN);
  });

  it('loads what every drawing tool commits', () => {
    const annotations = toolCommits();
    expect(roundTrip(annotations)).toEqual(annotations);
  });

  it('loads a document exported by 0.21.0, which holds every pairing', () => {
    const saved = savedDocument();
    const pairs = new Set(pairsOf(saved).map((p) => p.join('/')));
    expect([...pairs].sort()).toEqual(DRAWN.map((p) => p.join('/')).sort());

    const { byImage } = deserialize(saved);
    const loaded = Object.values(byImage).flatMap((forImage) => Object.values(forImage));
    expect(loaded).toHaveLength(saved.length);
  });

  // One annotation of each geometry type, as 0.21.0 saved it, recorded as
  // drawn by each tool that does not draw it: 5 each for a shape, 4 for a
  // polyline or a polygon.
  const byGeometry = new Map<string, SavedAnnotation>();
  for (const annotation of savedDocument()) {
    if (!byGeometry.has(annotation.geometry.type)) {
      byGeometry.set(annotation.geometry.type, annotation);
    }
  }
  const mismatches = [...byGeometry].flatMap(([geometryType, annotation]) =>
    TOOL_TYPES.filter((toolType) => !draws(toolType, geometryType)).map(
      (toolType) => [geometryType, toolType, annotation] as const,
    ),
  );

  it('there is a mismatch to try for every geometry type', () => {
    expect(byGeometry.size).toBe(6);
    expect(mismatches).toHaveLength(28);
  });

  it.each(mismatches)(
    'rejects %s geometry recorded as drawn by the %s tool, naming the annotation and both types',
    (geometryType, toolType, annotation) => {
      const err = rejection(JSON.parse(JSON.stringify([{ ...annotation, toolType }])));
      expect(err.message).toBe(
        `Validation failed: Annotation "${annotation.id}" has ${geometryType} geometry, ` +
          `but its toolType is "${toolType}", not ${toolsDrawing(geometryType)}`,
      );
    },
  );

  it('rejects the whole document, so none of it is loaded', () => {
    const annotations = toolCommits();
    expect(() => deserialize(JSON.parse(JSON.stringify(annotations)))).not.toThrow();
    const rectangle = annotations[0]!;
    expect(rectangle.geometry.type).toBe('rectangle');
    const doc = annotations.map((a) => (a === rectangle ? { ...a, toolType: 'line' } : a));
    const err = rejection(JSON.parse(JSON.stringify(doc)));
    expect(err.name).toBe('SerializationError');
    expect(err.message).toBe(
      `Validation failed: Annotation "${rectangle.id}" has rectangle geometry, but its toolType is "line", not "rectangle"`,
    );
  });
});
