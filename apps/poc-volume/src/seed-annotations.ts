import type { Geometry, ToolType } from '@osdlabel/annotation';
import { orthogonalPlane, type PlaneFrame, type VolumeGrid } from '@osdlabel/spatial';

export interface SeedAnnotation {
  readonly geometry: Geometry;
  readonly toolType: ToolType;
  readonly plane: PlaneFrame;
}

/**
 * A fixed annotation set spread over planes so every view has cross-view
 * content: 8 axial polygons at increasing slices, 4 coronal circles and
 * 6 sagittal points on the mid-sagittal plane.
 */
export function seedAnnotations(g: VolumeGrid): SeedAnnotation[] {
  const [nx, ny, nz] = g.dimensions;
  const out: SeedAnnotation[] = [];
  for (let i = 0; i < 8; i++) {
    const k = Math.round(nz * (0.3 + i * 0.05));
    const cx = nx * (0.35 + 0.04 * i);
    const cy = ny * 0.45;
    const r = nx * 0.08;
    const points = Array.from({ length: 7 }, (_, j) => ({
      x: cx + r * Math.cos((j / 7) * 2 * Math.PI),
      y: cy + r * Math.sin((j / 7) * 2 * Math.PI) * (j % 2 ? 0.7 : 1),
    }));
    out.push({
      geometry: { type: 'polygon', points },
      toolType: 'polyline',
      plane: orthogonalPlane(g, 'axial', k),
    });
  }
  for (let i = 0; i < 4; i++) {
    const cor = orthogonalPlane(g, 'coronal', Math.round(ny * (0.4 + 0.05 * i)));
    out.push({
      geometry: {
        type: 'circle',
        center: { x: cor.width * 0.5, y: cor.height * (0.4 + 0.05 * i) },
        radius: 30,
      },
      toolType: 'circle',
      plane: cor,
    });
  }
  for (let i = 0; i < 6; i++) {
    const sag = orthogonalPlane(g, 'sagittal', Math.round(nx * 0.5));
    out.push({
      geometry: {
        type: 'point',
        position: { x: sag.width * (0.3 + 0.08 * i), y: sag.height * 0.5 },
      },
      toolType: 'point',
      plane: sag,
    });
  }
  return out;
}
