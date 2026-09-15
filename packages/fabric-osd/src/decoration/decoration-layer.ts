import { Line as FabricLine } from 'fabric';
import type {
  Decoration,
  DecorationAnchorSpace,
  DomDecoration,
  LineDecoration,
  TextDecoration,
  TextPlacement,
} from '@osdlabel/decoration';
import type { Point } from '@osdlabel/annotation';
import type { FabricOverlay } from '../overlay/fabric-overlay.js';

/**
 * A live DOM-decoration root: the `<div>` the renderer created and positions,
 * paired with the decoration it represents. Frameworks render their component
 * tree into `element` (via a portal) keyed by `id`.
 */
export interface DomDecorationEntry {
  readonly id: string;
  readonly element: HTMLElement;
  readonly decoration: DomDecoration;
}

/**
 * Internal entry: same shape as {@link DomDecorationEntry} but with a mutable
 * `decoration` so the layer can update it in place. Keeping the entry object's
 * identity stable across recomputations is essential for SolidJS's `<For>`,
 * which tracks rows by referential equality — allocating fresh entry objects
 * each notification would tear down and remount every `<Portal>` (losing focus
 * / input state in unrelated decorations) whenever any one is added or removed.
 */
interface MutableDomEntry {
  readonly id: string;
  readonly element: HTMLDivElement;
  decoration: DomDecoration;
}

type DomDecorationsCallback = (entries: readonly DomDecorationEntry[]) => void;

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
  private readonly _domEntries = new Map<string, MutableDomEntry>();
  private readonly _domSubscribers = new Set<DomDecorationsCallback>();
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

    this._unsubscribeSync = overlay.onSync(() => this._reposition());
  }

  /** Replace the current decorations. Diffed by id for stable element reuse. */
  setDecorations(decorations: readonly Decoration[]): void {
    if (this._destroyed) return;
    this._decorations = decorations;
    this._diffText(decorations);
    this._diffDom(decorations);
    this._diffLines(decorations);
    this._reposition();
    this._overlay.canvas.requestRenderAll();
  }

  /**
   * Subscribe to DOM-decoration lifecycle. The callback fires immediately with
   * the current entries and again only when the set of DOM decorations changes
   * (an id is added or removed) — never per content change or per frame. The
   * div's screen position is owned by this layer; the subscriber owns only the
   * content rendered into `entry.element`. Returns an unsubscribe function.
   */
  onDomDecorations(callback: DomDecorationsCallback): () => void {
    this._domSubscribers.add(callback);
    callback(this._currentDomEntries());
    return () => {
      this._domSubscribers.delete(callback);
    };
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
    for (const entry of this._domEntries.values()) {
      entry.element.remove();
    }
    this._domEntries.clear();
    this._notifyDomSubscribers();
    this._domSubscribers.clear();
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

  // ── DOM decorations (framework-rendered) ──────────────────────────────

  private _diffDom(decorations: readonly Decoration[]): void {
    const wanted = new Map<string, DomDecoration>();
    for (const d of decorations) {
      if (d.type === 'dom') wanted.set(d.id, d);
    }

    let membershipChanged = false;

    // Remove gone
    for (const [id, entry] of this._domEntries) {
      if (!wanted.has(id)) {
        entry.element.remove();
        this._domEntries.delete(id);
        membershipChanged = true;
      }
    }

    // Add new / update existing. On update we mutate the existing entry's
    // `decoration` in place rather than replacing the entry, so its object
    // identity stays stable for SolidJS's `<For>` (see MutableDomEntry).
    for (const [id, decoration] of wanted) {
      let entry = this._domEntries.get(id);
      if (!entry) {
        const el = document.createElement('div');
        el.style.position = 'absolute';
        el.style.top = '0';
        el.style.left = '0';
        el.style.willChange = 'transform';
        el.dataset.osdlabel = 'decoration-dom';
        el.dataset.decorationId = id;
        this._hostEl.appendChild(el);
        entry = { id, element: el, decoration };
        this._domEntries.set(id, entry);
        membershipChanged = true;
      } else {
        entry.decoration = decoration;
      }
      applyDomStyle(entry.element, decoration);
    }

    if (membershipChanged) this._notifyDomSubscribers();
  }

  private _currentDomEntries(): readonly DomDecorationEntry[] {
    // New array, but the entry object references are stable across calls so
    // SolidJS's `<For>` reuses existing rows and only mounts the new ones.
    return Array.from(this._domEntries.values());
  }

  private _notifyDomSubscribers(): void {
    const entries = this._currentDomEntries();
    for (const cb of this._domSubscribers) cb(entries);
  }

  // ── Screen positioning (text + DOM share the same anchor model) ────────

  private _reposition(): void {
    for (const d of this._decorations) {
      if (d.type === 'text') {
        const el = this._textEls.get(d.id);
        if (el) this._positionEl(el, d.anchor, d.offset, d.placement, d.anchorSpace);
      } else if (d.type === 'dom') {
        const el = this._domEntries.get(d.id)?.element;
        if (el) this._positionEl(el, d.anchor, d.offset, d.placement, d.anchorSpace);
      }
    }
  }

  private _positionEl(
    el: HTMLElement,
    anchor: Point,
    offset: { readonly x: number; readonly y: number } | undefined,
    placement: TextPlacement | undefined,
    anchorSpace: DecorationAnchorSpace | undefined,
  ): void {
    // Cell-space anchors are fractions of the host element's box (which is
    // `inset:0` inside the cell), so they never touch the viewport transform.
    const screen =
      anchorSpace === 'cell'
        ? {
            x: anchor.x * this._hostEl.clientWidth,
            y: anchor.y * this._hostEl.clientHeight,
          }
        : this._overlay.imageToScreen(anchor);
    const offsetX = offset?.x ?? 0;
    const offsetY = offset?.y ?? 0;
    const align = placementTranslate(placement);
    const nextTransform = `translate3d(${screen.x + offsetX}px, ${screen.y + offsetY}px, 0) translate3d(${align.x}, ${align.y}, 0)`;
    if (el.style.transform !== nextTransform) {
      el.style.transform = nextTransform;
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
  const nextZIndex = style?.zIndex !== undefined ? String(style.zIndex) : '';
  if (el.style.zIndex !== nextZIndex) {
    el.style.zIndex = nextZIndex;
  }
}

function applyDomStyle(el: HTMLDivElement, decoration: DomDecoration): void {
  const style = decoration.style;
  const nextPointerEvents = style?.pointerEvents ?? 'auto';
  if (el.style.pointerEvents !== nextPointerEvents) {
    el.style.pointerEvents = nextPointerEvents;
  }
  const nextClassName = style?.className ?? '';
  if (el.className !== nextClassName) {
    el.className = nextClassName;
  }
  const nextZIndex = style?.zIndex !== undefined ? String(style.zIndex) : '';
  if (el.style.zIndex !== nextZIndex) {
    el.style.zIndex = nextZIndex;
  }
  const nextWidth = style?.width !== undefined ? `${style.width}px` : '';
  if (el.style.width !== nextWidth) {
    el.style.width = nextWidth;
  }
  const nextHeight = style?.height !== undefined ? `${style.height}px` : '';
  if (el.style.height !== nextHeight) {
    el.style.height = nextHeight;
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
    case 'top-right':
      return { x: '-100%', y: '0' };
    case 'bottom-left':
      return { x: '0', y: '-100%' };
    case 'bottom-right':
      return { x: '-100%', y: '-100%' };
    case 'top-left':
    case undefined:
      return { x: '0', y: '0' };
  }
}
