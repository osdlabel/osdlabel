/**
 * Header survey: how often does each mapping path occur in real public data?
 *
 *   node scripts/survey.mjs [--bytes 131072] [--concurrency 8]
 *
 * For every instance in survey-manifest.json (400 instances, 10 modalities,
 * ~120 IDC collections, CC BY), fetch only the first N bytes with an HTTP
 * Range request, parse with @osdlabel/dicom (truncated input is expected) and
 * run the same mapping the adapter uses. Writes results/survey.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPart10, describeInstance, readUltrasoundRegions, TAGS } from '@osdlabel/dicom';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : Number(process.argv[i + 1]);
}

async function fetchHead(url, bytes) {
  for (let i = 0; i < 4; i++) {
    try {
      const t0 = performance.now();
      const res = await fetch(url, { headers: { Range: `bytes=0-${bytes - 1}` } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = new Uint8Array(await res.arrayBuffer());
      const size = Number(
        /\/(\d+)$/.exec(res.headers.get('content-range') ?? '')?.[1] ?? buf.length,
      );
      return { buf, size, ms: performance.now() - t0 };
    } catch (err) {
      if (i === 3) throw err;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
    }
  }
  throw new Error('unreachable');
}

export async function runSurvey({ bytes = 131072, concurrency = 8 } = {}) {
  const manifest = JSON.parse(fs.readFileSync(path.join(APP, 'survey-manifest.json'), 'utf8'));
  const rows = [];
  const queue = [...manifest.items];
  const worker = async () => {
    for (let it = queue.shift(); it; it = queue.shift()) {
      const row = {
        modality: it.modality,
        collection: it.collection_id,
        manufacturer: it.manufacturer,
      };
      try {
        // Grow the Range ×4 until the header (everything before Pixel Data)
        // is complete — what a static-hosting client would have to do.
        let want = bytes;
        let got;
        let file;
        let requests = 0;
        let fetchMs = 0;
        let parseMs = 0;
        for (;;) {
          got = await fetchHead(`${manifest.base_url}/${it.key}`, want);
          requests++;
          fetchMs += got.ms;
          const t0 = performance.now();
          file = readPart10(got.buf, { untilTag: TAGS.PixelData.tag });
          parseMs = performance.now() - t0;
          const complete = !file.truncated || !!file.pixelData || got.buf.length >= got.size;
          if (complete || want >= 64 * 1024 * 1024) break;
          want *= 4;
        }
        row.fetchMs = +fetchMs.toFixed(1);
        row.rangeRequests = requests;
        row.fileBytes = got.size;
        row.parseMs = +parseMs.toFixed(3);
        row.headerComplete = !file.truncated || !!file.pixelData;
        row.rangeBytes = got.buf.length;
        row.headerBytes = file.pixelData ? file.pixelData.offset : null;
        const ds = file.dataset;
        const d = describeInstance(ds);
        row.ts = file.transferSyntaxUid;
        row.photometric = d.display.photometric;
        row.spacingSource = d.pixelSpacing?.source ?? null;
        row.spacingPlane = d.pixelSpacing?.plane ?? null;
        row.spacingAlternatives = d.pixelSpacing?.alternatives.length ?? 0;
        row.hasImagerPixelSpacing = ds.has(TAGS.ImagerPixelSpacing.tag);
        row.hasERMF = ds.has(TAGS.EstimatedRadiographicMagnificationFactor.tag);
        row.hasCalibrationType = ds.has(TAGS.PixelSpacingCalibrationType.tag);
        row.windows = d.display.windows.length;
        row.voiFunction = d.display.voiFunction;
        row.voiLuts = d.display.voiLuts.length;
        row.modalityLut = !!d.display.modalityLut;
        row.invert = d.display.invert;
        row.presentationLutShape = ds.strings(TAGS.PresentationLUTShape.tag)?.[0] ?? null;
        row.frames = d.frames;
        row.frameAxis = d.timing.axis;
        row.frameTime = ds.has(TAGS.FrameTime.tag);
        row.enhanced = ds.has(TAGS.SharedFunctionalGroupsSequence.tag);
        row.plane = !!d.plane;
        const regions = readUltrasoundRegions(ds);
        row.usRegions = regions.length;
        row.usRegionUnits = regions.map((r) => `${r.x.unit}x${r.y.unit}`);
        row.usDistinctSpatialCalibrations = new Set(
          regions
            .filter((r) => r.x.unit === 'cm')
            .map((r) => `${r.x.perPixel.toFixed(6)}/${r.y.perPixel.toFixed(6)}`),
        ).size;
        row.ok = true;
      } catch (err) {
        row.ok = false;
        row.error = String(err?.message ?? err).slice(0, 200);
      }
      rows.push(row);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return { bytes, rows, summary: summarise(rows) };
}

const pct = (n, d) => (d ? +((100 * n) / d).toFixed(1) : 0);

export function summarise(rows) {
  const by = {};
  for (const r of rows) (by[r.modality] ??= []).push(r);
  const out = {};
  for (const [m, rs] of Object.entries(by)) {
    const ok = rs.filter((r) => r.ok);
    const count = (f) => ok.filter(f).length;
    const sources = {};
    for (const r of ok)
      sources[`${r.spacingSource ?? 'none'}@${r.spacingPlane ?? '-'}`] =
        (sources[`${r.spacingSource ?? 'none'}@${r.spacingPlane ?? '-'}`] ?? 0) + 1;
    const axes = {};
    for (const r of ok) if (r.frames > 1) axes[r.frameAxis] = (axes[r.frameAxis] ?? 0) + 1;
    const units = {};
    for (const r of ok) for (const u of r.usRegionUnits ?? []) units[u] = (units[u] ?? 0) + 1;
    const hb = ok
      .map((r) => r.headerBytes)
      .filter((x) => x !== null)
      .sort((a, b) => a - b);
    out[m] = {
      n: rs.length,
      parsed: ok.length,
      headerComplete: count((r) => r.headerComplete),
      medianHeaderBytes: hb[hb.length >> 1] ?? null,
      maxHeaderBytes: hb[hb.length - 1] ?? null,
      maxRangeRequests: Math.max(...ok.map((r) => r.rangeRequests ?? 1)),
      spacing: sources,
      pctNoSpacing: pct(
        count((r) => !r.spacingSource),
        ok.length,
      ),
      pctImagerPixelSpacing: pct(
        count((r) => r.hasImagerPixelSpacing),
        ok.length,
      ),
      pctERMF: pct(
        count((r) => r.hasERMF),
        ok.length,
      ),
      pctCalibrationType: pct(
        count((r) => r.hasCalibrationType),
        ok.length,
      ),
      pctMultiWindow: pct(
        count((r) => r.windows > 1),
        ok.length,
      ),
      pctNoWindow: pct(
        count((r) => r.windows === 0),
        ok.length,
      ),
      pctNonLinearVoi: pct(
        count((r) => r.voiFunction !== 'LINEAR'),
        ok.length,
      ),
      pctVoiLut: pct(
        count((r) => r.voiLuts > 0),
        ok.length,
      ),
      pctModalityLut: pct(
        count((r) => r.modalityLut),
        ok.length,
      ),
      pctInvert: pct(
        count((r) => r.invert),
        ok.length,
      ),
      pctEnhanced: pct(
        count((r) => r.enhanced),
        ok.length,
      ),
      pctMultiFrame: pct(
        count((r) => r.frames > 1),
        ok.length,
      ),
      multiFrameAxes: axes,
      pctPlane: pct(
        count((r) => r.plane),
        ok.length,
      ),
      usRegions:
        m === 'US'
          ? {
              withRegions: count((r) => r.usRegions > 0),
              multiRegion: count((r) => r.usRegions > 1),
              multiCalibration: count((r) => r.usDistinctSpatialCalibrations > 1),
              units,
            }
          : undefined,
      errors: rs
        .filter((r) => !r.ok)
        .map((r) => r.error)
        .slice(0, 3),
    };
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const res = await runSurvey({
    bytes: arg('--bytes', 131072),
    concurrency: arg('--concurrency', 8),
  });
  fs.mkdirSync(path.join(APP, 'results'), { recursive: true });
  fs.writeFileSync(path.join(APP, 'results', 'survey.json'), JSON.stringify(res, null, 1));
  console.table(
    Object.fromEntries(
      Object.entries(res.summary).map(([m, s]) => [
        m,
        {
          n: s.n,
          ok: s.parsed,
          noSpacing: s.pctNoSpacing,
          IPS: s.pctImagerPixelSpacing,
          ERMF: s.pctERMF,
          multiWin: s.pctMultiWindow,
          noWin: s.pctNoWindow,
          nonLinVoi: s.pctNonLinearVoi,
          voiLut: s.pctVoiLut,
          invert: s.pctInvert,
          multiFrame: s.pctMultiFrame,
          enhanced: s.pctEnhanced,
          plane: s.pctPlane,
        },
      ]),
    ),
  );
  console.log(
    JSON.stringify(
      Object.fromEntries(
        Object.entries(res.summary).map(([m, s]) => [
          m,
          { spacing: s.spacing, axes: s.multiFrameAxes, us: s.usRegions, errors: s.errors },
        ]),
      ),
      null,
      1,
    ),
  );
}
