/**
 * H3, the other direction: read DICOM written by others (dcmqi SEG and
 * TID 1500 SR from LIDC-IDRI, QIBA objects, and IDC's pan-cancer nuclei
 * Microscopy Bulk Simple Annotations) into osdlabel shapes with
 * @osdlabel/dicom-export's readers. The Python side reads the same files with
 * highdicom/pydicom so the bench can compare.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readPart10, TAGS } from '@osdlabel/dicom';
import {
  readBulkAnnotations,
  readMeasurementReport,
  readSegmentation,
} from '@osdlabel/dicom-export';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function thirdPartyFiles(dataDir) {
  return fs
    .readdirSync(dataDir)
    .filter((r) => r.startsWith('3p-'))
    .flatMap((r) =>
      fs
        .readdirSync(path.join(dataDir, r))
        .filter((f) => f.endsWith('.dcm'))
        .map((f) => ({ role: r, path: path.join(dataDir, r, f) })),
    );
}

export function runInterop(dataDir) {
  const out = {};
  for (const { role, path: p } of thirdPartyFiles(dataDir)) {
    const bytes = new Uint8Array(fs.readFileSync(p));
    const t0 = performance.now();
    const file = readPart10(bytes);
    const parseMs = performance.now() - t0;
    const ds = file.dataset;
    const modality = ds.strings(TAGS.Modality.tag)?.[0];
    const rec = {
      role,
      file: path.basename(p),
      bytes: bytes.length,
      modality,
      creator: ds.strings(TAGS.Manufacturer.tag)?.[0] ?? null,
      parseMs: +parseMs.toFixed(2),
    };
    try {
      if (modality === 'SEG') {
        const px = file.pixelData;
        const t1 = performance.now();
        const segs = readSegmentation(ds, bytes.subarray(px.offset, px.offset + px.length));
        rec.readMs = +(performance.now() - t1).toFixed(2);
        rec.segmentationType = ds.strings(TAGS.SegmentationType.tag)?.[0];
        rec.frames = ds.numbers(TAGS.NumberOfFrames.tag)?.[0];
        rec.segments = segs.map((s) => ({
          number: s.segmentNumber,
          label: s.label,
          sources: s.masks.size,
          pixels: [...s.masks.values()].reduce((n, m) => n + m.data.reduce((a, b) => a + b, 0), 0),
        }));
      } else if (modality === 'SR') {
        const t1 = performance.now();
        const groups = readMeasurementReport(ds);
        rec.readMs = +(performance.now() - t1).toFixed(2);
        rec.template =
          ds
            .sequence(TAGS.ContentTemplateSequence.tag)?.[0]
            ?.strings(TAGS.TemplateIdentifier.tag)?.[0] ?? null;
        rec.groups = groups.length;
        rec.measurements = groups.flatMap((g) =>
          g.measurements.map((m) => [m.name, m.value, m.unit]),
        );
        rec.groupsWithGeometry = groups.filter((g) => g.geometry).length;
        rec.groupTemplates = [...new Set(groups.map((g) => g.template))];
      } else if (modality === 'ANN') {
        const t1 = performance.now();
        const groups = readBulkAnnotations(ds);
        rec.readMs = +(performance.now() - t1).toFixed(2);
        rec.coordinateType = ds.strings(TAGS.AnnotationCoordinateType.tag)?.[0];
        rec.groups = groups.map((g) => ({
          label: g.label,
          graphicType: g.graphicType,
          count: g.geometries.length,
        }));
        rec.shapes = groups.reduce((n, g) => n + g.geometries.length, 0);
        // How heavy is that as osdlabel geometry objects? (separate process, forced GC)
        rec.heap = annHeapProbe(p);
      }
      rec.ok = true;
    } catch (err) {
      rec.ok = false;
      rec.error = String(err?.message ?? err).slice(0, 300);
    }
    out[role] = rec;
  }
  return out;
}

/**
 * Compares what @osdlabel/dicom-export read (runInterop) with what highdicom
 * read from the same files (validate.py --files): segment foreground pixel
 * counts, ANN group (label, graphic type, count), SR (name, value, unit).
 */
export function compareInterop(ours, hd) {
  const out = {};
  for (const [role, r] of Object.entries(ours)) {
    const h = hd?.files?.[r.file];
    if (!h) {
      out[role] = { compared: false, reason: 'no highdicom result' };
      continue;
    }
    const base = {
      creator: r.creator,
      sopClass: h.sop_class,
      dciodvfyErrors: h.dciodvfy?.errors?.length ?? null,
      dciodvfyWarnings: h.dciodvfy?.warnings?.length ?? null,
      highdicomOk: h.highdicom_ok,
    };
    if (!h.highdicom_ok) {
      out[role] = {
        ...base,
        compared: false,
        reason: h.highdicom_error,
        oursGroups: r.ok ? (r.groups ?? null) : r.error,
      };
      continue;
    }
    let agree = false;
    let detail = null;
    if (r.modality === 'SEG') {
      const theirs = h.highdicom.pixelsPerSegment;
      detail = r.segments.map((s) => ({
        segment: s.number,
        ours: s.pixels,
        highdicom: theirs[String(s.number)] ?? null,
      }));
      agree =
        detail.every((d) => d.ours === d.highdicom) &&
        r.segments.length === h.highdicom.segments.length;
    } else if (r.modality === 'ANN') {
      const theirs = h.highdicom.groups
        .map(([label, gt, count]) => `${label}|${gt}|${count}`)
        .sort();
      const mine = r.groups.map((g) => `${g.label}|${g.graphicType}|${g.count}`).sort();
      detail = { ours: mine, highdicom: theirs };
      agree = JSON.stringify(mine) === JSON.stringify(theirs);
    } else if (r.modality === 'SR') {
      const key = (m) => `${m[0]}|${(+m[1]).toPrecision(9)}|${m[2]}`;
      const theirs = h.highdicom.measurements.map(key).sort();
      const mine = r.measurements.map(key).sort();
      detail = { ours: mine, highdicom: theirs };
      agree = JSON.stringify(mine) === JSON.stringify(theirs);
    }
    out[role] = { ...base, compared: true, agree, detail };
  }
  return out;
}

function annHeapProbe(file) {
  try {
    const res = execFileSync(
      process.execPath,
      ['--expose-gc', path.join(HERE, 'ann-heap-probe.mjs'), file],
      { encoding: 'utf8' },
    );
    return JSON.parse(res);
  } catch (err) {
    return { error: String(err.message).slice(0, 200) };
  }
}
