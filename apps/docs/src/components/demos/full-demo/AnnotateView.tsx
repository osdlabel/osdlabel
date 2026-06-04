import { createSignal, createEffect, For, type Accessor, type Setter } from 'solid-js';
import {
  Toolbar,
  StatusBar,
  GridView,
  Filmstrip,
  GridControls,
  ViewControls,
  AnnotatorProvider,
  useAnnotator,
  serialize,
  deserialize,
  createMeasurementProvider,
  createLabelProvider,
  createDistanceProvider,
  withSelectionEmphasis,
} from '@osdlabel/solid';
import type {
  AnnotationContextId,
  AnnotationContext,
  ImageSource,
  DecorationProvider,
  OsdFields,
} from '@osdlabel/solid';

const selectedTextStyle = {
  zIndex: 10,
  background: 'rgba(33, 150, 243, 0.9)',
  color: '#fff',
};
const selectedLineStyle = { stroke: '#2196f3', strokeWidth: 3 };

// Gate a provider behind a reactive toggle. The returned provider reads the
// signal at call time; because ViewerCell invokes providers inside its
// decoration `createEffect`, Solid tracks the signal and re-runs the effect
// (and `setDecorations`) whenever the toggle flips — live, without remounting.
const gate =
  (
    enabled: Accessor<boolean>,
    provider: DecorationProvider<OsdFields>,
  ): DecorationProvider<OsdFields> =>
  (ctx) =>
    enabled() ? provider(ctx) : [];

interface DecorationToggles {
  showMeasurements: Accessor<boolean>;
  setShowMeasurements: Setter<boolean>;
  showLabels: Accessor<boolean>;
  setShowLabels: Setter<boolean>;
  showDistance: Accessor<boolean>;
  setShowDistance: Setter<boolean>;
}

export interface AnnotateViewProps {
  images: readonly ImageSource[];
  contexts: readonly AnnotationContext[];
  onReconfigure: () => void;
}

function AppContent(props: AnnotateViewProps & { toggles: DecorationToggles }) {
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

  // Initialize contexts and active image
  actions.setContexts([...props.contexts]);
  if (props.contexts[0]) {
    actions.setActiveContext(props.contexts[0].id);
  }
  if (props.images[0]) {
    actions.assignImageToCell(0, props.images[0].id);
  }

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
    setExportedJson(JSON.stringify(doc, null, 2));
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
    const ctx = props.contexts[idx];
    if (ctx) actions.setActiveContext(ctx.id);
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
    <div style={{ width: '100%', height: '100%', display: 'flex', 'flex-direction': 'column' }}>
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
          <For each={props.contexts}>{(ctx, i) => <option value={i()}>{ctx.label}</option>}</For>
        </select>

        <div style={{ display: 'flex', gap: '8px', 'align-items': 'center' }}>
          <span style={{ 'font-size': '12px', color: '#aaa' }}>Show:</span>
          <For each={props.contexts}>
            {(ctx) => (
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
            )}
          </For>
        </div>

        <div style={{ display: 'flex', gap: '8px', 'align-items': 'center' }}>
          <span style={{ 'font-size': '12px', color: '#aaa' }}>Decorations:</span>
          <For
            each={
              [
                ['Measurements', props.toggles.showMeasurements, props.toggles.setShowMeasurements],
                ['Labels', props.toggles.showLabels, props.toggles.setShowLabels],
                ['Distance', props.toggles.showDistance, props.toggles.setShowDistance],
              ] as const
            }
          >
            {([label, get, set]) => (
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
                  checked={get()}
                  onChange={(e) => set(e.currentTarget.checked)}
                />
                {label}
              </label>
            )}
          </For>
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
          <button
            onClick={props.onReconfigure}
            style={{ ...buttonStyle, background: '#3e2a1a', 'border-color': '#8a5a2a' }}
          >
            Reconfigure
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', flex: '1', 'min-height': '0' }}>
        <Filmstrip images={[...props.images]} position="left" />
        <div style={{ flex: '1', 'min-width': '0', 'min-height': '0' }}>
          <GridView
            columns={uiState.gridColumns}
            rows={uiState.gridRows}
            maxColumns={4}
            maxRows={4}
            images={[...props.images]}
          />
        </div>
      </div>

      <StatusBar imageId={activeImageId()} showFps={true} />

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

export default function AnnotateView(props: AnnotateViewProps) {
  const [showMeasurements, setShowMeasurements] = createSignal(true);
  const [showLabels, setShowLabels] = createSignal(true);
  const [showDistance, setShowDistance] = createSignal(true);

  const decorationProviders: readonly DecorationProvider<OsdFields>[] = [
    gate(
      showMeasurements,
      withSelectionEmphasis(
        createMeasurementProvider({ area: true, perimeter: true, length: true, radius: true }),
        { selectedTextStyle, selectedLineStyle },
      ),
    ),
    gate(showLabels, withSelectionEmphasis(createLabelProvider(), { selectedTextStyle })),
    gate(
      showDistance,
      withSelectionEmphasis(
        createDistanceProvider({
          // Pair every two consecutive point annotations.
          pair: (annotations) => {
            const points = annotations.filter((a) => a.geometry.type === 'point');
            const pairs: { a: (typeof points)[number]; b: (typeof points)[number] }[] = [];
            for (let i = 0; i < points.length - 1; i += 2) {
              pairs.push({ a: points[i]!, b: points[i + 1]! });
            }
            return pairs;
          },
        }),
        { selectedTextStyle, selectedLineStyle },
      ),
    ),
  ];

  const toggles: DecorationToggles = {
    showMeasurements,
    setShowMeasurements,
    showLabels,
    setShowLabels,
    showDistance,
    setShowDistance,
  };

  return (
    <AnnotatorProvider
      decorationProviders={decorationProviders}
      defaultPixelSpacing={{ x: 1, y: 1, unit: 'px' }}
    >
      <AppContent {...props} toggles={toggles} />
    </AnnotatorProvider>
  );
}
