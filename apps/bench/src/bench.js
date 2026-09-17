/**
 * Bench page for the DecorationLayer hot path.
 *
 * Loads the REAL built `@osdlabel/fabric-osd` from whichever checkout
 * BENCH_ROOT pointed at when this Vite server was started (see
 * ../vite.config.mjs), creates one OSD viewer + FabricOverlay +
 * DecorationLayer over a local sample image, and exposes `window.__bench`.
 *
 * Nothing here is fetched from the network.
 */
import OpenSeadragon from 'openseadragon';
import { FabricOverlay, DecorationLayer } from '@osdlabel/fabric-osd';

const IMAGE_W = 1280;
const IMAGE_H = 800;

// ── deterministic PRNG so every build gets byte-identical decoration data ──
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Build a decoration set.
 *
 * `hudMode` is 'cell' on builds whose DecorationLayer understands
 * `anchorSpace: 'cell'` (feature-probed, never inferred from a build name) and
 * 'image' on builds that do not, where the same number of decorations is
 * emitted as plain image-space text so the element/work counts match exactly.
 */
export function buildDecorations({ text, dom, hud }, hudMode, frame) {
  const rnd = mulberry32(42);
  const out = [];
  for (let i = 0; i < text; i++) {
    const x = rnd() * IMAGE_W;
    const y = rnd() * IMAGE_H;
    const mutated = frame !== undefined && i % 10 === 0;
    out.push({
      type: 'text',
      id: `t${i}`,
      relatedAnnotationIds: [],
      text: mutated ? `label ${i} #${frame}` : `label ${i}`,
      anchor: { x, y },
      placement: 'center',
      style: { fontSize: 12 },
    });
  }
  for (let i = 0; i < dom; i++) {
    const x = rnd() * IMAGE_W;
    const y = rnd() * IMAGE_H;
    out.push({
      type: 'dom',
      id: `d${i}`,
      relatedAnnotationIds: [],
      anchor: { x, y },
      placement: 'top-left',
      content: null,
      style: { pointerEvents: 'none', width: 40, height: 14 },
    });
  }
  for (let i = 0; i < hud; i++) {
    if (hudMode === 'cell') {
      out.push({
        type: 'text',
        id: `h${i}`,
        relatedAnnotationIds: [],
        text: `HUD ${i}`,
        anchor: { x: 1, y: 0 },
        anchorSpace: 'cell',
        placement: 'top-right',
        offset: { x: -8, y: 8 + i * 18 },
        style: { fontSize: 12 },
      });
    } else {
      // No anchorSpace / no 'top-right' placement support on this build —
      // emit an equivalent plain image-space text decoration so N matches.
      out.push({
        type: 'text',
        id: `h${i}`,
        relatedAnnotationIds: [],
        text: `HUD ${i}`,
        anchor: { x: IMAGE_W - 40, y: 20 + i * 18 },
        placement: 'top-left',
        style: { fontSize: 12 },
      });
    }
  }
  return out;
}

/**
 * Scenario matrix. Add a row here (and a label in scripts/analyze.mjs) to add
 * a scenario; the key is what `--scenarios` filters on.
 */
export const SCENARIOS = {
  S0: { text: 0, dom: 0, hud: 0 },
  S1: { text: 10, dom: 0, hud: 0 },
  S2: { text: 100, dom: 0, hud: 0 },
  S3: { text: 500, dom: 0, hud: 0 },
  S4: { text: 100, dom: 100, hud: 0 },
  S5: { text: 100, dom: 0, hud: 1 },
  S6: { text: 100, dom: 0, hud: 4 },
  S7: { text: 500, dom: 0, hud: 1 },
};

// ── transform-write counting ─────────────────────────────────────────────
// Chromium implements CSS property accessors on CSSStyleDeclaration as V8
// *interceptors*, not as own accessor properties on the prototype — so the
// prototype patch silently does nothing (verified:
// Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype,'transform')
// is undefined). Instead we install a per-instance accessor on each decoration
// element's own `style` object, which DOES shadow the interceptor. Verified at
// install time and reported as `transformHookOk`.
const hookedDecls = new WeakSet();
let transformWrites = 0;
let transformHookOk = false;

function hookTransform(el) {
  if (hookedDecls.has(el.style)) return true;
  try {
    Object.defineProperty(el.style, 'transform', {
      configurable: true,
      get() {
        return this.getPropertyValue('transform');
      },
      set(v) {
        transformWrites++;
        this.setProperty('transform', v);
      },
    });
  } catch {
    return false;
  }
  hookedDecls.add(el.style);
  return true;
}

(function selfTest() {
  const probe = document.createElement('div');
  document.body.appendChild(probe);
  const installed = hookTransform(probe);
  const before = transformWrites;
  probe.style.transform = 'translate3d(3px, 4px, 0)';
  transformHookOk =
    installed &&
    transformWrites === before + 1 &&
    getComputedStyle(probe).transform === 'matrix(1, 0, 0, 1, 3, 4)';
  probe.remove();
  transformWrites = 0;
})();

function trackDecorationElements(hostEl) {
  for (const el of hostEl.querySelectorAll('[data-osdlabel^="decoration-"]')) hookTransform(el);
}

// ── viewer / overlay / layer ─────────────────────────────────────────────
const viewer = OpenSeadragon({
  element: document.getElementById('viewer'),
  prefixUrl: '',
  showNavigationControl: false,
  animationTime: 0.3,
  minZoomImageRatio: 0.5,
  maxZoomLevel: 40,
  visibilityRatio: 0.5,
  constrainDuringPan: true,
  immediateRender: true,
});

let overlay = null;
let layer = null;
let hostEl = null;

// per-window accumulators
let repositionSamples = [];
let setDecoSamples = [];

const ready = new Promise((resolve) => {
  viewer.addHandler('open', () => {
    if (overlay) return;
    overlay = new FabricOverlay(viewer, { testMode: true });
    layer = new DecorationLayer(overlay);
    hostEl = overlay.overlayElement.querySelector('[data-osdlabel="decoration-layer"]');

    // Wrap the instance methods. `onSync` calls `this._reposition()`, so an
    // own-property wrapper on the instance is hit. This is the pattern to
    // reuse for any other hot path: bind the original, time around it, push
    // the sample into a per-window accumulator.
    const origReposition = layer._reposition.bind(layer);
    layer._reposition = function wrapped() {
      const t0 = performance.now();
      origReposition();
      repositionSamples.push(performance.now() - t0);
    };
    const origSetDecorations = layer.setDecorations.bind(layer);
    layer.setDecorations = function wrapped(d) {
      const t0 = performance.now();
      origSetDecorations(d);
      setDecoSamples.push(performance.now() - t0);
    };
    resolve();
  });
  viewer.open({ type: 'image', url: __SAMPLE_IMAGE_URL__ });
});

/**
 * Feature-probe the *built* DecorationLayer for cell-space anchoring.
 *
 * A build without `anchorSpace` either throws (its `placementTranslate` has no
 * 'top-right' case and returns undefined) or silently treats the anchor as
 * image-space. Both are detected here: the probe is placed at cell {x:1,y:0},
 * which lands on the right-hand half of the host only under cell semantics —
 * as image pixel (1, 0) it lands at the image's top-left corner.
 */
function probeCellAnchor() {
  const probeId = '__probe_cell_anchor__';
  try {
    layer.setDecorations([
      {
        type: 'text',
        id: probeId,
        relatedAnnotationIds: [],
        text: 'probe',
        anchor: { x: 1, y: 0 },
        anchorSpace: 'cell',
        placement: 'top-right',
        offset: { x: 0, y: 0 },
        style: { fontSize: 12 },
      },
    ]);
  } catch {
    layer.setDecorations([]);
    return false;
  }
  const el = hostEl.querySelector('[data-osdlabel="decoration-text"]');
  const m = el && /translate3d\((-?[\d.]+)px/.exec(el.style.transform);
  const x = m ? Number(m[1]) : NaN;
  layer.setDecorations([]);
  return Number.isFinite(x) && x > hostEl.clientWidth / 2;
}

function stats(arr) {
  if (arr.length === 0) return { n: 0, median: 0, p95: 0, mean: 0, total: 0 };
  const s = [...arr].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  const total = s.reduce((a, b) => a + b, 0);
  return {
    n: s.length,
    median: q(0.5) * 1000, // µs
    p95: q(0.95) * 1000, // µs
    mean: (total / s.length) * 1000, // µs
    total, // ms
  };
}

function frames(count, onFrame) {
  return new Promise((resolve) => {
    const intervals = [];
    let i = 0;
    let last = performance.now();
    const step = () => {
      const now = performance.now();
      intervals.push(now - last);
      last = now;
      onFrame(i);
      i++;
      if (i >= count) resolve(intervals);
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

function resetWindow() {
  repositionSamples = [];
  setDecoSamples = [];
  transformWrites = 0;
}

async function settle(ms = 250) {
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * One measurement window.
 *
 * Add a phase by adding a branch here and listing its name in `--phases`:
 *   pan    — P1, viewport animation, every element moves every frame
 *   static — P2, sync with an unchanged viewport and unchanged decorations
 *   live   — P3, setDecorations every frame with 10% of the texts mutated
 */
async function runPhase(phase, spec, hudMode, frameCount) {
  trackDecorationElements(hostEl);
  await settle(120);
  resetWindow();
  const t0 = performance.now();
  let intervals;
  if (phase === 'pan') {
    const home = viewer.viewport.getCenter(true);
    intervals = await frames(frameCount, (i) => {
      const a = (i / frameCount) * Math.PI * 6;
      viewer.viewport.panTo(
        new OpenSeadragon.Point(home.x + Math.sin(a) * 0.08, home.y + Math.cos(a) * 0.05),
        true,
      );
      viewer.viewport.zoomTo(1 + 0.15 * (1 + Math.sin(a)), undefined, true);
      viewer.forceRedraw();
    });
  } else if (phase === 'static') {
    intervals = await frames(frameCount, () => {
      overlay.sync();
    });
  } else if (phase === 'live') {
    intervals = await frames(frameCount, (i) => {
      layer.setDecorations(buildDecorations(spec, hudMode, i));
    });
  } else {
    throw new Error(`unknown phase: ${phase}`);
  }
  const totalMs = performance.now() - t0;
  const meanInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
  return {
    phase,
    reposition: stats(repositionSamples),
    setDecorations: stats(setDecoSamples),
    windowMs: totalMs,
    meanRafMs: meanInterval,
    transformWrites,
    transformHookOk,
    frames: frameCount,
  };
}

window.__bench = {
  ready,
  root: __BENCH_ROOT__,
  scenarios: () => Object.keys(SCENARIOS),
  transformHookOk: () => transformHookOk,
  timerResolutionUs: () => {
    // smallest non-zero performance.now() delta observed, in µs
    let min = Infinity;
    for (let i = 0; i < 200000; i++) {
      const a = performance.now();
      const b = performance.now();
      if (b > a) min = Math.min(min, b - a);
    }
    return min * 1000;
  },
  crossOriginIsolated: () => globalThis.crossOriginIsolated === true,
  /** Feature probe, not a build-name check. See `probeCellAnchor`. */
  supportsCellAnchor: async () => {
    await ready;
    return probeCellAnchor();
  },
  // True once a layer that caches its host box (e.g. via ResizeObserver) has
  // done so, i.e. `_reposition` takes the cached path instead of measuring
  // inline. Always false on builds that have no such cache.
  hostSizeCached: () => layer !== null && layer._hostSize !== undefined,
  async run({ scenario, hudMode, frameCount = 240, phases = ['pan', 'static', 'live'] }) {
    await ready;
    const spec = SCENARIOS[scenario];
    if (!spec) throw new Error(`unknown scenario: ${scenario}`);
    // fresh state for the scenario
    layer.setDecorations([]);
    viewer.viewport.goHome(true);
    viewer.forceRedraw();
    await settle(150);
    layer.setDecorations(buildDecorations(spec, hudMode));
    await settle(150);
    const out = { scenario, hudMode, spec, phases: {} };
    for (const p of phases) {
      out.phases[p] = await runPhase(p, spec, hudMode, frameCount);
      // leave the static decoration set in place for the next phase
      layer.setDecorations(buildDecorations(spec, hudMode));
      viewer.viewport.goHome(true);
      viewer.forceRedraw();
      await settle(150);
    }
    return out;
  },
};
