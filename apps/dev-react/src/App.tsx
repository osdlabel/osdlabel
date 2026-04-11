import { useState, useEffect } from 'react';
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
  initFabricModule,
} from '@osdlabel/react';
import type { AnnotationContextId, AnnotationContext, ImageSource } from '@osdlabel/react';

initFabricModule();

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
  const [copyLabel, setCopyLabel] = useState('Copy JSON');
  const [activeCtxIdx, setActiveCtxIdx] = useState(0);
  const [exportedJson, setExportedJson] = useState('');
  const [showImportPanel, setShowImportPanel] = useState(false);
  const [importJsonText, setImportJsonText] = useState('');
  const [displayedCtxIds, setDisplayedCtxIds] = useState<AnnotationContextId[]>([]);

  useEffect(() => {
    actions.setDisplayedContexts(displayedCtxIds);
  }, [displayedCtxIds]); // eslint-disable-line react-hooks/exhaustive-deps

  // Initialize contexts
  useEffect(() => {
    actions.setContexts(CONTEXTS);
    actions.setActiveContext(CONTEXTS[0]!.id);
    actions.assignImageToCell(0, IMAGES[0]!.id);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
    const json = importJsonText;
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

  const handleContextChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const idx = parseInt(e.target.value, 10);
    setActiveCtxIdx(idx);
    actions.setActiveContext(CONTEXTS[idx]!.id);
    actions.setActiveTool(null);
  };

  const buttonStyle: React.CSSProperties = {
    padding: '4px 12px',
    border: '1px solid #555',
    borderRadius: '4px',
    cursor: 'pointer',
    background: '#2a2a3e',
    color: '#fff',
    fontSize: '12px',
  };

  return (
    <div style={{ width: '100vw', height: '100vh', display: 'flex', flexDirection: 'column' }}>
      {/* Top bar */}
      <div
        style={{
          padding: '8px 12px',
          background: '#1a1a2e',
          color: '#fff',
          display: 'flex',
          gap: '12px',
          alignItems: 'center',
          fontFamily: 'system-ui, sans-serif',
          fontSize: '14px',
          flexShrink: 0,
          flexWrap: 'wrap',
        }}
      >
        <select
          value={activeCtxIdx}
          onChange={handleContextChange}
          style={{
            padding: '4px 8px',
            borderRadius: '4px',
            border: '1px solid #555',
            background: '#2a2a3e',
            color: '#fff',
            fontSize: '13px',
          }}
        >
          {CONTEXTS.map((ctx, i) => (
            <option key={ctx.id} value={i}>
              {ctx.label}
            </option>
          ))}
        </select>

        <div
          data-testid="displayed-contexts-panel"
          style={{ display: 'flex', gap: '8px', alignItems: 'center' }}
        >
          <span style={{ fontSize: '12px', color: '#aaa' }}>Show:</span>
          {CONTEXTS.map((ctx) => (
            <label
              key={ctx.id}
              style={{
                display: 'flex',
                gap: '4px',
                alignItems: 'center',
                fontSize: '12px',
                cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                data-testid={`display-ctx-${ctx.id}`}
                checked={displayedCtxIds.includes(ctx.id)}
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

        <div style={{ marginLeft: 'auto', display: 'flex', gap: '6px' }}>
          <button type="button" onClick={copyAnnotationsToClipboard} style={buttonStyle}>
            {copyLabel}
          </button>
          <button type="button" onClick={handleExportJson} style={buttonStyle}>
            Export JSON
          </button>
          <button type="button" onClick={openImportPanel} style={buttonStyle}>
            Import JSON
          </button>
        </div>
      </div>

      {/* Body: Filmstrip + Grid */}
      <div style={{ display: 'flex', flex: '1', minHeight: '0' }}>
        <Filmstrip images={IMAGES} position="left" />
        <div style={{ flex: '1', minWidth: '0', minHeight: '0' }}>
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
      <StatusBar imageId={activeImageId} showFps={true} />

      {/* JSON import panel */}
      {showImportPanel && (
        <div
          style={{
            position: 'fixed',
            bottom: '40px',
            left: '10px',
            width: '400px',
            maxHeight: '340px',
            background: '#1a1a2e',
            border: '1px solid #555',
            borderRadius: '8px',
            padding: '8px',
            zIndex: 1000,
            display: 'flex',
            flexDirection: 'column',
            gap: '6px',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ color: '#fff', fontSize: '12px', fontWeight: 'bold' }}>Import JSON</span>
            <button
              type="button"
              onClick={() => setShowImportPanel(false)}
              style={{
                background: 'none',
                border: 'none',
                color: '#aaa',
                cursor: 'pointer',
                fontSize: '14px',
              }}
            >
              X
            </button>
          </div>
          <textarea
            placeholder="Paste exported JSON here..."
            value={importJsonText}
            onChange={(e) => setImportJsonText(e.currentTarget.value)}
            style={{
              width: '100%',
              height: '240px',
              background: '#111',
              color: '#0f0',
              border: '1px solid #333',
              borderRadius: '4px',
              padding: '6px',
              fontFamily: 'monospace',
              fontSize: '11px',
              resize: 'none',
              boxSizing: 'border-box',
            }}
          />
          <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end' }}>
            <button type="button" onClick={() => setShowImportPanel(false)} style={buttonStyle}>
              Close
            </button>
            <button
              type="button"
              onClick={confirmImport}
              style={{ ...buttonStyle, background: '#1a5c2a', borderColor: '#2a8a3e' }}
            >
              Confirm
            </button>
          </div>
        </div>
      )}

      {/* JSON export panel */}
      {exportedJson && (
        <div
          style={{
            position: 'fixed',
            bottom: '40px',
            right: '10px',
            width: '400px',
            maxHeight: '300px',
            background: '#1a1a2e',
            border: '1px solid #555',
            borderRadius: '8px',
            padding: '8px',
            overflow: 'auto',
            zIndex: 1000,
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
            <span style={{ color: '#fff', fontSize: '12px', fontWeight: 'bold' }}>
              Exported JSON
            </span>
            <button
              type="button"
              onClick={() => setExportedJson('')}
              style={{
                background: 'none',
                border: 'none',
                color: '#aaa',
                cursor: 'pointer',
                fontSize: '14px',
              }}
            >
              X
            </button>
          </div>
          <textarea
            value={exportedJson}
            onChange={(e) => setExportedJson(e.currentTarget.value)}
            style={{
              width: '100%',
              height: '240px',
              background: '#111',
              color: '#0f0',
              border: 'none',
              borderRadius: '4px',
              padding: '6px',
              fontFamily: 'monospace',
              fontSize: '11px',
              resize: 'none',
            }}
          />
        </div>
      )}
    </div>
  );
}

export default function App() {
  return (
    <AnnotatorProvider
      onAnnotationsChange={(anns) => console.log('Annotations changed:', anns.length, 'total')}
      onConstraintChange={(status) => console.log('Constraint status changed:', status)}
      testMode={true}
    >
      <AppContent />
    </AnnotatorProvider>
  );
}
