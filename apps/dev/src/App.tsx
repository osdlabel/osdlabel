import { createSignal, createEffect } from 'solid-js';
import { render } from 'solid-js/web';
import {
  Toolbar,
  StatusBar,
  GridView,
  Filmstrip,
  GridControls,
  ViewControls,
  createImageId,
  AnnotatorProvider,
  useAnnotator,
  serialize,
  deserialize,
  createMeasurementProvider,
  createLabelProvider,
  createDistanceProvider,
  withSelectionEmphasis,
  centroid,
} from '@osdlabel/solid';
import type {
  AnnotationContextId,
  AnnotationContext,
  ImageSource,
  DecorationProvider,
  DomDecoration,
  OsdFields,
} from '@osdlabel/solid';
import { FabricObject } from 'fabric';

// NOTE: initFabricModule() is intentionally NOT called here. The library
// registers the Fabric `id` custom property automatically when a FabricOverlay
// mounts, so this dev harness dogfoods that auto-registration. The E2E test
// `auto-init-fabric.spec.ts` relies on this.

const IMAGES: ImageSource[] = [
  {
    id: createImageId('highsmith'),
    tileSource: 'https://openseadragon.github.io/example-images/highsmith/highsmith.dzi',
    label: 'Highsmith',
  },
  {
    id: createImageId('duomo'),
    tileSource: 'https://openseadragon.github.io/example-images/duomo/duomo.dzi',
    label: 'Duomo',
  },
  {
    id: createImageId('wide'),
    tileSource:
      'https://openseadragon.github.io/example-images/pnp/pan/6a32000/6a32400/6a32487.dzi',
    label: 'Wide image',
  },
  {
    id: createImageId('jpg'),
    tileSource: './sample-data/test-image.jpg',
    label: 'JPG image',
  },
];

const CONTEXTS: AnnotationContext[] = [
  {
    id: 'ctx-1' as AnnotationContextId,
    label: 'Fracture',
    imageIds: [createImageId('highsmith'), createImageId('duomo')],
    tools: [
      { type: 'line', maxCount: 3, countScope: 'per-image' },
      { type: 'rectangle', maxCount: 2 },
    ],
  },
  {
    id: 'ctx-2' as AnnotationContextId,
    label: 'Pneumothorax',
    tools: [
      { type: 'polyline', maxCount: 3 },
      { type: 'freeHandPath', maxCount: 3 },
      { type: 'circle', maxCount: 2 },
      // Allow rectangles so a circle can be converted to its bounding box here
      // (the "Convert to Rect" toolbar action is gated on the rectangle limit).
      { type: 'rectangle', maxCount: 2 },
    ],
  },
  {
    id: 'ctx-3' as AnnotationContextId,
    label: 'General',
    tools: [
      { type: 'rectangle' },
      { type: 'circle' },
      { type: 'line' },
      { type: 'point' },
      { type: 'polyline' },
      { type: 'freeHandPath' },
    ],
  },
];

function AppContent() {
  const { uiState, annotationState, actions, activeImageId } = useAnnotator();
  const [copyLabel, setCopyLabel] = createSignal('Copy JSON');
  const [activeCtxIdx, setActiveCtxIdx] = createSignal(0);
  const [exportedJson, setExportedJson] = createSignal('');
  const [showImportPanel, setShowImportPanel] = createSignal(false);
  const [importJsonText, setImportJsonText] = createSignal('');
  const [displayedCtxIds, setDisplayedCtxIds] = createSignal<AnnotationContextId[]>([]);

  createEffect(() => {
    actions.setDisplayedContexts(displayedCtxIds());
  });

  // Initialize contexts
  actions.setContexts(CONTEXTS);
  actions.setActiveContext(CONTEXTS[0]!.id);

  // Auto-assign first image to cell 0
  actions.assignImageToCell(0, IMAGES[0]!.id);

  // Test-only hooks consumed by E2E (auto-init-fabric.spec.ts). Exposes the
  // current serialized document and the live Fabric `customProperties` array so
  // the test can assert the `id` registration is correct and idempotent.
  (
    window as unknown as {
      __osdTest?: {
        serialize: () => ReturnType<typeof serialize>;
        fabricCustomProperties: () => string[];
      };
    }
  ).__osdTest = {
    serialize: () => serialize(annotationState),
    fabricCustomProperties: () => [...(FabricObject.customProperties ?? [])],
  };

  const copyAnnotationsToClipboard = () => {
    const json = JSON.stringify(annotationState.byImage, null, 2);
    navigator.clipboard
      .writeText(json)
      .then(() => {
        setCopyLabel('Copied!');
        setTimeout(() => setCopyLabel('Copy JSON'), 1500);
      })
      .catch(() => {
        setCopyLabel('Failed');
        setTimeout(() => setCopyLabel('Copy JSON'), 1500);
      });
  };

  const handleExportJson = () => {
    const doc = serialize(annotationState);
    const json = JSON.stringify(doc, null, 2);
    setExportedJson(json);
  };

  const openImportPanel = () => {
    setImportJsonText('');
    setShowImportPanel(true);
  };

  const confirmImport = () => {
    const json = importJsonText();
    if (!json.trim()) return;
    try {
      const parsed: unknown = JSON.parse(json);
      const { byImage } = deserialize(parsed);
      actions.loadAnnotations(byImage);
      setShowImportPanel(false);
      setImportJsonText('');
    } catch (err) {
      alert(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleContextChange = (e: Event) => {
    const select = e.target as HTMLSelectElement;
    const idx = parseInt(select.value, 10);
    setActiveCtxIdx(idx);
    actions.setActiveContext(CONTEXTS[idx]!.id);
    actions.setActiveTool(null);
  };

  const buttonStyle = {
    padding: '4px 12px',
    border: '1px solid #555',
    'border-radius': '4px',
    cursor: 'pointer',
    background: '#2a2a3e',
    color: '#fff',
    'font-size': '12px',
  };

  return (
    <div style={{ width: '100vw', height: '100vh', display: 'flex', 'flex-direction': 'column' }}>
      {/* Top bar */}
      <div
        style={{
          padding: '8px 12px',
          background: '#1a1a2e',
          color: '#fff',
          display: 'flex',
          gap: '12px',
          'align-items': 'center',
          'font-family': 'system-ui, sans-serif',
          'font-size': '14px',
          'flex-shrink': '0',
          'flex-wrap': 'wrap',
        }}
      >
        <select
          value={activeCtxIdx()}
          onChange={handleContextChange}
          style={{
            padding: '4px 8px',
            'border-radius': '4px',
            border: '1px solid #555',
            background: '#2a2a3e',
            color: '#fff',
            'font-size': '13px',
          }}
        >
          {CONTEXTS.map((ctx, i) => (
            <option value={i}>{ctx.label}</option>
          ))}
        </select>

        <div
          data-testid="displayed-contexts-panel"
          style={{ display: 'flex', gap: '8px', 'align-items': 'center' }}
        >
          <span style={{ 'font-size': '12px', color: '#aaa' }}>Show:</span>
          {CONTEXTS.map((ctx) => (
            <label
              style={{
                display: 'flex',
                gap: '4px',
                'align-items': 'center',
                'font-size': '12px',
                cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                data-testid={`display-ctx-${ctx.id}`}
                checked={displayedCtxIds().includes(ctx.id)}
                onChange={(e) => {
                  const checked = e.currentTarget.checked;
                  setDisplayedCtxIds((prev) =>
                    checked ? [...prev, ctx.id] : prev.filter((id) => id !== ctx.id),
                  );
                }}
              />
              {ctx.label}
            </label>
          ))}
        </div>

        <Toolbar />
        <ViewControls />

        <GridControls maxColumns={4} maxRows={4} />

        <div style={{ 'margin-left': 'auto', display: 'flex', gap: '6px' }}>
          <button onClick={copyAnnotationsToClipboard} style={buttonStyle}>
            {copyLabel()}
          </button>
          <button onClick={handleExportJson} style={buttonStyle}>
            Export JSON
          </button>
          <button onClick={openImportPanel} style={buttonStyle}>
            Import JSON
          </button>
        </div>
      </div>

      {/* Body: Filmstrip + Grid */}
      <div style={{ display: 'flex', flex: '1', 'min-height': '0' }}>
        <Filmstrip images={IMAGES} position="left" />
        <div style={{ flex: '1', 'min-width': '0', 'min-height': '0' }}>
          <GridView
            columns={uiState.gridColumns}
            rows={uiState.gridRows}
            maxColumns={4}
            maxRows={4}
            images={IMAGES}
          />
        </div>
      </div>

      {/* Status bar */}
      <StatusBar imageId={activeImageId()} showFps={true} />

      {/* Hidden, reactive serialization of all annotations — a stable hook for
          E2E assertions on geometry (type/point counts) without clipboard. */}
      <div data-testid="annotations-json" style={{ display: 'none' }}>
        {JSON.stringify(annotationState.byImage)}
      </div>

      {/* JSON import panel */}
      {showImportPanel() && (
        <div
          style={{
            position: 'fixed',
            bottom: '40px',
            left: '10px',
            width: '400px',
            'max-height': '340px',
            background: '#1a1a2e',
            border: '1px solid #555',
            'border-radius': '8px',
            padding: '8px',
            'z-index': '1000',
            display: 'flex',
            'flex-direction': 'column',
            gap: '6px',
          }}
        >
          <div
            style={{ display: 'flex', 'justify-content': 'space-between', 'align-items': 'center' }}
          >
            <span style={{ color: '#fff', 'font-size': '12px', 'font-weight': 'bold' }}>
              Import JSON
            </span>
            <button
              onClick={() => setShowImportPanel(false)}
              style={{
                background: 'none',
                border: 'none',
                color: '#aaa',
                cursor: 'pointer',
                'font-size': '14px',
              }}
            >
              X
            </button>
          </div>
          <textarea
            placeholder="Paste exported JSON here..."
            value={importJsonText()}
            onInput={(e) => setImportJsonText(e.currentTarget.value)}
            style={{
              width: '100%',
              height: '240px',
              background: '#111',
              color: '#0f0',
              border: '1px solid #333',
              'border-radius': '4px',
              padding: '6px',
              'font-family': 'monospace',
              'font-size': '11px',
              resize: 'none',
              'box-sizing': 'border-box',
            }}
          />
          <div style={{ display: 'flex', gap: '6px', 'justify-content': 'flex-end' }}>
            <button onClick={() => setShowImportPanel(false)} style={buttonStyle}>
              Close
            </button>
            <button
              onClick={confirmImport}
              style={{ ...buttonStyle, background: '#1a5c2a', 'border-color': '#2a8a3e' }}
            >
              Confirm
            </button>
          </div>
        </div>
      )}

      {/* JSON export panel */}
      {exportedJson() && (
        <div
          style={{
            position: 'fixed',
            bottom: '40px',
            right: '10px',
            width: '400px',
            'max-height': '300px',
            background: '#1a1a2e',
            border: '1px solid #555',
            'border-radius': '8px',
            padding: '8px',
            overflow: 'auto',
            'z-index': '1000',
          }}
        >
          <div
            style={{ display: 'flex', 'justify-content': 'space-between', 'margin-bottom': '4px' }}
          >
            <span style={{ color: '#fff', 'font-size': '12px', 'font-weight': 'bold' }}>
              Exported JSON
            </span>
            <button
              onClick={() => setExportedJson('')}
              style={{
                background: 'none',
                border: 'none',
                color: '#aaa',
                cursor: 'pointer',
                'font-size': '14px',
              }}
            >
              X
            </button>
          </div>
          <textarea
            value={exportedJson()}
            onInput={(e) => setExportedJson(e.currentTarget.value)}
            style={{
              width: '100%',
              height: '240px',
              background: '#111',
              color: '#0f0',
              border: 'none',
              'border-radius': '4px',
              padding: '6px',
              'font-family': 'monospace',
              'font-size': '11px',
              resize: 'none',
            }}
          />
        </div>
      )}
    </div>
  );
}

// Example DOM-decoration content payload. `content` is stable config; any
// dynamic data should be read reactively inside the rendered component.
interface BadgeContent {
  readonly annotationId: string;
  readonly label: string;
}

// A consumer-authored provider: one interactive DOM badge per annotation,
// anchored above the annotation's centroid.
const domBadgeProvider: DecorationProvider<OsdFields> = ({ annotations }) =>
  annotations.map(
    (ann): DomDecoration => ({
      type: 'dom',
      id: `badge:${ann.id}`,
      relatedAnnotationIds: [ann.id],
      anchor: centroid(ann.geometry),
      offset: { x: 0, y: -28 },
      placement: 'bottom',
      content: { annotationId: ann.id, label: ann.label ?? ann.toolType } satisfies BadgeContent,
    }),
  );

function App() {
  return (
    <AnnotatorProvider
      renderDomDecoration={(decoration) => {
        const content = decoration.content as BadgeContent;
        return (
          <button
            type="button"
            data-osdlabel-test="dom-badge"
            style={{
              background: '#9c27b0',
              color: '#fff',
              border: 'none',
              'border-radius': '4px',
              padding: '2px 8px',
              'font-size': '12px',
              cursor: 'pointer',
              'box-shadow': '0 1px 3px rgba(0,0,0,0.4)',
            }}
            onClick={() => console.log('DOM decoration clicked for', content.annotationId)}
          >
            ★ {content.label}
          </button>
        );
      }}
      onAnnotationsChange={(anns) => console.log('Annotations changed:', anns.length, 'total')}
      onConstraintChange={(status) => console.log('Constraint status changed:', status)}
      testMode={true}
      defaultPixelSpacing={{ x: 1, y: 1, unit: 'px' }}
      decorationProviders={[
        withSelectionEmphasis(
          createMeasurementProvider({ area: true, perimeter: true, length: true, radius: true }),
          {
            selectedTextStyle: { zIndex: 10, background: 'rgba(33, 150, 243, 0.9)', color: '#fff' },
            selectedLineStyle: { stroke: '#2196f3', strokeWidth: 3 },
          },
        ),
        withSelectionEmphasis(createLabelProvider(), {
          selectedTextStyle: { zIndex: 10, background: 'rgba(33, 150, 243, 0.9)', color: '#fff' },
        }),
        withSelectionEmphasis(
          createDistanceProvider({
            pair: (annotations) => {
              const points = annotations.filter((a) => a.geometry.type === 'point');
              const pairs = [];
              for (let i = 0; i < points.length - 1; i += 2) {
                pairs.push({ a: points[i]!, b: points[i + 1]! });
              }
              return pairs;
            },
          }),
          {
            selectedLineStyle: { stroke: '#2196f3', strokeWidth: 3 },
            selectedTextStyle: { zIndex: 10, background: 'rgba(33, 150, 243, 0.9)', color: '#fff' },
          },
        ),
        domBadgeProvider,
      ]}
    >
      <AppContent />
    </AnnotatorProvider>
  );
}

const root = document.getElementById('app');
if (root) {
  render(() => <App />, root);
}
