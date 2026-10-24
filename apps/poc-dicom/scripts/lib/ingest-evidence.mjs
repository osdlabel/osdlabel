/**
 * H1 evidence: what @osdlabel/dicom derives from each real IDC series, and
 * how many header bytes a client needs before the pixels start.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  readPart10,
  describeInstance,
  buildStack,
  readPlaneGeometry,
  toImageSources,
  TAGS,
} from '@osdlabel/dicom';

const r3 = (x) => (typeof x === 'number' ? +x.toPrecision(6) : x);

export function ingestEvidence(dataDir, manifest) {
  const out = {};
  for (const s of manifest.series) {
    const dir = path.join(dataDir, s.role);
    if (!fs.existsSync(dir)) continue;
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.dcm'))
      .sort();
    const parsed = files.map((f) => {
      const bytes = new Uint8Array(fs.readFileSync(path.join(dir, f)));
      const head = readPart10(bytes, { untilTag: TAGS.PixelData.tag });
      return { f, bytes: bytes.length, head };
    });
    // Representative instance: the largest (the WSI base level, the multi-frame US…).
    const rep = [...parsed].sort((a, b) => b.bytes - a.bytes)[0];
    const d = describeInstance(rep.head.dataset);
    const ps = d.pixelSpacing;
    const entry = {
      collection: s.collection_id,
      license: s.license,
      modality: d.modality,
      transferSyntax: rep.head.transferSyntaxUid,
      instances: parsed.length,
      rows: d.rows,
      columns: d.columns,
      frames: d.frames,
      headerBytes: rep.head.pixelData ? rep.head.pixelData.offset : rep.head.bytesRead,
      fileBytes: rep.bytes,
      truncatedFetch: rep.head.truncated,
      pixelSpacing: ps
        ? {
            x: r3(ps.spacing.x),
            y: r3(ps.spacing.y),
            unit: ps.spacing.unit,
            source: ps.source,
            plane: ps.plane,
            alternatives: ps.alternatives.map((a) => `${a.source}@${a.plane}=${r3(a.spacing.x)}`),
            notes: ps.notes,
          }
        : null,
      display: {
        photometric: d.display.photometric,
        bitsStored: d.display.bitsStored,
        signed: d.display.signed,
        invert: d.display.invert,
        rescale: d.display.rescale,
        windows: d.display.windows,
        voiFunction: d.display.voiFunction,
        voiLuts: d.display.voiLuts.length,
        defaultVoi: d.display.defaultVoi.kind,
        notes: d.display.notes,
      },
      timing: {
        axis: d.timing.axis,
        dimensions: d.timing.dimensions,
        incrementPointer: d.timing.incrementPointer,
        acquisitionFps: d.timing.acquisitionFps && r3(d.timing.acquisitionFps),
        playbackFps: d.timing.playbackFps && r3(d.timing.playbackFps),
        frames: d.timing.frameCount,
        notes: d.timing.notes,
      },
      ultrasoundRegions: d.ultrasoundRegions.map((r) => ({
        bounds: [r.x0, r.y0, r.x1, r.y1],
        format: r.spatialFormat,
        dataType: r.dataType,
        x: `${r3(r.x.perPixel)} ${r.x.unit}/px`,
        y: `${r3(r.y.perPixel)} ${r.y.unit}/px`,
      })),
      plane: d.plane
        ? {
            oblique: !d.plane.normal.some((n) => Math.abs(Math.abs(n) - 1) < 1e-6),
            frameOfReference: !!d.plane.frameOfReferenceUid,
          }
        : null,
    };
    if (parsed.length > 1 && parsed.every((p) => readPlaneGeometry(p.head.dataset))) {
      const stack = buildStack(
        parsed.map((p) => p.head.dataset),
        (ds) => readPlaneGeometry(ds),
      );
      const gaps = stack.gaps;
      entry.stack = {
        slices: stack.slices.length,
        uniform: stack.uniform,
        sameOrientation: stack.sameOrientation,
        minGap: gaps.length ? r3(Math.min(...gaps)) : null,
        maxGap: gaps.length ? r3(Math.max(...gaps)) : null,
        notes: stack.notes,
      };
      const sources = toImageSources(
        parsed.map((p) => p.head.dataset),
        { tileSource: () => 'about:blank' },
      );
      entry.imageSources = sources.length;
      // Ordering by Instance Number would differ from geometric order?
      const byInstance = [...parsed]
        .sort(
          (a, b) =>
            (a.head.dataset.numbers(TAGS.InstanceNumber.tag)?.[0] ?? 0) -
            (b.head.dataset.numbers(TAGS.InstanceNumber.tag)?.[0] ?? 0),
        )
        .map((p) => p.head.dataset.strings(TAGS.SOPInstanceUID.tag)?.[0]);
      const geometric = sources.map((x) => x.id);
      const reversed = [...geometric].reverse();
      entry.stack.instanceNumberOrder =
        JSON.stringify(byInstance) === JSON.stringify(geometric)
          ? 'same'
          : JSON.stringify(byInstance) === JSON.stringify(reversed)
            ? 'reversed'
            : 'different';
    }
    out[s.role] = entry;
  }
  return out;
}
