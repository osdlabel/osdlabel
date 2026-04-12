import { createSignal, createEffect, Show } from 'solid-js';
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
} from '@osdlabel/solid';
import type { AnnotationContextId, AnnotationContext, ImageSource } from '@osdlabel/solid';

initFabricModule();

const DEFAULT_IMAGES = [
  {
    id: 'highsmith',
    tileSource: 'https://openseadragon.github.io/example-images/highsmith/highsmith.dzi',
    label: 'Highsmith',
  },
  {
    id: 'duomo',
    tileSource: 'https://openseadragon.github.io/example-images/duomo/duomo.dzi',
    label: 'Duomo',
  },
];

const DEFAULT_CONTEXTS = [
  {
    id: 'ctx-1',
    label: 'Default Context',
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

function AnnotatorInterface(props: {
  images: ImageSource[];
  contexts: AnnotationContext[];
  onBack: () => void;
}) {
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

  createEffect(() => {
    actions.setContexts(props.contexts);
    if (props.contexts.length > 0) {
      actions.setActiveContext(props.contexts[0]!.id);
      setActiveCtxIdx(0);
    }
  });

  createEffect(() => {
    if (props.images.length > 0) {
      actions.assignImageToCell(0, props.images[0]!.id);
    }
  });

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
    actions.setActiveContext(props.contexts[idx]!.id);
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
        <button onClick={props.onBack} style={{ ...buttonStyle, background: '#5a2a2a' }}>
          &larr; Setup
        </button>
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
          {props.contexts.map((ctx, i) => (
            <option value={i}>{ctx.label}</option>
          ))}
        </select>

        <div style={{ display: 'flex', gap: '8px', 'align-items': 'center' }}>
          <span style={{ 'font-size': '12px', color: '#aaa' }}>Show:</span>
          {props.contexts.map((ctx) => (
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

      <div style={{ display: 'flex', flex: '1', 'min-height': '0' }}>
        <Filmstrip images={props.images} position="left" />
        <div style={{ flex: '1', 'min-width': '0', 'min-height': '0' }}>
          <GridView
            columns={uiState.gridColumns}
            rows={uiState.gridRows}
            maxColumns={4}
            maxRows={4}
            images={props.images}
          />
        </div>
      </div>

      <StatusBar imageId={activeImageId()} showFps={true} />

      {/* JSON panels omitted for brevity but similar to Dev app */}
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
              style={{ background: 'none', border: 'none', color: '#aaa', cursor: 'pointer' }}
            >
              X
            </button>
          </div>
          <textarea
            value={importJsonText()}
            onInput={(e) => setImportJsonText(e.currentTarget.value)}
            style={{
              width: '100%',
              height: '240px',
              background: '#111',
              color: '#0f0',
              'font-family': 'monospace',
              'font-size': '11px',
            }}
          />
          <div style={{ display: 'flex', gap: '6px', 'justify-content': 'flex-end' }}>
            <button onClick={() => setShowImportPanel(false)} style={buttonStyle}>
              Close
            </button>
            <button onClick={confirmImport} style={buttonStyle}>
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
            'z-index': '1000',
            display: 'flex',
            'flex-direction': 'column',
            gap: '6px',
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
              style={{ background: 'none', border: 'none', color: '#aaa', cursor: 'pointer' }}
            >
              X
            </button>
          </div>
          <textarea
            value={exportedJson()}
            readOnly
            style={{
              width: '100%',
              height: '240px',
              background: '#111',
              color: '#0f0',
              'font-family': 'monospace',
              'font-size': '11px',
            }}
          />
        </div>
      )}
    </div>
  );
}

export default function DemoApp() {
  const [mode, setMode] = createSignal<'setup' | 'annotate'>('setup');
  const [imagesText, setImagesText] = createSignal(JSON.stringify(DEFAULT_IMAGES, null, 2));
  const [contextsText, setContextsText] = createSignal(JSON.stringify(DEFAULT_CONTEXTS, null, 2));
  const [errorMsg, setErrorMsg] = createSignal('');

  const [parsedImages, setParsedImages] = createSignal<ImageSource[]>([]);
  const [parsedContexts, setParsedContexts] = createSignal<AnnotationContext[]>([]);

  const handleStart = () => {
    try {
      const rawImages = JSON.parse(imagesText());
      const rawContexts = JSON.parse(contextsText());

      // Map raw IDs to branded types
      const mappedImages = rawImages.map((img: any) => ({
        ...img,
        id: createImageId(img.id),
      })) as ImageSource[];

      const mappedContexts = rawContexts.map((ctx: any) => {
        const out = { ...ctx, id: ctx.id as AnnotationContextId };
        if (ctx.imageIds) {
          out.imageIds = ctx.imageIds.map((id: string) => createImageId(id));
        }
        return out;
      }) as AnnotationContext[];

      setParsedImages(mappedImages);
      setParsedContexts(mappedContexts);
      setErrorMsg('');
      setMode('annotate');
    } catch (e: any) {
      setErrorMsg(`Configuration Error: ${e.message}`);
    }
  };

  return (
    <Show
      when={mode() === 'annotate'}
      fallback={
        <div
          style={{
            padding: '2rem',
            'font-family': 'system-ui, sans-serif',
            'max-width': '800px',
            margin: '0 auto',
            color: '#eee',
          }}
        >
          <h1>Demo App Setup</h1>
          <p>Configure your image sources and annotation contexts below.</p>

          {errorMsg() && <div style={{ color: 'red', margin: '1rem 0' }}>{errorMsg()}</div>}

          <div style={{ display: 'flex', 'flex-direction': 'column', gap: '1rem' }}>
            <div>
              <h3>Images (JSON)</h3>
              <textarea
                value={imagesText()}
                onInput={(e) => setImagesText(e.currentTarget.value)}
                style={{
                  width: '100%',
                  height: '200px',
                  'font-family': 'monospace',
                  background: '#111',
                  color: '#fff',
                  border: '1px solid #444',
                  padding: '8px',
                }}
              />
            </div>
            <div>
              <h3>Annotation Contexts (JSON)</h3>
              <textarea
                value={contextsText()}
                onInput={(e) => setContextsText(e.currentTarget.value)}
                style={{
                  width: '100%',
                  height: '300px',
                  'font-family': 'monospace',
                  background: '#111',
                  color: '#fff',
                  border: '1px solid #444',
                  padding: '8px',
                }}
              />
            </div>
            <button
              onClick={handleStart}
              style={{
                padding: '10px 20px',
                background: '#2563eb',
                color: '#fff',
                border: 'none',
                'border-radius': '4px',
                cursor: 'pointer',
                'font-size': '16px',
              }}
            >
              Launch Annotator
            </button>
            <a href="/osdlabel/" style={{ color: '#aaa', 'text-decoration': 'none' }}>
              &larr; Back to Docs
            </a>
          </div>
        </div>
      }
    >
      <AnnotatorProvider>
        <AnnotatorInterface
          images={parsedImages()}
          contexts={parsedContexts()}
          onBack={() => setMode('setup')}
        />
      </AnnotatorProvider>
    </Show>
  );
}
