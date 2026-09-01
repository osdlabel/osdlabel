import { Circle } from 'fabric';
import type { AnnotationStyle, Point } from '@osdlabel/annotation';
import type { ToolOverlay } from './types.js';

/** Radius (screen px) of an ordinary in-progress vertex marker. */
export const DEFAULT_VERTEX_MARKER_RADIUS_PX = 3;
/** Radius (screen px) of the first vertex — the close target, so it is larger. */
export const DEFAULT_FIRST_VERTEX_MARKER_RADIUS_PX = 5;
/** Stroke width (screen px) of the first vertex ring. */
const FIRST_VERTEX_STROKE_PX = 2;

/** Appearance of the vertex markers drawn while a poly shape is being drawn. */
export interface VertexMarkerOptions {
  /** Set false to draw no markers at all. Default true. */
  readonly enabled?: boolean;
  /** Radius of an ordinary vertex, in screen pixels. */
  readonly radius?: number;
  /** Radius of the first vertex, in screen pixels. */
  readonly firstRadius?: number;
  /** Colour of ordinary vertices. Defaults to the resolved style's `strokeColor`. */
  readonly color?: string;
  /** Colour of the first vertex. Defaults to {@link VertexMarkerOptions.color}. */
  readonly firstColor?: string;
}

/**
 * Draws a marker per committed vertex while a poly shape is in progress.
 *
 * Without these there is no feedback that a click registered, and — more
 * importantly — the first vertex is invisible even though clicking within
 * `CLOSE_THRESHOLD_SCREEN_PX` of it is the only way to finish a *closed*
 * polygon. The first vertex is therefore drawn distinctly (a larger ring) and
 * fills in solid once the pointer is close enough for a click to close the
 * shape.
 *
 * Markers are pure chrome: they carry no `id` (reserved for annotation objects)
 * and are flagged `_readOnly` so `FabricOverlay.setMode` keeps them inert.
 * Radii are expressed in screen pixels and converted to image space on every
 * sync, so markers keep a constant on-screen size across zoom levels.
 */
export class VertexMarkerLayer {
  private readonly enabled: boolean;
  private readonly radiusPx: number;
  private readonly firstRadiusPx: number;
  private readonly color: string | undefined;
  private readonly firstColor: string | undefined;

  private markers: Circle[] = [];
  private overlay: ToolOverlay | null = null;

  constructor(options: VertexMarkerOptions = {}) {
    this.enabled = options.enabled ?? true;
    this.radiusPx = options.radius ?? DEFAULT_VERTEX_MARKER_RADIUS_PX;
    this.firstRadiusPx = options.firstRadius ?? DEFAULT_FIRST_VERTEX_MARKER_RADIUS_PX;
    this.color = options.color;
    this.firstColor = options.firstColor ?? options.color;
  }

  /**
   * Reconciles the drawn markers with `vertices`, reusing existing Circles so a
   * redraw on every pointer move stays allocation-free.
   *
   * @param closeCandidate True when clicking now would close the shape — the
   *   first marker fills in to advertise it.
   */
  sync(
    overlay: ToolOverlay,
    vertices: readonly Point[],
    style: AnnotationStyle,
    closeCandidate = false,
  ): void {
    if (!this.enabled) return;
    if (this.overlay && this.overlay !== overlay) this.clear();
    this.overlay = overlay;

    const zoom = overlay.canvas.getZoom();
    const scale = 1 / (Number.isFinite(zoom) && zoom > 0 ? zoom : 1);
    const color = this.color ?? style.strokeColor;
    const firstColor = this.firstColor ?? color;

    // Drop markers for vertices that no longer exist.
    for (const extra of this.markers.splice(vertices.length)) {
      overlay.canvas.remove(extra);
    }

    vertices.forEach((vertex, index) => {
      const isFirst = index === 0;
      const radius = (isFirst ? this.firstRadiusPx : this.radiusPx) * scale;
      const stroke = isFirst ? firstColor : color;
      const strokeWidth = isFirst ? FIRST_VERTEX_STROKE_PX * scale : 0;
      // The first vertex stays a hollow ring until clicking would close the
      // shape, at which point it fills in as the "click here" affordance.
      let fill = color;
      if (isFirst) fill = closeCandidate ? firstColor : 'transparent';

      const existing = this.markers[index];
      if (existing) {
        existing.set({
          left: vertex.x,
          top: vertex.y,
          radius,
          fill,
          stroke,
          strokeWidth,
          dirty: true,
        });
        return;
      }

      const marker = new Circle({
        left: vertex.x,
        top: vertex.y,
        radius,
        fill,
        stroke,
        strokeWidth,
        originX: 'center',
        originY: 'center',
        opacity: style.opacity,
        selectable: false,
        evented: false,
        hasControls: false,
        strokeUniform: true,
        objectCaching: false,
      });
      marker._readOnly = true;
      this.markers.push(marker);
      overlay.canvas.add(marker);
    });
  }

  /** Removes every marker from the canvas. */
  clear(): void {
    const overlay = this.overlay;
    if (overlay) {
      for (const marker of this.markers) overlay.canvas.remove(marker);
    }
    this.markers = [];
    this.overlay = null;
  }
}
