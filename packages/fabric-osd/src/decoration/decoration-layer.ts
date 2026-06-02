import { Line as FabricLine } from 'fabric';
import type {
  Decoration,
  LineDecoration,
  TextDecoration,
  TextPlacement,
} from '@osdlabel/decoration';
import type { FabricOverlay } from '../overlay/fabric-overlay.js';

const DEFAULT_TEXT_COLOR = '#ffffff';
const DEFAULT_FONT_SIZE_PX = 12;
const DEFAULT_FONT_FAMILY = 'sans-serif';
const DEFAULT_TEXT_BACKGROUND = 'rgba(0, 0, 0, 0.55)';
const DEFAULT_TEXT_PADDING = '2px 4px';
const DEFAULT_TEXT_BORDER_RADIUS = '2px';
const DEFAULT_LINE_STROKE = '#ffd700';
const DEFAULT_LINE_STROKE_WIDTH = 1.5;
const DEFAULT_LINE_OPACITY = 0.85;
const DEFAULT_DASH_PATTERN = [6, 4] as const;

/**
 * Renderer for {@link Decoration}s on top of a {@link FabricOverlay}.
 *
 * Text decorations are rendered as absolutely-positioned DOM elements
 * inside a host `<div>` appended to the OSD container — they stay upright,
 * crisp, and constant screen-size at all zooms and rotations with no
 * counter-transform math. Line decorations are rendered as non-interactive
 * Fabric `Line` objects on the overlay's canvas, so they pan/zoom/rotate/
 * flip with the image at zero per-frame cost.
 *
 * Construct once per cell, call `setDecorations` whenever the derived
 * decoration list changes, and call `destroy` on cleanup.
 */
export class DecorationLayer {
  private readonly _overlay: FabricOverlay;
  private readonly _hostEl: HTMLDivElement;
  private readonly _unsubscribeSync: () => void;
  private readonly _textEls = new Map<string, HTMLDivElement>();
  private readonly _lineObjects = new Map<string, FabricLine>();
  private _decorations: readonly Decoration[] = [];
  private _destroyed = false;

  constructor(overlay: FabricOverlay) {
    this._overlay = overlay;

    this._hostEl = document.createElement('div');
    this._hostEl.style.position = 'absolute';
    this._hostEl.style.inset = '0';
    this._hostEl.style.pointerEvents = 'none';
    this._hostEl.style.overflow = 'hidden';
    this._hostEl.dataset.osdlabel = 'decoration-layer';
    overlay.overlayElement.appendChild(this._hostEl);

    this._unsubscribeSync = overlay.onSync(() => this._repositionText());
  }

  /** Replace the current decorations. Diffed by id for stable element reuse. */
  setDecorations(decorations: readonly Decoration[]): void {
    if (this._destroyed) return;
    this._decorations = decorations;
    this._diffText(decorations);
    this._diffLines(decorations);
    this._repositionText();
    this._overlay.canvas.requestRenderAll();
  }

  destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;
    this._unsubscribeSync();
    for (const obj of this._lineObjects.values()) {
      this._overlay.canvas.remove(obj);
    }
    this._lineObjects.clear();
    this._textEls.clear();
    this._hostEl.remove();
  }

  // ── Text decorations (DOM) ────────────────────────────────────────────

  private _diffText(decorations: readonly Decoration[]): void {
    const wanted = new Map<string, TextDecoration>();
    for (const d of decorations) {
      if (d.type === 'text') wanted.set(d.id, d);
    }

    // Remove gone
    for (const [id, el] of this._textEls) {
      if (!wanted.has(id)) {
        el.remove();
        this._textEls.delete(id);
      }
    }

    // Add new / update existing
    for (const [id, decoration] of wanted) {
      let el = this._textEls.get(id);
      if (!el) {
        el = document.createElement('div');
        el.style.position = 'absolute';
        el.style.top = '0';
        el.style.left = '0';
        el.style.willChange = 'transform';
        el.dataset.osdlabel = 'decoration-text';
        this._hostEl.appendChild(el);
        this._textEls.set(id, el);
      }
      applyTextStyle(el, decoration);
    }
  }

  private _repositionText(): void {
    for (const d of this._decorations) {
      if (d.type !== 'text') continue;
      const el = this._textEls.get(d.id);
      if (!el) continue;
      const screen = this._overlay.imageToScreen(d.anchor);
      const offsetX = d.offset?.x ?? 0;
      const offsetY = d.offset?.y ?? 0;
      const align = placementTranslate(d.placement);
      el.style.transform = `translate3d(${screen.x + offsetX}px, ${screen.y + offsetY}px, 0) translate3d(${align.x}, ${align.y}, 0)`;
    }
  }

  // ── Line decorations (Fabric) ─────────────────────────────────────────

  private _diffLines(decorations: readonly Decoration[]): void {
    const wanted = new Map<string, LineDecoration>();
    for (const d of decorations) {
      if (d.type === 'line') wanted.set(d.id, d);
    }

    // Remove gone
    for (const [id, obj] of this._lineObjects) {
      if (!wanted.has(id)) {
        this._overlay.canvas.remove(obj);
        this._lineObjects.delete(id);
      }
    }

    // Add new / update existing
    for (const [id, decoration] of wanted) {
      let obj = this._lineObjects.get(id);
      if (!obj) {
        obj = new FabricLine(
          [decoration.start.x, decoration.start.y, decoration.end.x, decoration.end.y],
          {
            selectable: false,
            evented: false,
            strokeUniform: true,
            objectCaching: false,
            hoverCursor: 'default',
          },
        );
        // `_readOnly:true` ensures FabricOverlay.setMode() keeps this object
        // non-interactive in both navigation and annotation modes. We do NOT
        // set `id` — that property is reserved for annotation objects and is
        // how the host clears annotations on context switch.
        obj._readOnly = true;
        this._overlay.canvas.add(obj);
        this._lineObjects.set(id, obj);
      } else {
        obj.set({
          x1: decoration.start.x,
          y1: decoration.start.y,
          x2: decoration.end.x,
          y2: decoration.end.y,
        });
      }
      const style = decoration.style;
      obj.set({
        stroke: style?.stroke ?? DEFAULT_LINE_STROKE,
        strokeWidth: style?.strokeWidth ?? DEFAULT_LINE_STROKE_WIDTH,
        opacity: style?.opacity ?? DEFAULT_LINE_OPACITY,
        strokeDashArray: decoration.dashed ? [...DEFAULT_DASH_PATTERN] : null,
      });
      obj.setCoords();
    }
  }
}

function applyTextStyle(el: HTMLDivElement, decoration: TextDecoration): void {
  if (el.textContent !== decoration.text) {
    el.textContent = decoration.text;
  }
  el.dataset.decorationId = decoration.id;
  const style = decoration.style;
  el.style.color = style?.color ?? DEFAULT_TEXT_COLOR;
  el.style.fontSize = `${style?.fontSize ?? DEFAULT_FONT_SIZE_PX}px`;
  el.style.fontFamily = style?.fontFamily ?? DEFAULT_FONT_FAMILY;
  el.style.fontWeight = style?.fontWeight !== undefined ? String(style.fontWeight) : '';
  el.style.background = style?.background ?? DEFAULT_TEXT_BACKGROUND;
  el.style.padding = style?.padding ?? DEFAULT_TEXT_PADDING;
  el.style.borderRadius = style?.borderRadius ?? DEFAULT_TEXT_BORDER_RADIUS;
  el.style.whiteSpace = 'pre';
  el.style.userSelect = 'none';
  const nextClassName = style?.className ?? '';
  if (el.className !== nextClassName) {
    el.className = nextClassName;
  }
}

function placementTranslate(placement: TextPlacement | undefined): {
  readonly x: string;
  readonly y: string;
} {
  switch (placement) {
    case 'center':
      return { x: '-50%', y: '-50%' };
    case 'top':
      return { x: '-50%', y: '0' };
    case 'bottom':
      return { x: '-50%', y: '-100%' };
    case 'left':
      return { x: '0', y: '-50%' };
    case 'right':
      return { x: '-100%', y: '-50%' };
    case 'top-left':
    case undefined:
      return { x: '0', y: '0' };
  }
}
