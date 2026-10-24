/**
 * H3 cost: evaluate 1,000 tracks on every frame of a 300-frame clip, with the
 * built @osdlabel/temporal (Node, single thread). Also measures what naive
 * index-wise polygon interpolation loses against the aligned correspondence.
 */
import { performance } from 'node:perf_hooks';
import {
  CorrespondenceCache,
  createFrameMaterializer,
  createTrack,
  createTrackId,
  interpolateGeometry,
  sampleTrack,
  signedArea,
  toTrackDocument,
} from '@osdlabel/temporal';
import { mulberry32 } from './rng.mjs';
import { quantile } from './summarize.mjs';

const FRAMES = 300;
const KF_EVERY = 30;

function starPolygon(rnd, n, cx, cy, r) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * 2 * Math.PI;
    const rr = r * (0.7 + 0.3 * rnd());
    pts.push({ x: cx + rr * Math.cos(a), y: cy + rr * Math.sin(a) });
  }
  return pts;
}

/** The same shape redrawn: another start vertex and the opposite winding. */
function redraw(points, start) {
  const n = points.length;
  const out = [];
  for (let k = 0; k < n; k++) out.push(points[(start - k + n) % n]);
  return out;
}

/** The same shape redrawn from another start vertex, same winding. */
function shifted(points, start) {
  const n = points.length;
  return Array.from({ length: n }, (_, k) => points[(start + k) % n]);
}

function makeGeometry(kind, rnd, kfIndex) {
  const cx = 200 + rnd() * 1500;
  const cy = 150 + rnd() * 800;
  switch (kind) {
    case 'rectangle':
      return {
        type: 'rectangle',
        origin: { x: cx, y: cy },
        width: 20 + rnd() * 80,
        height: 20 + rnd() * 80,
        rotation: rnd() * 30,
      };
    case 'circle':
      return { type: 'circle', center: { x: cx, y: cy }, radius: 5 + rnd() * 40 };
    case 'point':
      return { type: 'point', position: { x: cx, y: cy } };
    case 'line':
      return {
        type: 'line',
        start: { x: cx, y: cy },
        end: { x: cx + 50 * rnd(), y: cy + 50 * rnd() },
      };
    case 'polygon-equal':
      return { type: 'polygon', points: starPolygon(rnd, 16, cx, cy, 40) };
    case 'polygon-unequal': {
      const pts = starPolygon(rnd, kfIndex % 2 === 0 ? 12 : 24, cx, cy, 40);
      return { type: 'polygon', points: redraw(pts, Math.floor(rnd() * pts.length)) };
    }
    case 'polyline-unequal':
      return {
        type: 'polyline',
        points: Array.from({ length: kfIndex % 2 === 0 ? 8 : 12 }, (_, i) => ({
          x: cx + i * 10,
          y: cy + 20 * rnd(),
        })),
      };
    case 'mask':
      return { type: 'mask', origin: { x: cx, y: cy }, width: 64, height: 64, pixelCount: 2000 };
  }
  throw new Error(kind);
}

const MIX = [
  ['rectangle', 250],
  ['circle', 150],
  ['point', 150],
  ['line', 100],
  ['polygon-equal', 150],
  ['polygon-unequal', 100],
  ['polyline-unequal', 50],
  ['mask', 50],
];

function buildTracks(mix, seed) {
  const rnd = mulberry32(seed);
  const tracks = [];
  for (const [kind, count] of mix) {
    for (let t = 0; t < count; t++) {
      const keyframes = [];
      for (let k = 0, f = 0; f < FRAMES; k++, f += KF_EVERY) {
        keyframes.push({
          frame: f,
          geometry: makeGeometry(kind, rnd, k),
          visibility: rnd() < 0.1 ? 'occluded' : 'visible',
        });
      }
      const geometryType = keyframes[0].geometry.type;
      tracks.push(createTrack({ id: createTrackId(`${kind}-${t}`), geometryType, keyframes }));
    }
  }
  return tracks;
}

function timeFrames(fn) {
  const per = [];
  for (let f = 0; f < FRAMES; f++) {
    const t0 = performance.now();
    fn(f);
    per.push(performance.now() - t0);
  }
  return per;
}

const r3 = (x) => Math.round(x * 1000) / 1000;

function measure(label, tracks) {
  const cache = new CorrespondenceCache();
  let sink = 0;
  const sampleAll = (f) => {
    for (const t of tracks) {
      const s = sampleTrack(t, f, cache);
      if (s !== null) sink++;
    }
  };
  const cold = timeFrames(sampleAll);
  const warm = [];
  for (let pass = 0; pass < 3; pass++) warm.push(...timeFrames(sampleAll));
  const noCache = timeFrames((f) => {
    for (const t of tracks) if (sampleTrack(t, f) !== null) sink++;
  });
  const mat = createFrameMaterializer((track, s) => ({
    id: track.id,
    geometry: s.geometry,
    visibility: s.visibility,
  }));
  timeFrames((f) => mat(tracks, f));
  const materialize = [];
  for (let pass = 0; pass < 3; pass++)
    materialize.push(...timeFrames((f) => (sink += mat(tracks, f).length)));
  return {
    scenario: label,
    tracks: tracks.length,
    frames: FRAMES,
    keyframeEvery: KF_EVERY,
    coldSumMs: r3(cold.reduce((a, b) => a + b, 0)),
    coldMaxFrameMs: r3(Math.max(...cold)),
    warmP50Ms: r3(quantile(warm, 0.5)),
    warmP95Ms: r3(quantile(warm, 0.95)),
    noCacheP50Ms: r3(quantile(noCache, 0.5)),
    materializeP50Ms: r3(quantile(materialize, 0.5)),
    materializeP95Ms: r3(quantile(materialize, 0.95)),
    correspondencesComputed: cache.misses,
    sink,
  };
}

function areaStudy() {
  const rnd = mulberry32(99);
  const rows = {
    redrawSameCount: { naive: [], aligned: [] },
    shiftOnly: { naive: [], aligned: [] },
    unequalCount: { aligned: [] },
  };
  for (let k = 0; k < 200; k++) {
    const a = starPolygon(rnd, 16, 0, 0, 100);
    {
      const b = shifted(a, 1 + Math.floor(rnd() * 15));
      const ref = Math.abs(signedArea(a));
      const pa = { type: 'polygon', points: a };
      const pb = { type: 'polygon', points: b };
      rows.shiftOnly.naive.push(
        Math.abs(
          signedArea(interpolateGeometry(pa, pb, 0.5, { from: a, to: b, method: 'index' }).points),
        ) / ref,
      );
      rows.shiftOnly.aligned.push(
        Math.abs(signedArea(interpolateGeometry(pa, pb, 0.5).points)) / ref,
      );
    }
    const b = redraw(a, 1 + Math.floor(rnd() * 15));
    const ref = Math.abs(signedArea(a));
    const naive = interpolateGeometry(
      { type: 'polygon', points: a },
      { type: 'polygon', points: b },
      0.5,
      {
        from: a,
        to: b,
        method: 'index',
      },
    );
    const aligned = interpolateGeometry(
      { type: 'polygon', points: a },
      { type: 'polygon', points: b },
      0.5,
    );
    rows.redrawSameCount.naive.push(Math.abs(signedArea(naive.points)) / ref);
    rows.redrawSameCount.aligned.push(Math.abs(signedArea(aligned.points)) / ref);
    const c = redraw(starPolygon(rnd, 24, 0, 0, 100), Math.floor(rnd() * 24));
    const refC = (ref + Math.abs(signedArea(c))) / 2;
    const u = interpolateGeometry(
      { type: 'polygon', points: a },
      { type: 'polygon', points: c },
      0.5,
    );
    rows.unequalCount.aligned.push(Math.abs(signedArea(u.points)) / refC);
  }
  const s = (xs) => ({
    min: r3(Math.min(...xs)),
    p50: r3(quantile(xs, 0.5)),
    max: r3(Math.max(...xs)),
  });
  return {
    note: 'area at t=0.5 divided by the keyframe area (same-count redraw) or the mean of both keyframe areas (unequal); 200 random star polygons',
    shiftOnlySameWindingNaive: s(rows.shiftOnly.naive),
    shiftOnlySameWindingAligned: s(rows.shiftOnly.aligned),
    redrawSameCountNaive: s(rows.redrawSameCount.naive),
    redrawSameCountAligned: s(rows.redrawSameCount.aligned),
    unequalCount16to24Aligned: s(rows.unequalCount.aligned),
  };
}

export async function runTemporalBench() {
  const rows = [
    measure('mixed (rect/circle/point/line/polygon/polyline/mask)', buildTracks(MIX, 1)),
    measure('rectangles only', buildTracks([['rectangle', 1000]], 2)),
    measure(
      'polygons, unequal counts 12<->24, redrawn',
      buildTracks([['polygon-unequal', 1000]], 3),
    ),
  ];
  // Wire size of the mixed set (1,000 tracks x 10 keyframes), as plain JSON.
  const mixed = buildTracks(MIX, 1);
  const json = JSON.stringify(toTrackDocument(mixed));
  const t0 = performance.now();
  JSON.parse(json);
  const parseMs = performance.now() - t0;
  const serialization = {
    tracks: mixed.length,
    keyframes: mixed.reduce((a, t) => a + t.keyframes.length, 0),
    jsonBytes: json.length,
    parseMs: r3(parseMs),
  };
  return { rows, area: areaStudy(), serialization, node: process.version };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await runTemporalBench();
  console.log(JSON.stringify(r, null, 1));
}
