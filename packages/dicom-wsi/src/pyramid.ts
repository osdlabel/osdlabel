import type { PixelSpacing } from '@osdlabel/viewer-api';
import type { DicomDataset, PlaneGeometry } from '@osdlabel/dicom';
import { derivePixelSpacing, item, num, readSlidePlane, str, TAGS } from '@osdlabel/dicom';

/** One resolution level: a VOLUME instance of a VL Whole Slide Microscopy series. */
export interface WsiLevel {
  readonly sopInstanceUid: string;
  readonly sopClassUid: string;
  /** Total Pixel Matrix size. */
  readonly width: number;
  readonly height: number;
  /** Frame (tile) size: Columns × Rows. */
  readonly tileWidth: number;
  readonly tileHeight: number;
  readonly tilesAcross: number;
  readonly tilesDown: number;
  readonly frameCount: number;
  readonly transferSyntaxUid: string | undefined;
  readonly photometric: string;
  readonly samplesPerPixel: number;
  readonly organization: 'TILED_FULL' | 'TILED_SPARSE';
  /** TILED_SPARSE only: `"col,row"` (0-based tile indices) → 1-based frame number. */
  readonly sparseFrames: ReadonlyMap<string, number> | undefined;
  readonly pixelSpacing: PixelSpacing | undefined;
  /** Downsample relative to the base level (≥ 1, not necessarily a power of two). */
  readonly downsample: number;
}

export interface WsiPyramid {
  /** Ascending resolution: `levels[0]` is the smallest, the last is the base (full resolution). */
  readonly levels: readonly WsiLevel[];
  readonly width: number;
  readonly height: number;
  readonly pixelSpacing: PixelSpacing | undefined;
  /** Slide coordinate system of the base level (for 3D export). */
  readonly slidePlane: PlaneGeometry | undefined;
  readonly frameOfReferenceUid: string | undefined;
  /** Non-pyramid images in the series, by Image Type value 3. */
  readonly associated: Readonly<Record<string, string>>;
  readonly notes: readonly string[];
}

export interface PyramidInstance {
  readonly dataset: DicomDataset;
  /** From the file meta (Part 10) or the DICOMweb metadata (0002,0010) when present. */
  readonly transferSyntaxUid?: string | undefined;
}

/**
 * Describes a WSI series as a pyramid of tiled levels — the part of "DICOM
 * WSI" OpenSeadragon needs. Only VOLUME images with one optical path and one
 * focal plane are levels; LABEL / OVERVIEW / THUMBNAIL are reported as
 * associated images. Levels need not be 2× apart (IDC's are typically 4×),
 * which the tile source handles by reporting each level's true scale.
 */
export function describePyramid(instances: readonly PyramidInstance[]): WsiPyramid {
  const notes: string[] = [];
  const associated: Record<string, string> = {};
  const levels: WsiLevel[] = [];
  for (const { dataset: ds, transferSyntaxUid } of instances) {
    const type = ds.strings(TAGS.ImageType.tag) ?? [];
    const flavor = type[2] ?? 'UNKNOWN';
    const uid = str(ds, TAGS.SOPInstanceUID.tag) ?? '';
    if (flavor !== 'VOLUME') {
      associated[flavor] = uid;
      continue;
    }
    const focal = num(ds, TAGS.TotalPixelMatrixFocalPlanes.tag) ?? 1;
    const paths =
      num(ds, TAGS.NumberOfOpticalPaths.tag) ??
      ds.sequence(TAGS.OpticalPathSequence.tag)?.length ??
      1;
    if (focal !== 1 || paths !== 1) {
      notes.push(
        `${uid}: ${focal} focal planes × ${paths} optical paths — PoC renders the first only`,
      );
    }
    const width = num(ds, TAGS.TotalPixelMatrixColumns.tag) ?? num(ds, TAGS.Columns.tag) ?? 0;
    const height = num(ds, TAGS.TotalPixelMatrixRows.tag) ?? num(ds, TAGS.Rows.tag) ?? 0;
    const tileWidth = num(ds, TAGS.Columns.tag) ?? 0;
    const tileHeight = num(ds, TAGS.Rows.tag) ?? 0;
    const organization =
      str(ds, TAGS.DimensionOrganizationType.tag) === 'TILED_FULL' ? 'TILED_FULL' : 'TILED_SPARSE';
    let sparseFrames: Map<string, number> | undefined;
    if (organization === 'TILED_SPARSE') {
      sparseFrames = new Map();
      const perFrame = ds.sequence(TAGS.PerFrameFunctionalGroupsSequence.tag) ?? [];
      perFrame.forEach((fg, i) => {
        const pos = item(fg, TAGS.PlanePositionSlideSequence.tag);
        const c = pos && num(pos, TAGS.ColumnPositionInTotalImagePixelMatrix.tag);
        const r = pos && num(pos, TAGS.RowPositionInTotalImagePixelMatrix.tag);
        if (c !== undefined && r !== undefined) {
          // Positions are 1-based pixel offsets of the tile's top-left.
          sparseFrames!.set(`${(c - 1) / tileWidth},${(r - 1) / tileHeight}`, i + 1);
        }
      });
      if (sparseFrames.size === 0)
        notes.push(`${uid}: TILED_SPARSE without Plane Position (Slide)`);
    }
    levels.push({
      sopInstanceUid: uid,
      sopClassUid: str(ds, TAGS.SOPClassUID.tag) ?? '',
      width,
      height,
      tileWidth,
      tileHeight,
      tilesAcross: Math.ceil(width / tileWidth),
      tilesDown: Math.ceil(height / tileHeight),
      frameCount: num(ds, TAGS.NumberOfFrames.tag) ?? 1,
      transferSyntaxUid,
      photometric: str(ds, TAGS.PhotometricInterpretation.tag) ?? 'RGB',
      samplesPerPixel: num(ds, TAGS.SamplesPerPixel.tag) ?? 3,
      organization,
      sparseFrames,
      pixelSpacing: derivePixelSpacing(ds)?.spacing,
      downsample: 1,
    });
  }
  levels.sort((a, b) => a.width - b.width);
  const base = levels[levels.length - 1];
  if (!base) throw new Error('no VOLUME images in the series');
  const withDownsample = levels.map((l) => ({ ...l, downsample: base.width / l.width }));
  const ratios = withDownsample.map((l) => l.downsample);
  if (ratios.some((r) => Math.abs(Math.log2(r) - Math.round(Math.log2(r))) > 0.01)) {
    notes.push('levels are not powers of two apart');
  }
  const baseDs = instances.find(
    (i) => str(i.dataset, TAGS.SOPInstanceUID.tag) === base.sopInstanceUid,
  )!.dataset;
  return {
    levels: withDownsample,
    width: base.width,
    height: base.height,
    pixelSpacing: base.pixelSpacing,
    slidePlane: readSlidePlane(baseDs),
    frameOfReferenceUid: str(baseDs, TAGS.FrameOfReferenceUID.tag),
    associated,
    notes,
  };
}

/**
 * 1-based frame number of tile (`col`, `row`) of a level, or `undefined` for a
 * tile a TILED_SPARSE level does not store. TILED_FULL frames run row-major
 * over the Total Pixel Matrix (then focal planes, then optical paths).
 */
export function frameNumberFor(level: WsiLevel, col: number, row: number): number | undefined {
  if (col < 0 || row < 0 || col >= level.tilesAcross || row >= level.tilesDown) return undefined;
  if (level.organization === 'TILED_FULL') return row * level.tilesAcross + col + 1;
  return level.sparseFrames?.get(`${col},${row}`);
}
