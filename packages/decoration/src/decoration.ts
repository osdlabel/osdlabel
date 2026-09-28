import type { AnnotationId, Point } from '@osdlabel/annotation';

/** Styling applied to a text decoration (DOM-rendered). */
export interface TextDecorationStyle {
  readonly color?: string | undefined;
  /** Font size in screen pixels. */
  readonly fontSize?: number | undefined;
  readonly fontFamily?: string | undefined;
  readonly fontWeight?: string | number | undefined;
  /** CSS background shorthand (e.g. 'rgba(0,0,0,0.6)'). */
  readonly background?: string | undefined;
  /** CSS padding shorthand (e.g. '2px 4px'). */
  readonly padding?: string | undefined;
  /** CSS border-radius shorthand. */
  readonly borderRadius?: string | undefined;
  /** Additional CSS class applied to the host element. */
  readonly className?: string | undefined;
  /** CSS z-index to control stacking order of text labels. */
  readonly zIndex?: number | undefined;
}

/** Styling applied to a line decoration (Fabric-rendered). */
export interface LineDecorationStyle {
  readonly stroke?: string | undefined;
  /** Stroke width in screen pixels (rendered with strokeUniform). */
  readonly strokeWidth?: number | undefined;
  readonly opacity?: number | undefined;
}

/** Styling applied to a DOM decoration's root element. */
export interface DomDecorationStyle {
  /** Additional CSS class applied to the root element. */
  readonly className?: string | undefined;
  /** CSS z-index controlling stacking order among DOM decorations / text labels. */
  readonly zIndex?: number | undefined;
  /**
   * Whether the root element captures pointer events. Defaults to `'auto'` so
   * rich content (buttons, inputs, popovers) is interactive. Set `'none'` for
   * purely-visual content that should let clicks fall through to the canvas.
   */
  readonly pointerEvents?: 'auto' | 'none' | undefined;
  /** Optional fixed width in screen pixels; otherwise the root sizes to content. */
  readonly width?: number | undefined;
  /** Optional fixed height in screen pixels; otherwise the root sizes to content. */
  readonly height?: number | undefined;
}

interface BaseDecoration {
  /**
   * Stable identifier used for diffing across recomputations. Providers must
   * produce the same id for the same logical decoration so the renderer can
   * update in place instead of recreating DOM/canvas objects.
   */
  readonly id: string;
  /**
   * Annotation ids this decoration is associated with. Used for lifecycle
   * (e.g. so the renderer can remove decorations when their related
   * annotations are deleted). May be empty for purely contextual decorations.
   */
  readonly relatedAnnotationIds: readonly AnnotationId[];
}

/**
 * Where the text element is anchored relative to its own bounding box — i.e.
 * which point of the element's own box lands on the anchor.
 *
 * - `'top-left'` (default): the element's top-left corner is at the anchor.
 * - `'top-right'` / `'bottom-left'` / `'bottom-right'`: the named corner of the
 *   element is at the anchor.
 * - `'center'`: the element is centered on the anchor.
 * - `'top'` / `'bottom'`: horizontally centered, top/bottom edge at anchor.
 * - `'left'` / `'right'`: vertically centered, left/right edge at anchor.
 */
export type TextPlacement =
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right'
  | 'center'
  | 'top'
  | 'bottom'
  | 'left'
  | 'right';

/** Coordinate space a text/DOM decoration's `anchor` is expressed in. */
export type DecorationAnchorSpace = 'image' | 'cell';

/** A text label rendered as a DOM element positioned over the image. */
export interface TextDecoration extends BaseDecoration {
  readonly type: 'text';
  readonly text: string;
  /** Anchor point, interpreted according to {@link TextDecoration.anchorSpace}. */
  readonly anchor: Point;
  /**
   * Optional screen-pixel offset added to the anchor's screen position
   * before the element is placed.
   */
  readonly offset?: { readonly x: number; readonly y: number } | undefined;
  /** How the element aligns to its anchor. Default: `'top-left'`. */
  readonly placement?: TextPlacement | undefined;
  /**
   * Which space `anchor` is expressed in. Default `'image'`: image pixels,
   * projected through the viewport every frame. `'cell'`: fractions of the
   * cell's size (`{x:0,y:0}` = top-left corner, `{x:1,y:1}` = bottom-right),
   * fixed in the cell's viewport and untouched by pan / zoom / rotate / flip.
   * `offset` (screen px) and `placement` apply identically in both spaces.
   */
  readonly anchorSpace?: DecorationAnchorSpace | undefined;
  readonly style?: TextDecorationStyle | undefined;
}

/** A connector / measurement line rendered as a Fabric object in image-space. */
export interface LineDecoration extends BaseDecoration {
  readonly type: 'line';
  /** Start point in image-space coordinates. */
  readonly start: Point;
  /** End point in image-space coordinates. */
  readonly end: Point;
  /** If true, the line is rendered with a dash pattern. */
  readonly dashed?: boolean | undefined;
  readonly style?: LineDecorationStyle | undefined;
}

/**
 * A framework-rendered rich decoration.
 *
 * The renderer creates and positions a `<div>` root anchored to the image; a
 * UI framework (React, Solid, …) renders an arbitrary component tree into that
 * root via its native portal, so the tree shares the host app's context. The
 * `content` payload is treated as stable configuration/identity — dynamic data
 * should flow through the app's own reactivity inside the rendered component,
 * not through `content` changing per frame.
 */
export interface DomDecoration extends BaseDecoration {
  readonly type: 'dom';
  /** Anchor point, interpreted according to {@link DomDecoration.anchorSpace}. */
  readonly anchor: Point;
  /**
   * Optional screen-pixel offset added to the anchor's screen position before
   * the root is placed.
   */
  readonly offset?: { readonly x: number; readonly y: number } | undefined;
  /** How the root aligns to its anchor. Default: `'top-left'`. */
  readonly placement?: TextPlacement | undefined;
  /**
   * Which space `anchor` is expressed in. Default `'image'`: image pixels,
   * projected through the viewport every frame. `'cell'`: fractions of the
   * cell's size (`{x:0,y:0}` = top-left corner, `{x:1,y:1}` = bottom-right),
   * fixed in the cell's viewport and untouched by pan / zoom / rotate / flip.
   * `offset` (screen px) and `placement` apply identically in both spaces.
   */
  readonly anchorSpace?: DecorationAnchorSpace | undefined;
  /** Framework-agnostic configuration the render-prop interprets. */
  readonly content: unknown;
  readonly style?: DomDecorationStyle | undefined;
}

/**
 * Declarative description of something to render alongside annotations.
 *
 * Decorations are pure data: providers return them, the renderer turns them
 * into DOM/Fabric objects. Decorations are never serialized into annotation
 * data — they are always recomputed from current state.
 */
export type Decoration = TextDecoration | LineDecoration | DomDecoration;

/** Discriminator values of `Decoration`. */
export type DecorationType = Decoration['type'];
