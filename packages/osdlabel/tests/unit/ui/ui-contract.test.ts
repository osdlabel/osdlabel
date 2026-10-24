import { describe, expect, it } from 'vitest';
import type { ConstraintStatus } from '@osdlabel/annotation-context';
import { MAX_BRUSH_RADIUS, MIN_BRUSH_RADIUS } from '@osdlabel/viewer-api';
import {
  OSDLABEL_THEME_TOKENS,
  themeToCustomProperties,
  themeTokenProperty,
  themeVar,
} from '../../../src/ui/theme-tokens.js';
import { toolButtonPart } from '../../../src/ui/parts.js';
import { deriveToolbarModel, type ToolbarModelInput } from '../../../src/ui/toolbar-model.js';
import { ANNOTATOR_SLOT_NAMES } from '../../../src/ui/annotator-slots.js';

const status = (overrides: Partial<ConstraintStatus> = {}): ConstraintStatus => {
  const open = { enabled: true, currentCount: 0, maxCount: null };
  return {
    rectangle: { ...open },
    circle: { ...open },
    line: { ...open },
    point: { ...open },
    polyline: { ...open },
    freeHandPath: { ...open },
    segmentationBrush: { ...open },
    ...overrides,
  };
};

const input = (overrides: Partial<ToolbarModelInput> = {}): ToolbarModelInput => ({
  activeTool: null,
  allowedTools: ['rectangle', 'line'],
  constraintStatus: status(),
  brushRadius: 12,
  brushErasing: false,
  selectedGeometryType: undefined,
  ...overrides,
});

describe('theme tokens', () => {
  it('maps camelCase tokens to --osdlabel- kebab-case properties', () => {
    expect(themeTokenProperty('accent')).toBe('--osdlabel-accent');
    expect(themeTokenProperty('fontSizeControl')).toBe('--osdlabel-font-size-control');
  });

  it('falls back to the pre-token value, so an unthemed UI is unchanged', () => {
    expect(themeVar('accent')).toBe('var(--osdlabel-accent, #2196F3)');
    expect(OSDLABEL_THEME_TOKENS.surface).toBe('#1a1a1a');
  });

  it('turns a theme object into custom-property declarations', () => {
    expect(themeToCustomProperties({ accent: 'hotpink', radius: '0' })).toEqual({
      '--osdlabel-accent': 'hotpink',
      '--osdlabel-radius': '0',
    });
  });
});

describe('toolButtonPart', () => {
  it('adds a state part per state', () => {
    expect(toolButtonPart({ active: false, enabled: true })).toBe('tool-button');
    expect(toolButtonPart({ active: true, enabled: true })).toBe('tool-button tool-button-active');
    expect(toolButtonPart({ active: false, enabled: false })).toBe(
      'tool-button tool-button-disabled',
    );
  });
});

describe('deriveToolbarModel', () => {
  it('lists navigate, select, then the context tools in context order', () => {
    const model = deriveToolbarModel(input());
    expect(model.buttons.map((b) => b.key)).toEqual(['navigate', 'select', 'rectangle', 'line']);
    expect(model.buttons[0]!.active).toBe(true);
    expect(model.buttons[2]!.label).toBe('Rect');
  });

  it('labels counts with the limit when there is one and disables an exhausted tool', () => {
    const model = deriveToolbarModel(
      input({
        constraintStatus: status({
          rectangle: { enabled: false, currentCount: 2, maxCount: 2 },
          line: { enabled: true, currentCount: 1, maxCount: null },
        }),
      }),
    );
    const rect = model.buttons.find((b) => b.key === 'rectangle')!;
    const line = model.buttons.find((b) => b.key === 'line')!;
    expect(rect).toMatchObject({ countLabel: '2/2', enabled: false });
    expect(line).toMatchObject({ countLabel: '1', enabled: true });
  });

  it('exposes brush settings only while the brush is active', () => {
    expect(deriveToolbarModel(input()).brush).toBeNull();
    const model = deriveToolbarModel(
      input({ activeTool: 'segmentationBrush', brushRadius: 30, brushErasing: true }),
    );
    expect(model.brush).toEqual({
      radius: 30,
      erasing: true,
      min: MIN_BRUSH_RADIUS,
      max: MAX_BRUSH_RADIUS,
    });
  });

  it('offers convert-to-rect only for a selected circle, gated on the rectangle constraint', () => {
    expect(deriveToolbarModel(input()).convertToRect).toBeNull();
    expect(
      deriveToolbarModel(input({ selectedGeometryType: 'rectangle' })).convertToRect,
    ).toBeNull();
    expect(deriveToolbarModel(input({ selectedGeometryType: 'circle' })).convertToRect).toEqual({
      enabled: true,
    });
    expect(
      deriveToolbarModel(
        input({
          selectedGeometryType: 'circle',
          constraintStatus: status({ rectangle: { enabled: false, currentCount: 1, maxCount: 1 } }),
        }),
      ).convertToRect,
    ).toEqual({ enabled: false });
  });

  it('is serialisable, so the element can put it in an event detail', () => {
    const model = deriveToolbarModel(input({ activeTool: 'segmentationBrush' }));
    expect(JSON.parse(JSON.stringify(model))).toEqual(model);
  });
});

describe('slot names', () => {
  it('names the element slot for every override point', () => {
    expect(ANNOTATOR_SLOT_NAMES).toEqual({ Toolbar: 'toolbar' });
  });
});
