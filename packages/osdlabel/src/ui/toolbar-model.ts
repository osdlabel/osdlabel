import type { Geometry, ToolType } from '@osdlabel/annotation';
import type { ConstraintStatus } from '@osdlabel/annotation-context';
import { MAX_BRUSH_RADIUS, MIN_BRUSH_RADIUS } from '@osdlabel/viewer-api';

/** What a toolbar button selects: a drawing tool, the select tool, or navigation (`null`). */
export type ToolbarTool = ToolType | 'select' | null;

/** Button labels, shared so the two bindings cannot label a tool differently. */
export const TOOL_LABELS: Readonly<Record<ToolType, string>> = {
  rectangle: 'Rect',
  circle: 'Circle',
  line: 'Line',
  point: 'Point',
  polyline: 'Polyline',
  freeHandPath: 'Free Draw',
  segmentationBrush: 'Brush',
};

export interface ToolbarButtonModel {
  /** `navigate`, `select` or the tool type; the stock UI's `data-testid` is `tool-<key>`. */
  readonly key: string;
  readonly tool: ToolbarTool;
  readonly label: string;
  /** `"2"` or `"2/3"` for drawing tools; `null` for navigate / select. */
  readonly countLabel: string | null;
  readonly active: boolean;
  readonly enabled: boolean;
}

export interface ToolbarBrushModel {
  readonly radius: number;
  readonly erasing: boolean;
  readonly min: number;
  readonly max: number;
}

/**
 * Everything a toolbar renders, derived from annotator state by
 * {@link deriveToolbarModel}. Framework-neutral and serialisable, so the
 * `<osdlabel-annotator>` element can hand it to a slotted, host-rendered
 * toolbar in an event.
 */
export interface ToolbarModel {
  readonly buttons: readonly ToolbarButtonModel[];
  /** Present only while the brush is the active tool. */
  readonly brush: ToolbarBrushModel | null;
  /**
   * `null` unless the selected annotation is a circle; then whether it can be
   * converted to its bounding rectangle (the context must allow another one).
   */
  readonly convertToRect: { readonly enabled: boolean } | null;
}

export interface ToolbarModelInput {
  readonly activeTool: ToolbarTool;
  /** The active context's tools, in its order; empty without an active context. */
  readonly allowedTools: readonly ToolType[];
  readonly constraintStatus: ConstraintStatus;
  readonly brushRadius: number;
  readonly brushErasing: boolean;
  /** Geometry type of the selected annotation on the active image, if any. */
  readonly selectedGeometryType: Geometry['type'] | undefined;
}

export function deriveToolbarModel(input: ToolbarModelInput): ToolbarModel {
  const buttons: ToolbarButtonModel[] = [
    {
      key: 'navigate',
      tool: null,
      label: 'Navigate',
      countLabel: null,
      active: input.activeTool === null,
      enabled: true,
    },
    {
      key: 'select',
      tool: 'select',
      label: 'Select',
      countLabel: null,
      active: input.activeTool === 'select',
      enabled: true,
    },
  ];
  for (const tool of input.allowedTools) {
    const status = input.constraintStatus[tool];
    buttons.push({
      key: tool,
      tool,
      label: TOOL_LABELS[tool],
      countLabel:
        status.maxCount === null
          ? `${status.currentCount}`
          : `${status.currentCount}/${status.maxCount}`,
      active: input.activeTool === tool,
      enabled: status.enabled,
    });
  }
  return {
    buttons,
    brush:
      input.activeTool === 'segmentationBrush'
        ? {
            radius: input.brushRadius,
            erasing: input.brushErasing,
            min: MIN_BRUSH_RADIUS,
            max: MAX_BRUSH_RADIUS,
          }
        : null,
    convertToRect:
      input.selectedGeometryType === 'circle'
        ? { enabled: input.constraintStatus.rectangle.enabled }
        : null,
  };
}

/**
 * The props an override toolbar receives, in both bindings, and the commands
 * the `<osdlabel-annotator>` element exposes for a slotted one. The stock
 * toolbar renders from exactly this, so an override can do anything it can.
 */
export interface ToolbarSlotProps {
  readonly model: ToolbarModel;
  /** No-op for a disabled tool. */
  readonly onSelectTool: (tool: ToolbarTool) => void;
  readonly onBrushRadiusChange: (radius: number) => void;
  readonly onBrushErasingChange: (erasing: boolean) => void;
  /** No-op unless `model.convertToRect?.enabled`. */
  readonly onConvertToRect: () => void;
}
