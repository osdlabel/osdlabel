/**
 * The three JS readers under comparison, each wrapped to answer the same
 * question: "parse this Part 10 file and give me the attributes the adapter
 * maps". Field names follow scripts/py/truth.py.
 */
import dicomParser from 'dicom-parser';
import dcmjs from 'dcmjs';
import { readPart10, TAGS } from '@osdlabel/dicom';

export const FIELDS = [
  'SOPInstanceUID',
  'Modality',
  'Rows',
  'Columns',
  'NumberOfFrames',
  'PhotometricInterpretation',
  'BitsAllocated',
  'BitsStored',
  'PixelRepresentation',
  'SamplesPerPixel',
  'PixelSpacing',
  'ImagerPixelSpacing',
  'WindowCenter',
  'WindowWidth',
  'RescaleSlope',
  'RescaleIntercept',
  'ImagePositionPatient',
  'ImageOrientationPatient',
  'FrameTime',
  'CineRate',
  'TotalPixelMatrixColumns',
  'TotalPixelMatrixRows',
];

const STRING_FIELDS = new Set(['SOPInstanceUID', 'Modality', 'PhotometricInterpretation']);
const BINARY_US = new Set([
  'Rows',
  'Columns',
  'BitsAllocated',
  'BitsStored',
  'PixelRepresentation',
  'SamplesPerPixel',
]);
const BINARY_UL = new Set(['TotalPixelMatrixColumns', 'TotalPixelMatrixRows']);

function normalise(v) {
  if (v === undefined || v === null) return undefined;
  if (Array.isArray(v)) {
    const out = v.map(normalise);
    return out.length === 1 ? out[0] : out;
  }
  if (typeof v === 'number') return v;
  const n = Number(v);
  return Number.isFinite(n) &&
    String(v).trim() !== '' &&
    !String(v).includes('.', String(v).indexOf('.') + 1)
    ? n
    : String(v);
}

// ── own (@osdlabel/dicom) ──────────────────────────────────────────────────
export const own = {
  name: '@osdlabel/dicom',
  parse(bytes, headerOnly) {
    return readPart10(bytes, headerOnly ? { untilTag: TAGS.PixelData.tag } : {});
  },
  extract(file) {
    const ds = file.dataset;
    const rec = {};
    for (const f of FIELDS) {
      const tag = TAGS[f].tag;
      if (!ds.has(tag)) continue;
      rec[f] = STRING_FIELDS.has(f) ? normalise(ds.strings(tag)) : normalise(ds.numbers(tag));
    }
    const shared = ds.sequence(TAGS.SharedFunctionalGroupsSequence.tag)?.[0];
    const pm = shared?.sequence(TAGS.PixelMeasuresSequence.tag)?.[0];
    const sps = pm?.numbers(TAGS.PixelSpacing.tag);
    if (sps) rec.SharedPixelSpacing = normalise(sps);
    const regions = ds.sequence(TAGS.SequenceOfUltrasoundRegions.tag);
    if (regions) {
      rec.UltrasoundRegionDeltas = regions.map((r) => [
        r.numbers(TAGS.PhysicalDeltaX.tag)?.[0],
        r.numbers(TAGS.PhysicalDeltaY.tag)?.[0],
      ]);
    }
    return rec;
  },
};

// ── dicom-parser ───────────────────────────────────────────────────────────
const hex = (tag) => 'x' + (tag >>> 0).toString(16).padStart(8, '0');
export const dicomParserReader = {
  name: 'dicom-parser',
  parse(bytes, headerOnly) {
    return dicomParser.parseDicom(bytes, headerOnly ? { untilTag: 'x7fe00010' } : {});
  },
  /** dicom-parser's documented partial result: it throws `{ exception, dataSet }`. */
  recover(err) {
    return err && typeof err === 'object' && 'dataSet' in err && err.dataSet
      ? err.dataSet
      : undefined;
  },
  extract(ds) {
    const rec = {};
    for (const f of FIELDS) {
      const t = hex(TAGS[f].tag);
      if (!ds.elements[t]) continue;
      if (STRING_FIELDS.has(f)) rec[f] = normalise(ds.string(t));
      else if (BINARY_US.has(f)) rec[f] = ds.uint16(t);
      else if (BINARY_UL.has(f)) rec[f] = ds.uint32(t);
      else {
        const n = ds.numStringValues(t) ?? 0;
        const vals = [];
        for (let i = 0; i < n; i++) vals.push(ds.floatString(t, i));
        rec[f] = normalise(vals);
      }
    }
    const shared = ds.elements[hex(TAGS.SharedFunctionalGroupsSequence.tag)]?.items?.[0]?.dataSet;
    const pm = shared?.elements[hex(TAGS.PixelMeasuresSequence.tag)]?.items?.[0]?.dataSet;
    if (pm?.elements[hex(TAGS.PixelSpacing.tag)]) {
      const t = hex(TAGS.PixelSpacing.tag);
      rec.SharedPixelSpacing = [pm.floatString(t, 0), pm.floatString(t, 1)];
    }
    const regions = ds.elements[hex(TAGS.SequenceOfUltrasoundRegions.tag)]?.items;
    if (regions) {
      rec.UltrasoundRegionDeltas = regions.map((it) => [
        it.dataSet.double(hex(TAGS.PhysicalDeltaX.tag)),
        it.dataSet.double(hex(TAGS.PhysicalDeltaY.tag)),
      ]);
    }
    return rec;
  },
};

// ── dcmjs ──────────────────────────────────────────────────────────────────
const { DicomMessage, DicomMetaDictionary } = dcmjs.data;
// dcmjs logs every recovered oddity (e.g. 'Invalid vr type ox'); keep the bench output readable.
dcmjs.log.setLevel('error');
export const dcmjsReader = {
  name: 'dcmjs',
  parse(bytes, headerOnly) {
    // dcmjs wants an ArrayBuffer of exactly the file.
    const ab =
      bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
        ? bytes.buffer
        : bytes.slice().buffer;
    const msg = DicomMessage.readFile(
      ab,
      headerOnly
        ? { untilTag: '7FE00010', includeUntilTagValue: false, ignoreErrors: true }
        : { ignoreErrors: true },
    );
    return DicomMetaDictionary.naturalizeDataset(msg.dict);
  },
  extract(ds) {
    const rec = {};
    for (const f of FIELDS) {
      if (ds[f] === undefined || ds[f] === null || ds[f] === '') continue;
      rec[f] = normalise(ds[f]);
    }
    const shared = ds.SharedFunctionalGroupsSequence;
    const sharedItem = Array.isArray(shared) ? shared[0] : shared;
    const pmSeq = sharedItem?.PixelMeasuresSequence;
    const pm = Array.isArray(pmSeq) ? pmSeq[0] : pmSeq;
    if (pm?.PixelSpacing) rec.SharedPixelSpacing = normalise(pm.PixelSpacing);
    const regionsRaw = ds.SequenceOfUltrasoundRegions;
    const regions =
      regionsRaw === undefined ? undefined : Array.isArray(regionsRaw) ? regionsRaw : [regionsRaw];
    if (regions)
      rec.UltrasoundRegionDeltas = regions.map((r) => [r.PhysicalDeltaX, r.PhysicalDeltaY]);
    return rec;
  },
};

export const READERS = [own, dicomParserReader, dcmjsReader];

/** Compares a reader's record with pydicom's; returns the mismatching fields. */
export function compareWithTruth(rec, truth) {
  const mismatches = [];
  const keys = new Set([...Object.keys(truth)]);
  for (const k of keys) {
    const a = norm(rec[k]);
    const b = norm(truth[k]);
    if (!same(a, b)) mismatches.push({ field: k, got: a, expected: b });
  }
  return mismatches;
}

function norm(v) {
  if (Array.isArray(v)) return v.length === 1 ? norm(v[0]) : v.map(norm);
  return v;
}

function same(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => same(x, b[i]));
  }
  if (typeof a === 'number' && typeof b === 'number')
    return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));
  if (typeof a === 'number' && typeof b === 'string') return String(a) === b;
  if (typeof b === 'number' && typeof a === 'string') return Number(a) === b;
  return a === b;
}
