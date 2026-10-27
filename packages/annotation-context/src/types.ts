import type { ToolType, AnnotationStyle } from '@osdlabel/annotation';
import type { ImageId } from '@osdlabel/viewer-api';

// ── Branded ID Type ─────────────────────────────────────────────────────

declare const annotationContextIdBrand: unique symbol;

/** Unique annotation context identifier */
export type AnnotationContextId = string & { readonly __brand: typeof annotationContextIdBrand };

export function createAnnotationContextId(value: string): AnnotationContextId {
  return value as AnnotationContextId;
}

// ── Context Extension Fields ────────────────────────────────────────────

/** Extension fields added by the context system */
export interface ContextFields {
  readonly contextId: AnnotationContextId;
}

// ── Constraint System ───────────────────────────────────────────────────

/** Count scope for tool constraints */
export type CountScope = 'per-image' | 'global';

/** How the segmentation brush behaves in a context; plain data, like the rest of it. */
export interface BrushContextOptions {
  /**
   * The coarsest downsample a stroke may push a mask to when it would
   * outgrow the cap: the mask is halved, by the provider's coarsen strategy,
   * until the stroke fits or this is reached. A power of two up to 2^16; 1
   * (the default, and what any other value means) refuses at the cap.
   */
  readonly maxDownsample?: number | undefined;
}

/** Tool constraint within an annotation context */
export interface ToolConstraint {
  readonly type: ToolType;
  readonly maxCount?: number | undefined;
  readonly countScope?: CountScope | undefined;
  readonly defaultStyle?: Partial<AnnotationStyle> | undefined;
  /** For `segmentationBrush`: see {@link BrushContextOptions}. Ignored by other tools. */
  readonly brush?: BrushContextOptions | undefined;
}

/** An annotation context defining tool constraints for a particular annotation task */
export interface AnnotationContext {
  readonly id: AnnotationContextId;
  readonly label: string;
  readonly tools: readonly ToolConstraint[];
  readonly imageIds?: readonly ImageId[] | undefined;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}

// ── State Types ─────────────────────────────────────────────────────────

/** Context state */
export interface ContextState {
  contexts: AnnotationContext[];
  activeContextId: AnnotationContextId | null;
  displayedContextIds: AnnotationContextId[];
}

/** Derived state showing which tools are enabled/disabled for the active context */
export type ConstraintStatus = Record<
  ToolType,
  {
    readonly enabled: boolean;
    readonly currentCount: number;
    readonly maxCount: number | null;
  }
>;
