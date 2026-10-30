// Part of the rectangle suite (every test file with "rectangle" in its name).
// This file pins what the built-in decoration providers emit for rectangles:
// label and measurement anchors sit at the rectangle's centre,
// origin + (w/2, h/2), which is the centre of the painted shape at every
// rotation; the distance provider's connector runs between rectangle centres;
// area is w·h and perimeter 2(w+h), with anisotropic spacing converting each
// rotated edge per axis. Changing only `rotation` moves nothing a provider
// emits; the one value it may change is a perimeter under anisotropic spacing.
// Expected values are written by hand or come from ./rectangle-reference.ts.
import { describe, expect, it } from 'vitest';
import type { Point, RectangleGeometry } from '@osdlabel/annotation';
import type { PixelSpacing } from '@osdlabel/viewer-api';
import {
  composeProviders,
  createDistanceProvider,
  createLabelProvider,
  createMeasurementProvider,
  rectangleCorners,
  type Decoration,
  type LineDecoration,
  type Measurement,
  type TextDecoration,
} from '../../src/index.js';
import { ann, ctx, type TestAnnotation } from './test-helpers.js';
import {
  RECTANGLE_ROTATIONS,
  rectangle,
  rectangleMatrix,
  referenceCorners,
  workedExample,
  type Corners,
} from './rectangle-reference.js';

/** `toBeCloseTo` digits: differences must stay below 5e-8. */
const DIGITS = 7;
const p = (x: number, y: number): Point => ({ x, y });
/** 0.1 mm per pixel across, 0.2 mm down. */
const ANISO: PixelSpacing = { x: 0.1, y: 0.2, unit: 'mm' };

const rectAnn = (id: string, geometry: RectangleGeometry, label?: string): TestAnnotation =>
  ann(id, 'rectangle', geometry, label);

function expectPoint(actual: Point, expected: Point, label: string): void {
  expect(actual.x, `${label}: x`).toBeCloseTo(expected.x, DIGITS);
  expect(actual.y, `${label}: y`).toBeCloseTo(expected.y, DIGITS);
}

/** The painted shape's centre: the mean of the reference corners. */
function paintedCentre(geometry: RectangleGeometry): Point {
  const corners = referenceCorners(geometry);
  return p(corners.reduce((s, c) => s + c.x, 0) / 4, corners.reduce((s, c) => s + c.y, 0) / 4);
}

/** Perimeter of the painted shape, each edge converted per axis. */
function paintedPerimeter(corners: Corners, spacing: PixelSpacing): number {
  let total = 0;
  for (let i = 0; i < 4; i++) {
    const a = corners[i]!;
    const b = corners[(i + 1) % 4]!;
    total += Math.hypot((b.x - a.x) * spacing.x, (b.y - a.y) * spacing.y);
  }
  return total;
}

function findText(decorations: readonly Decoration[], id: string): TextDecoration {
  const d = decorations.find((x) => x.id === id);
  expect(d, `decoration ${id}`).toBeDefined();
  if (d === undefined || d.type !== 'text') throw new Error(`${id} is not a text decoration`);
  return d;
}

function findLine(decorations: readonly Decoration[], id: string): LineDecoration {
  const d = decorations.find((x) => x.id === id);
  expect(d, `decoration ${id}`).toBeDefined();
  if (d === undefined || d.type !== 'line') throw new Error(`${id} is not a line decoration`);
  return d;
}

/** The area and perimeter the measurement provider computes, by metric label. */
function measured(
  geometry: RectangleGeometry,
  pixelSpacing: PixelSpacing | undefined,
): ReadonlyMap<string, Measurement> {
  const seen = new Map<string, Measurement>();
  const provider = createMeasurementProvider({
    area: true,
    perimeter: true,
    formatLine: (label, measurement) => {
      seen.set(label, measurement);
      return label;
    },
  });
  provider(ctx([rectAnn('r', geometry)], { pixelSpacing }));
  return seen;
}

function metric(seen: ReadonlyMap<string, Measurement>, label: 'A' | 'P'): Measurement {
  const m = seen.get(label);
  expect(m, `${label} measurement`).toBeDefined();
  return m!;
}

/** The worked example at 90°: centre (250,125), covering x 225–275, y 75–175. */
const WORKED_90: Corners = [p(275, 75), p(275, 175), p(225, 175), p(225, 75)];

describe('oracle self-check (pins the test reference, not the library)', () => {
  it('the test reference agrees with the worked example by hand', () => {
    referenceCorners(workedExample(90)).forEach((c, i) =>
      expectPoint(c, WORKED_90[i]!, `reference corner ${i}`),
    );
  });
});

// ── Anchors ────────────────────────────────────────────────────────────────

describe('rectangle label and measurement anchors', () => {
  it('the re-exported rectangleCorners gives the worked example by hand', () => {
    rectangleCorners(workedExample(90)).forEach((c, i) =>
      expectPoint(c, WORKED_90[i]!, `rectangleCorners corner ${i}`),
    );
  });

  it('worked example at 90°: the measurement label is centred on (250,125)', () => {
    const provider = createMeasurementProvider({ area: true, perimeter: true });
    expect(provider(ctx([rectAnn('r', workedExample(90))]))).toEqual([
      {
        id: 'measurement:r',
        type: 'text',
        relatedAnnotationIds: ['r'],
        text: 'A: 5000.00 px²\nP: 300.00 px',
        anchor: { x: 250, y: 125 },
        placement: 'center',
      },
    ]);
  });

  it('worked example at 90°: the text label is centred on (250,125)', () => {
    const provider = createLabelProvider();
    expect(provider(ctx([rectAnn('r', workedExample(90), 'lesion')]))).toEqual([
      {
        id: 'label:r',
        type: 'text',
        relatedAnnotationIds: ['r'],
        text: 'lesion',
        anchor: { x: 250, y: 125 },
        placement: 'center',
      },
    ]);
  });

  it.each(RECTANGLE_ROTATIONS)(
    'at %s°, both anchors sit at origin + (w/2, h/2), the painted centre',
    (rotation) => {
      const matrix = rectangleMatrix(rotation);
      const annotations = matrix.map(({ geometry }, i) => rectAnn(`r${i}`, geometry, `#${i}`));
      const measurements = createMeasurementProvider({ area: true, perimeter: true })(
        ctx(annotations),
      );
      const labels = createLabelProvider()(ctx(annotations));
      matrix.forEach(({ label, geometry: r }, i) => {
        const centre = p(r.origin.x + r.width / 2, r.origin.y + r.height / 2);
        for (const d of [
          findText(measurements, `measurement:r${i}`),
          findText(labels, `label:r${i}`),
        ]) {
          expectPoint(d.anchor, centre, `${label}: ${d.id} anchor`);
          expect(d.placement, `${label}: ${d.id} placement`).toBe('center');
          expect(d.offset, `${label}: ${d.id} offset`).toBeUndefined();
        }
      });
    },
  );

  it('moving a rotated rectangle moves its anchors by the same delta', () => {
    const anchors = (origin: Point): readonly Point[] => {
      const annotations = [rectAnn('r', rectangle(origin, 100, 50, 30), 'x')];
      return [
        findText(createLabelProvider()(ctx(annotations)), 'label:r').anchor,
        findText(createMeasurementProvider({ area: true })(ctx(annotations)), 'measurement:r')
          .anchor,
      ];
    };
    for (const anchor of anchors(p(200, 100))) expectPoint(anchor, p(250, 125), 'before');
    for (const anchor of anchors(p(212.5, 97))) expectPoint(anchor, p(262.5, 122), 'moved');
  });

  it('resizing keeps the anchor at the new centre: origin is the unrotated top-left', () => {
    // Width 100 → 140 at 90°: the centre is origin + (70, 25), whatever the rotation.
    const provider = createMeasurementProvider({ area: true });
    const [d] = provider(ctx([rectAnn('r', rectangle(p(200, 100), 140, 50, 90))]));
    expect(d).toBeDefined();
    expect(d!).toMatchObject({ anchor: { x: 270, y: 125 }, text: 'A: 7000.00 px²' });
  });
});

// ── Connector ──────────────────────────────────────────────────────────────

/** Centre (550,525): 300 across and 400 down from the worked example's centre. */
const OTHER = rectangle(p(520, 485), 60, 80, 30);

const connect = createDistanceProvider({
  pair: (annotations) => {
    const a = annotations.find((x) => x.id === 'a');
    const b = annotations.find((x) => x.id === 'b');
    return a !== undefined && b !== undefined ? [{ a, b, id: 'ab' }] : [];
  },
});

describe('rectangle connector (createDistanceProvider)', () => {
  it('runs between the centres of two rotated rectangles', () => {
    const out = connect(ctx([rectAnn('a', workedExample(90)), rectAnn('b', OTHER)]));
    expect(out).toHaveLength(2);
    expect(findLine(out, 'distance-line:ab')).toEqual({
      type: 'line',
      id: 'distance-line:ab',
      relatedAnnotationIds: ['a', 'b'],
      start: { x: 250, y: 125 },
      end: { x: 550, y: 525 },
      dashed: true,
    });
    expect(findText(out, 'distance-text:ab')).toEqual({
      type: 'text',
      id: 'distance-text:ab',
      relatedAnnotationIds: ['a', 'b'],
      text: '500.00 px',
      anchor: { x: 400, y: 325 },
      offset: { x: 0, y: -6 },
      placement: 'bottom',
    });
  });

  it('converts the centre-to-centre distance per axis with anisotropic spacing', () => {
    let value = Number.NaN;
    const provider = createDistanceProvider({
      pair: (annotations) => [{ a: annotations[0]!, b: annotations[1]! }],
      formatLine: (m, fmt) => {
        value = m.value;
        return fmt(m);
      },
    });
    const out = provider(
      ctx([rectAnn('a', workedExample(90)), rectAnn('b', OTHER)], { pixelSpacing: ANISO }),
    );
    // hypot(300 · 0.1, 400 · 0.2) = √7300
    expect(value).toBeCloseTo(Math.sqrt(7300), 10);
    expect(findText(out, 'distance-text:a-b').text).toBe('85.44 mm');
  });

  it.each(RECTANGLE_ROTATIONS)('its endpoints are the painted centres at %s°', (rotation) => {
    for (const { label, geometry } of rectangleMatrix(rotation)) {
      const other = { ...OTHER, rotation: -rotation };
      const out = connect(ctx([rectAnn('a', geometry), rectAnn('b', other)]));
      const line = findLine(out, 'distance-line:ab');
      expectPoint(line.start, paintedCentre(geometry), `${label}: start`);
      expectPoint(line.end, paintedCentre(other), `${label}: end`);
    }
  });

  it.each(RECTANGLE_ROTATIONS)(
    'turning both rectangles to %s° leaves the connector and its label where they were',
    (rotation) => {
      const at = (rot: number): readonly Decoration[] =>
        connect(
          ctx([rectAnn('a', workedExample(rot)), rectAnn('b', { ...OTHER, rotation: rot })], {
            pixelSpacing: ANISO,
          }),
        );
      expect(at(rotation)).toEqual(at(0));
    },
  );
});

// ── Area and perimeter ─────────────────────────────────────────────────────

/** The worked example (100 × 50) under ANISO, perimeters worked by hand. */
const ANISO_PERIMETERS: readonly { readonly rotation: number; readonly perimeter: number }[] = [
  // width along x: 2·(100·0.1 + 50·0.2)
  { rotation: 0, perimeter: 40 },
  // width edge (50√3, 50) → (5√3, 10), |·| = √175; height edge (−25, 25√3) → (−2.5, 5√3), |·| = √81.25
  { rotation: 30, perimeter: 2 * (Math.sqrt(175) + Math.sqrt(81.25)) },
  // width edge → (5√2, 10√2), |·| = √250; height edge → (−2.5√2, 5√2), |·| = √62.5
  { rotation: 45, perimeter: 2 * (Math.sqrt(250) + Math.sqrt(62.5)) },
  // width along y: 2·(100·0.2 + 50·0.1)
  { rotation: 90, perimeter: 50 },
  { rotation: 180, perimeter: 40 },
  { rotation: 270, perimeter: 50 },
  { rotation: -30, perimeter: 2 * (Math.sqrt(175) + Math.sqrt(81.25)) },
];

describe('rectangle area and perimeter', () => {
  it.each(RECTANGLE_ROTATIONS)('at %s°, area is w·h px² and perimeter 2(w+h) px', (rotation) => {
    for (const { label, geometry: r } of rectangleMatrix(rotation)) {
      const seen = measured(r, undefined);
      expect(metric(seen, 'A'), `${label}: area`).toEqual({
        value: expect.closeTo(r.width * r.height, DIGITS) as unknown,
        unit: 'px²',
      });
      expect(metric(seen, 'P'), `${label}: perimeter`).toEqual({
        value: expect.closeTo(2 * (r.width + r.height), DIGITS) as unknown,
        unit: 'px',
      });
    }
  });

  it.each(RECTANGLE_ROTATIONS)(
    'at %s°, isotropic spacing s gives area w·h·s² and perimeter 2(w+h)·s',
    (rotation) => {
      const spacing: PixelSpacing = { x: 0.25, y: 0.25, unit: 'µm' };
      for (const { label, geometry: r } of rectangleMatrix(rotation)) {
        const seen = measured(r, spacing);
        expect(
          metric(seen, 'A').value / (r.width * r.height * 0.0625),
          `${label}: area`,
        ).toBeCloseTo(1, 9);
        expect(
          metric(seen, 'P').value / (2 * (r.width + r.height) * 0.25),
          `${label}: perimeter`,
        ).toBeCloseTo(1, 9);
        expect(metric(seen, 'P').unit).toBe('µm');
      }
    },
  );

  it.each(ANISO_PERIMETERS)(
    'worked example at $rotation° with 0.1 × 0.2 mm pixels: area 100 mm², perimeter by hand',
    ({ rotation, perimeter }) => {
      const seen = measured(workedExample(rotation), ANISO);
      // 5000 px² · 0.1 · 0.2, whatever the rotation
      expect(metric(seen, 'A').value).toBeCloseTo(100, 9);
      expect(metric(seen, 'A').unit).toBe('mm²');
      expect(metric(seen, 'P').value).toBeCloseTo(perimeter, 9);
      expect(metric(seen, 'P').unit).toBe('mm');
    },
  );

  it('worked example with 0.1 × 0.2 mm pixels renders the hand values', () => {
    const provider = createMeasurementProvider({ area: true, perimeter: true });
    const text = (rotation: number): string =>
      findText(
        provider(ctx([rectAnn('r', workedExample(rotation))], { pixelSpacing: ANISO })),
        'measurement:r',
      ).text;
    expect(text(0)).toBe('A: 100.00 mm²\nP: 40.00 mm');
    expect(text(30)).toBe('A: 100.00 mm²\nP: 44.49 mm');
    expect(text(90)).toBe('A: 100.00 mm²\nP: 50.00 mm');
  });

  it.each(RECTANGLE_ROTATIONS)(
    'at %s°, the anisotropic perimeter is the painted edges converted per axis',
    (rotation) => {
      for (const { label, geometry } of rectangleMatrix(rotation)) {
        const expected = paintedPerimeter(referenceCorners(geometry), ANISO);
        expect(metric(measured(geometry, ANISO), 'P').value / expected, label).toBeCloseTo(1, 9);
      }
    },
  );

  it.each(RECTANGLE_ROTATIONS)(
    'at %s°, the anisotropic perimeter ignores position and repeats every half turn',
    (rotation) => {
      for (const { label, geometry } of rectangleMatrix(rotation)) {
        const base = metric(measured(geometry, ANISO), 'P').value;
        const variants: readonly [string, RectangleGeometry][] = [
          ['moved', { ...geometry, origin: p(geometry.origin.x - 999.5, geometry.origin.y + 7) }],
          ['half turn', { ...geometry, rotation: rotation + 180 }],
          // Mirroring the turn about the image axes cannot change a per-axis length.
          ['mirrored turn', { ...geometry, rotation: -rotation }],
        ];
        for (const [name, variant] of variants) {
          expect(
            metric(measured(variant, ANISO), 'P').value / base,
            `${label}: ${name}`,
          ).toBeCloseTo(1, 9);
        }
      }
    },
  );
});

// ── Only rotation changes ──────────────────────────────────────────────────

const everything = composeProviders([
  createMeasurementProvider({ area: true, perimeter: true }),
  createLabelProvider(),
  connect,
]);

/** Everything the providers emit for one rectangle (paired with OTHER) at a rotation. */
const emitted = (
  geometry: RectangleGeometry,
  pixelSpacing: PixelSpacing | undefined,
): readonly Decoration[] =>
  everything(
    ctx([rectAnn('a', geometry, 'a label'), rectAnn('b', OTHER, 'b label')], { pixelSpacing }),
  );

describe('turning a rectangle moves nothing the providers emit', () => {
  it.each(RECTANGLE_ROTATIONS)(
    'in pixels, everything at %s° equals everything at 0°',
    (rotation) => {
      for (const { label, geometry } of rectangleMatrix(rotation)) {
        const turned = emitted(geometry, undefined);
        expect(turned, label).toHaveLength(6);
        expect(turned, label).toEqual(emitted({ ...geometry, rotation: 0 }, undefined));
      }
    },
  );

  it.each(RECTANGLE_ROTATIONS)(
    'with anisotropic spacing at %s°, only the perimeter line changes',
    (rotation) => {
      for (const { label, geometry } of rectangleMatrix(rotation)) {
        const turned = emitted(geometry, ANISO);
        const flat = emitted({ ...geometry, rotation: 0 }, ANISO);
        expect(
          turned.map((d) => d.id),
          label,
        ).toEqual(flat.map((d) => d.id));
        turned.forEach((d, i) => {
          const before = flat[i]!;
          if (d.id !== 'measurement:a') {
            expect(d, `${label}: ${d.id}`).toEqual(before);
            return;
          }
          const m = findText(turned, d.id);
          const m0 = findText(flat, d.id);
          expect(m.anchor, `${label}: anchor`).toEqual(m0.anchor);
          expect(m.placement, `${label}: placement`).toBe(m0.placement);
          const [areaLine, perimeterLine] = m.text.split('\n');
          expect(areaLine, `${label}: area line`).toBe(m0.text.split('\n')[0]);
          const expected = paintedPerimeter(referenceCorners(geometry), ANISO);
          expect(perimeterLine, `${label}: perimeter line`).toBe(`P: ${expected.toFixed(2)} mm`);
        });
      }
    },
  );
});

// ── Zero size ──────────────────────────────────────────────────────────────

describe('zero-size rectangles', () => {
  it.each(RECTANGLE_ROTATIONS)(
    '0 × 0 at %s°: the label sits on its origin and nothing is measured',
    (rotation) => {
      const r = rectangle(p(17.5, -4.25), 0, 0, rotation);
      const [label] = createLabelProvider()(ctx([rectAnn('r', r, 'dot')]));
      expect(label).toBeDefined();
      expect(label!).toMatchObject({ anchor: { x: 17.5, y: -4.25 }, placement: 'center' });
      const provider = createMeasurementProvider({ area: true, perimeter: true });
      expect(provider(ctx([rectAnn('r', r)], { pixelSpacing: ANISO }))).toEqual([]);
    },
  );

  it('0 × 40 at 90°: centred on origin + (0, 20), perimeter 80 px or 8 mm along x', () => {
    const r = rectangle(p(10, 20), 0, 40, 90);
    const provider = createMeasurementProvider({ area: true, perimeter: true });
    expect(provider(ctx([rectAnn('r', r)]))).toEqual([
      expect.objectContaining({ anchor: { x: 10, y: 40 }, text: 'P: 80.00 px' }) as unknown,
    ]);
    // The 40 px height runs along x once turned 90°: 2 · 40 · 0.1
    expect(provider(ctx([rectAnn('r', r)], { pixelSpacing: ANISO }))).toEqual([
      expect.objectContaining({ anchor: { x: 10, y: 40 }, text: 'P: 8.00 mm' }) as unknown,
    ]);
  });
});
