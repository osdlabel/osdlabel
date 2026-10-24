/**
 * H3: export osdlabel annotations drawn on real IDC images to SR (TID 1500,
 * 2D and 3D), SEG (from @osdlabel/mask snapshots) and Microscopy Bulk Simple
 * Annotations, then read every file back with @osdlabel/dicom and measure the
 * round trip. The Python validator (scripts/py/validate.py) checks the same
 * files with dciodvfy and highdicom.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  readPart10,
  TAGS,
  readPlaneGeometry,
  readSlidePlane,
  pixelSpacingOf,
  imageToPatient,
} from '@osdlabel/dicom';
import {
  buildMeasurementReport,
  buildSegmentation,
  buildBulkAnnotations,
  imageRefFrom,
  readMeasurementReport,
  readSegmentation,
  readBulkAnnotations,
  measurementsFor,
  toScoord,
} from '@osdlabel/dicom-export';
import {
  BoundedDenseMaskBuffer,
  stampCircle,
  strokeSegment,
  snapshotPixelCount,
} from '@osdlabel/mask';

/** A fixed, deliberately non-integer annotation set scaled to an image. */
export function vectorSet(w, h) {
  const s = (fx, fy) => ({ x: +(fx * w).toFixed(3) + 0.123, y: +(fy * h).toFixed(3) + 0.456 });
  return [
    {
      id: 'rect',
      label: 'rectangle',
      geometry: {
        type: 'rectangle',
        origin: s(0.15, 0.2),
        width: 0.2 * w + 0.75,
        height: 0.12 * h + 0.125,
        rotation: 20,
      },
    },
    {
      id: 'circle',
      label: 'circle',
      geometry: { type: 'circle', center: s(0.6, 0.45), radius: 0.07 * Math.min(w, h) + 0.25 },
    },
    {
      id: 'polygon',
      label: 'polygon',
      geometry: {
        type: 'polygon',
        points: [s(0.1, 0.7), s(0.3, 0.66), s(0.37, 0.86), s(0.16, 0.92)],
      },
    },
    {
      id: 'line',
      label: 'line',
      geometry: { type: 'line', start: s(0.4, 0.12), end: s(0.78, 0.35) },
    },
    {
      id: 'polyline',
      label: 'polyline',
      geometry: {
        type: 'polyline',
        points: [s(0.05, 0.05), s(0.16, 0.1), s(0.27, 0.06), s(0.39, 0.16)],
      },
    },
    { id: 'point', label: 'point', geometry: { type: 'point', position: s(0.5, 0.5) } },
  ];
}

/** Paints a reproducible brush mask, as the segmentation brush would. */
export function paintMask(w, h, seed) {
  const buf = new BoundedDenseMaskBuffer({ imageWidth: w, imageHeight: h });
  const r = Math.max(2, Math.round(Math.min(w, h) * 0.04));
  const pts = [0, 1, 2, 3, 4].map((i) => [
    w * (0.3 + 0.08 * i + 0.01 * seed),
    h * (0.4 + 0.05 * Math.sin(i + seed)),
  ]);
  stampCircle(buf, pts[0][0], pts[0][1], r, 1);
  for (let i = 1; i < pts.length; i++)
    strokeSegment(buf, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1], r, 1);
  // Erase a hole so the mask is not convex (tests the bit packing honestly).
  stampCircle(buf, pts[2][0], pts[2][1], r * 0.5, 0);
  return buf.snapshot();
}

const maskHash = (s) =>
  crypto
    .createHash('sha256')
    .update(`${s.x},${s.y},${s.width},${s.height}|`)
    .update(s.data)
    .digest('hex')
    .slice(0, 16);

function geomPoints(g) {
  return toScoord(g).points;
}

function maxPointError(a, b) {
  const pa = geomPoints(a);
  const pb = geomPoints(b);
  if (pa.length !== pb.length) return Infinity;
  let m = 0;
  for (let i = 0; i < pa.length; i++)
    m = Math.max(m, Math.abs(pa[i].x - pb[i].x), Math.abs(pa[i].y - pb[i].y));
  return m;
}

function load(dataDir, role, file) {
  const bytes = new Uint8Array(fs.readFileSync(path.join(dataDir, role, file)));
  return readPart10(bytes);
}

function firstSorted(dataDir, role, n) {
  const files = fs
    .readdirSync(path.join(dataDir, role))
    .filter((f) => f.endsWith('.dcm'))
    .sort();
  const parsed = files.map((f) => ({ f, file: load(dataDir, role, f) }));
  parsed.sort((a, b) => {
    const pa = readPlaneGeometry(a.file.dataset);
    const pb = readPlaneGeometry(b.file.dataset);
    return (pa?.position[2] ?? 0) - (pb?.position[2] ?? 0);
  });
  return parsed.slice(0, n);
}

/** Runs the export matrix; writes files into `outDir`, returns expectations + node-side round trip. */
export function runExportExperiment({ dataDir, outDir }) {
  fs.mkdirSync(outDir, { recursive: true });
  const cases = [];
  const timings = {};
  const time = (k, fn) => {
    const t0 = performance.now();
    const r = fn();
    timings[k] = +(performance.now() - t0).toFixed(2);
    return r;
  };

  // ── CT: SR 2D + 3D on one slice, SEG on two adjacent slices ───────────────
  const ct = firstSorted(dataDir, 'ct', 3);
  const ctA = ct[0].file.dataset;
  const ctRefA = imageRefFrom(ctA);
  const cols = ctRefA.columns;
  const rows = ctRefA.rows;
  const spacing = pixelSpacingOf(ctA);
  const vectors = vectorSet(cols, rows);
  const srItems = vectors.map((v) => ({ ...v, image: ctRefA, pixelSpacing: spacing }));
  for (const mode of ['2d', '3d']) {
    const built = time(`sr-ct-${mode}`, () =>
      buildMeasurementReport({ source: ctA, items: srItems, coordinates: mode }),
    );
    const file = `sr-ct-${mode}.dcm`;
    fs.writeFileSync(path.join(outDir, file), built.bytes);
    const back = readMeasurementReport(readPart10(built.bytes).dataset, ctRefA.plane);
    cases.push(srCase(file, 'SR', mode, vectors, spacing, back, built.bytes.length));
  }
  const masks = ct
    .slice(0, 2)
    .map((s, i) => ({ image: imageRefFrom(s.file.dataset), snapshot: paintMask(cols, rows, i) }));
  const segCt = time('seg-ct', () =>
    buildSegmentation({
      source: ctA,
      segments: [{ label: 'brush lesion', rgb: [255, 80, 40], masks }],
    }),
  );
  fs.writeFileSync(path.join(outDir, 'seg-ct.dcm'), segCt.bytes);
  cases.push(segCase('seg-ct.dcm', masks, segCt));

  // ── MR (oblique plane): SR 3D, the coordinate-frame stress case ────────────
  const mr = firstSorted(dataDir, 'mr', 1)[0].file.dataset;
  const mrRef = imageRefFrom(mr);
  const mrVectors = vectorSet(mrRef.columns, mrRef.rows);
  const mrSr = buildMeasurementReport({
    source: mr,
    items: mrVectors.map((v) => ({ ...v, image: mrRef, pixelSpacing: pixelSpacingOf(mr) })),
    coordinates: '3d',
  });
  fs.writeFileSync(path.join(outDir, 'sr-mr-3d.dcm'), mrSr.bytes);
  cases.push(
    srCase(
      'sr-mr-3d.dcm',
      'SR',
      '3d',
      mrVectors,
      pixelSpacingOf(mr),
      readMeasurementReport(readPart10(mrSr.bytes).dataset, mrRef.plane),
      mrSr.bytes.length,
    ),
  );

  // ── US (no frame of reference; calibration from an ultrasound region) ──────
  const us = load(dataDir, 'us-ge', fs.readdirSync(path.join(dataDir, 'us-ge'))[0]).dataset;
  const usRef = imageRefFrom(us);
  const usVectors = vectorSet(usRef.columns, usRef.rows);
  const usSr = buildMeasurementReport({
    source: us,
    items: usVectors.map((v) => ({ ...v, image: usRef, pixelSpacing: pixelSpacingOf(us) })),
  });
  fs.writeFileSync(path.join(outDir, 'sr-us-2d.dcm'), usSr.bytes);
  cases.push(
    srCase(
      'sr-us-2d.dcm',
      'SR',
      '2d',
      usVectors,
      pixelSpacingOf(us),
      readMeasurementReport(readPart10(usSr.bytes).dataset),
      usSr.bytes.length,
    ),
  );
  const usMasks = [{ image: usRef, snapshot: paintMask(usRef.columns, usRef.rows, 3) }];
  const usSeg = buildSegmentation({
    source: us,
    segments: [{ label: 'brush region', masks: usMasks }],
  });
  fs.writeFileSync(path.join(outDir, 'seg-us.dcm'), usSeg.bytes);
  cases.push(segCase('seg-us.dcm', usMasks, usSeg));

  // ── SM whole slide: ANN 2D / 3D, and SR 2D on the Total Pixel Matrix ───────
  const smFiles = fs.readdirSync(path.join(dataDir, 'sm-jpeg')).filter((f) => f.endsWith('.dcm'));
  const smParsed = smFiles.map((f) => load(dataDir, 'sm-jpeg', f).dataset);
  const volume = smParsed
    .filter((d) => (d.strings(TAGS.ImageType.tag) ?? []).includes('VOLUME'))
    .sort(
      (a, b) =>
        (b.numbers(TAGS.TotalPixelMatrixColumns.tag)?.[0] ?? 0) -
        (a.numbers(TAGS.TotalPixelMatrixColumns.tag)?.[0] ?? 0),
    )[0];
  const smRef = imageRefFrom(volume);
  const tpm = smRef.totalPixelMatrix;
  const smVectors = vectorSet(tpm.columns, tpm.rows);
  for (const [mode, dbl] of [
    ['2D', false],
    ['3D', false],
    ['3D', true],
  ]) {
    const built = time(`ann-sm-${mode}${dbl ? '-double' : ''}`, () =>
      buildBulkAnnotations({
        image: smRef,
        source: volume,
        items: smVectors.map((v) => ({ geometry: v.geometry, label: v.label })),
        coordinates: mode,
        double: dbl,
      }),
    );
    const file = `ann-sm-${mode.toLowerCase()}${dbl ? '-f64' : ''}.dcm`;
    fs.writeFileSync(path.join(outDir, file), built.bytes);
    const back = readBulkAnnotations(readPart10(built.bytes).dataset, smRef.plane);
    const errs = smVectors.map((v) => {
      const g = back.find((x) => x.label === v.label);
      return g ? maxPointError(v.geometry, g.geometries[0]) : Infinity;
    });
    cases.push({
      file,
      kind: 'ANN',
      mode: `${mode}${dbl ? ' float64' : ' float32'}`,
      bytes: built.bytes.length,
      groups: built.groups,
      maxCoordErrorPx: Math.max(...errs),
      perShapeErrorPx: Object.fromEntries(smVectors.map((v, i) => [v.id, errs[i]])),
      expected: smVectors.map((v) => ({
        id: v.id,
        label: v.label,
        points: geomPoints(v.geometry),
        slide:
          mode === '3D'
            ? geomPoints(v.geometry).map((p) => imageToPatient(smRef.plane, p))
            : undefined,
      })),
    });
  }
  const smSr = buildMeasurementReport({
    source: volume,
    items: smVectors.map((v) => ({ ...v, image: smRef, pixelSpacing: pixelSpacingOf(volume) })),
  });
  fs.writeFileSync(path.join(outDir, 'sr-sm-2d.dcm'), smSr.bytes);
  cases.push(
    srCase(
      'sr-sm-2d.dcm',
      'SR',
      '2d',
      smVectors,
      pixelSpacingOf(volume),
      readMeasurementReport(readPart10(smSr.bytes).dataset),
      smSr.bytes.length,
    ),
  );

  // Inputs the Python side needs to re-derive coordinates with highdicom.
  const withSamples = (plane, w, h) => {
    const samples = [
      { x: 0, y: 0 },
      { x: 0.5, y: 0.5 },
      { x: w, y: h },
      { x: w / 3 + 0.25, y: h / 7 + 0.75 },
      { x: 1, y: 0 },
      { x: 0, y: 1 },
    ];
    return { ...plane, samples, ours: samples.map((p) => [...imageToPatient(plane, p)]) };
  };
  const planes = {
    'ct-slice-a': withSamples(ctRefA.plane, cols, rows),
    'mr-oblique': withSamples(mrRef.plane, mrRef.columns, mrRef.rows),
    'sm-volume-slide': withSamples(readSlidePlane(volume), tpm.columns, tpm.rows),
  };
  return { cases, timings, planes, sources: { ct: ct.map((c) => c.f), sm: smRef.sopInstanceUid } };
}

function srCase(file, kind, mode, vectors, spacing, back, bytes) {
  const per = {};
  let maxCoord = 0;
  let maxRel = 0;
  let typesPreserved = 0;
  for (const v of vectors) {
    const g = back.find((x) => x.trackingIdentifier === v.label);
    if (!g || !g.geometry) {
      per[v.id] = { missing: true };
      maxCoord = Infinity;
      continue;
    }
    const e = maxPointError(v.geometry, g.geometry);
    maxCoord = Math.max(maxCoord, e);
    if (g.geometry.type === v.geometry.type) typesPreserved++;
    const ms = measurementsFor(v.geometry, spacing);
    const rel = ms.map((m) => {
      const r = g.measurements.find((x) => x.name === m.concept.meaning);
      return r ? Math.abs(r.value - m.value) / Math.max(Math.abs(m.value), 1e-12) : Infinity;
    });
    const mr = rel.length ? Math.max(...rel) : 0;
    maxRel = Math.max(maxRel, mr);
    per[v.id] = {
      type: g.geometry.type,
      template: g.template,
      coordErrorPx: e,
      measurementRelError: mr,
    };
  }
  return {
    file,
    kind,
    mode,
    bytes,
    shapes: vectors.length,
    typesPreserved,
    maxCoordErrorPx: maxCoord,
    maxMeasurementRelError: maxRel,
    perShape: per,
    expected: vectors.map((v) => ({
      id: v.id,
      label: v.label,
      type: v.geometry.type,
      points: geomPoints(v.geometry),
      measurements: measurementsFor(v.geometry, spacing).map((m) => ({
        name: m.concept.meaning,
        value: m.value,
        unit: m.unit.value,
      })),
    })),
  };
}

function segCase(file, masks, built) {
  const back = readSegmentation(readPart10(built.bytes).dataset, segPixelData(built.bytes));
  const seg = back[0];
  const per = masks.map((m) => {
    const got = seg?.masks.get(m.image.sopInstanceUid);
    return {
      sopInstanceUid: m.image.sopInstanceUid,
      pixels: snapshotPixelCount(m.snapshot),
      pixelsBack: got ? snapshotPixelCount(got) : 0,
      hash: maskHash(m.snapshot),
      hashBack: got ? maskHash(got) : null,
      bbox: [m.snapshot.x, m.snapshot.y, m.snapshot.width, m.snapshot.height],
    };
  });
  return {
    file,
    kind: 'SEG',
    mode: 'BINARY',
    bytes: built.bytes.length,
    frames: built.frameCount,
    exact: per.every((p) => p.hash === p.hashBack),
    perMask: per,
  };
}

function segPixelData(bytes) {
  const f = readPart10(bytes);
  const px = f.pixelData;
  return bytes.subarray(px.offset, px.offset + px.length);
}
