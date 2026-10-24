// The H2/H3 scenario, shared by the browser runner (bench.mjs) and the native
// quality check (quality-check.mjs): views a pathologist actually visits on
// the synthetic gigapixel DZI, the click in each, and its ground truth.
import { pickTargets } from './scene-targets.mjs';

/** The harness viewer's size in CSS px (bench.mjs opens 1280x800 pages). */
export const VIEW_W = 1280;
export const VIEW_H = 800;

/** The H2/H3 scenario: zoom levels and pans a pathologist actually does. */
export function scenarioSteps(stepFilter = null) {
  const T = pickTargets();
  const overview = VIEW_W / 40_000; // the whole island on screen
  const glandZoom = VIEW_W / 10_000;
  const glandGt = { kind: 'ellipse', x: T.gland.x, y: T.gland.y, rx: T.gland.rx, ry: T.gland.ry };
  const lumenGt = { ...glandGt, rx: T.gland.rx * 0.72, ry: T.gland.ry * 0.72 };
  const nucleusGt = {
    kind: 'ellipse',
    x: T.nucleus.x,
    y: T.nucleus.y,
    rx: T.nucleus.r,
    ry: T.nucleus.r,
  };
  const g2 = T.gland2 ?? T.gland;
  return [
    {
      id: 'S1',
      name: 'overview, first click (cold encode): tissue island',
      view: { cx: T.island.x, cy: T.island.y, zoom: overview },
      click: T.stroma,
      gt: { kind: 'none' },
    },
    {
      id: 'S2',
      name: 'same view, second object: gland (embedding cache hit)',
      click: { x: T.gland.x, y: T.gland.y },
      gt: glandGt,
      altGt: lumenGt,
    },
    {
      id: 'S3',
      name: 'pan 10% of viewport (inside margin): gland 2',
      view: { cx: T.island.x + 0.1 * 40_000, cy: T.island.y, zoom: overview },
      click: { x: g2.x, y: g2.y },
      gt: { kind: 'ellipse', x: g2.x, y: g2.y, rx: g2.rx, ry: g2.ry },
    },
    {
      id: 'S4',
      name: 'pan 70% (beyond margin): re-encode',
      view: { cx: T.island.x + 0.7 * 40_000, cy: T.island.y, zoom: overview },
      click: { x: T.island.x + 0.7 * 40_000, y: T.island.y },
      gt: { kind: 'none' },
    },
    {
      id: 'S5',
      name: 'zoom 4x onto the gland (too coarse: re-encode)',
      view: { cx: T.gland.x, cy: T.gland.y, zoom: glandZoom },
      click: { x: T.gland.x, y: T.gland.y },
      gt: glandGt,
      altGt: lumenGt,
    },
    {
      id: 'S6',
      name: 'zoom 1.5x more (within maxZoomIn: reuse)',
      view: { cx: T.gland.x, cy: T.gland.y, zoom: glandZoom * 1.5 },
      click: { x: T.gland.x + T.gland.rx * 0.86, y: T.gland.y },
      gt: glandGt,
      altGt: lumenGt,
    },
    {
      id: 'S7',
      name: 'zoom to 1:1 on a nucleus (crop capped at native resolution)',
      view: { cx: T.nucleus.x, cy: T.nucleus.y, zoom: 1 },
      click: { x: T.nucleus.x, y: T.nucleus.y },
      gt: nucleusGt,
    },
    {
      id: 'S8',
      name: 'new view, prepare() on settle, then click (decode only)',
      view: { cx: g2.x, cy: g2.y, zoom: glandZoom },
      prepare: true,
      click: { x: g2.x, y: g2.y },
      gt: { kind: 'ellipse', x: g2.x, y: g2.y, rx: g2.rx, ry: g2.ry },
    },
    // Refinement across a view change (review finding): the prompt is kept
    // between R1-R3 (no commit/cancel), so R2 and R3 add points to it.
    {
      id: 'R1',
      name: 'refine 1/3: gland view, click the top rim (point A)',
      view: { cx: T.gland.x, cy: T.gland.y, zoom: glandZoom },
      click: { x: T.gland.x, y: T.gland.y - 0.86 * T.gland.ry },
      gt: glandGt,
      keep: true,
    },
    {
      id: 'R2',
      name: 'refine 2/3: zoom 4x onto the bottom rim (A leaves the view), add point B: one encode',
      view: { cx: T.gland.x, cy: T.gland.y + 0.86 * T.gland.ry, zoom: glandZoom * 4 },
      click: { x: T.gland.x, y: T.gland.y + 0.86 * T.gland.ry },
      gt: glandGt,
      keep: true,
      expectCached: false,
    },
    {
      id: 'R3',
      name: 'refine 3/3: same view, add point C: cache hit, mask_input fed back',
      click: { x: T.gland.x - 0.5 * T.gland.rx, y: T.gland.y + 0.75 * T.gland.ry },
      gt: glandGt,
      expectCached: true,
    },
  ].filter((s) => !stepFilter || stepFilter.includes(s.id));
}

/**
 * The SegmentationTarget the e2e page reports for a step's view: what OSD shows
 * in a VIEW_W x VIEW_H viewer centred on (cx, cy) at `zoom` screen px per image
 * px, clipped to the image.
 */
export function targetForView(view, imageSize, imageKey = 'synth') {
  const w = VIEW_W / view.zoom;
  const h = VIEW_H / view.zoom;
  const x0 = Math.max(0, view.cx - w / 2);
  const y0 = Math.max(0, view.cy - h / 2);
  const x1 = Math.min(imageSize.width, view.cx + w / 2);
  const y1 = Math.min(imageSize.height, view.cy + h / 2);
  return {
    imageKey,
    imageSize,
    viewport: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 },
    viewportScale: view.zoom,
  };
}
