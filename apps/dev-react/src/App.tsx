import { useCallback, useState, useEffect, useLayoutEffect } from 'react';
import {
  Toolbar,
  StatusBar,
  GridView,
  Filmstrip,
  GridControls,
  ViewControls,
  createImageId,
  createInitialAnnotationState,
  AnnotatorProvider,
  useAnnotator,
  serialize,
  deserialize,
  createMeasurementProvider,
  cocoRleCodec,
  cocoRleUncompressedCodec,
  createMaskCodecRegistry,
  createLabelProvider,
  createDistanceProvider,
  withSelectionEmphasis,
  centroid,
  measureLength,
} from '@osdlabel/react';
import type {
  AnnotationContextId,
  AnnotationContext,
  ImageSource,
  DecorationProvider,
  DomDecoration,
  TextDecoration,
  OsdFields,
  AnnotationState,
} from '@osdlabel/react';
import { FabricObject } from 'fabric';

// NOTE: initFabricModule() is intentionally NOT called here. The library
// registers the Fabric `id` custom property automatically when a FabricOverlay
// mounts, so this dev harness dogfoods that auto-registration. The E2E test
// `auto-init-fabric.spec.ts`, which runs against both dev apps, relies on this.

// Test-only hooks consumed by E2E (auto-init-fabric.spec.ts). Exposes the
// current serialized document and the live Fabric `customProperties` array so
// the test can assert the `id` registration is correct and idempotent.
// Installed at module load, as the Solid app's are during its synchronous
// first render: React's first render commits asynchronously, possibly after
// `page.goto` resolves, so a hook installed by an effect could be missing
// when a spec first reads it. `AppContent` keeps `latestAnnotationState`
// current.
let latestAnnotationState: AnnotationState<OsdFields> = createInitialAnnotationState();
(
  window as unknown as {
    __osdTest?: {
      serialize: () => ReturnType<typeof serialize>;
      fabricCustomProperties: () => string[];
    };
  }
).__osdTest = {
  serialize: () => serialize(latestAnnotationState),
  fabricCustomProperties: () => [...(FabricObject.customProperties ?? [])],
};

// Example DOM-decoration content payload (stable config).
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

// A consumer-authored cell-anchored ("HUD") provider: a fixed readout pinned to
// the top-right corner of the cell's viewport, unaffected by pan/zoom/rotate/flip.
// Emits nothing until the cell holds at least two line annotations.
// Lengths go through `measureLength`, so on an anisotropic image the ratio
// agrees with the lines' own `L:` labels (#187).
const lineRatioHudProvider: DecorationProvider<OsdFields> = ({ annotations, pixelSpacing }) => {
  const lines = annotations.filter((ann) => ann.geometry.type === 'line');
  const first = lines[0];
  const second = lines[1];
  if (!first || !second) return [];
  const l1 = measureLength(first.geometry, pixelSpacing).value;
  const l2 = measureLength(second.geometry, pixelSpacing).value;
  if (l1 === 0 || l2 === 0) return [];
  return [
    {
      type: 'text',
      id: 'hud:ratio',
      relatedAnnotationIds: [first.id, second.id],
      anchorSpace: 'cell',
      anchor: { x: 1, y: 0 },
      placement: 'top-right',
      offset: { x: -8, y: 8 },
      text: `L1/L2 ratio: ${(l1 / l2).toFixed(2)}\nL2/L1 ratio: ${(l2 / l1).toFixed(2)}`,
    } satisfies TextDecoration,
  ];
};

const SELECTED_TEXT_STYLE = { zIndex: 10, background: 'rgba(33, 150, 243, 0.9)', color: '#fff' };
const SELECTED_LINE_STYLE = { stroke: '#2196f3', strokeWidth: 3 };

// The same providers as `apps/dev`, so the E2E specs both apps run see the same
// decorations. Module-level so the array keeps its identity across renders.
const DECORATION_PROVIDERS: readonly DecorationProvider<OsdFields>[] = [
  withSelectionEmphasis(
    createMeasurementProvider({ area: true, perimeter: true, length: true, radius: true }),
    { selectedTextStyle: SELECTED_TEXT_STYLE, selectedLineStyle: SELECTED_LINE_STYLE },
  ),
  withSelectionEmphasis(createLabelProvider(), { selectedTextStyle: SELECTED_TEXT_STYLE }),
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
    { selectedLineStyle: SELECTED_LINE_STYLE, selectedTextStyle: SELECTED_TEXT_STYLE },
  ),
  domBadgeProvider,
  lineRatioHudProvider,
];

/** Local images only, matching `apps/dev` — see the note there and issue #144. */
const IMAGES: ImageSource[] = [
  {
    id: createImageId('landscape'),
    tileSource: './sample-data/landscape.png',
    label: 'Landscape',
  },
  {
    id: createImageId('portrait'),
    tileSource: './sample-data/portrait.png',
    label: 'Portrait',
  },
  {
    id: createImageId('wide'),
    // An OpenSeadragon tile-source object rather than a URL, so the E2E suite
    // opens the object form too (#83).
    tileSource: { type: 'image', url: './sample-data/wide.png' },
    label: 'Wide image',
  },
  {
    id: createImageId('tiled'),
    tileSource: './sample-data/tiled.dzi',
    label: 'Tiled (DZI)',
  },
];

const CONTEXTS: AnnotationContext[] = [
  {
    id: 'ctx-1' as AnnotationContextId,
    label: 'Fracture',
    imageIds: [createImageId('landscape'), createImageId('portrait')],
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
      // A visible defaultStyle so the harness dogfoods it reaching the
      // in-progress preview and vertex markers, not just the committed shape.
      { type: 'polyline', defaultStyle: { strokeColor: '#00e5ff', strokeWidth: 3 } },
      { type: 'freeHandPath' },
      { type: 'segmentationBrush' },
    ],
  },
];

/** Mask formats the import panel can read back in, beyond the canonical one. */
const MASK_CODECS = createMaskCodecRegistry(cocoRleCodec, cocoRleUncompressedCodec);

function AppContent() {
  const { uiState, annotationState, actions, activeImageId, fullscreenTargetRef } = useAnnotator();

  // Claim this component's root as the fullscreen target. <Annotator> does the
  // same with its own root; a hand-composed layout registers whichever element
  // wraps the annotator UI. useCallback so the ref is not detached and
  // reattached on every render.
  const setFullscreenRoot = useCallback(
    (el: HTMLDivElement | null) => {
      fullscreenTargetRef.element = el;
    },
    [fullscreenTargetRef],
  );

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

  // Keep `window.__osdTest` (installed at module load, below the imports)
  // reading the latest committed state.
  useLayoutEffect(() => {
    latestAnnotationState = annotationState;
  }, [annotationState]);

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

  /**
   * Exports osdlabel annotations with mask payloads re-encoded as COCO RLE, so
   * the codec path can be eyeballed by hand. Vector annotations are untouched.
   *
   * This is **not** a COCO dataset document — there are no `images`,
   * `annotations`, or `categories` sections. Assembling one from these
   * segmentations is the consumer's job.
   */
  const handleExportCoco = () => {
    const doc = serialize(annotationState, { maskCodec: cocoRleCodec });
    setExportedJson(JSON.stringify(doc, null, 2));
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
      const { byImage, skipped } = deserialize(parsed, { maskCodecs: MASK_CODECS });
      // A mask whose pixels cannot be decoded is dropped rather than failing
      // the import, so a silent partial load is possible unless this is checked.
      if (skipped.length > 0) {
        alert(
          `${skipped.length} annotation(s) could not be loaded:\n` +
            skipped.map((s) => `  ${s.id ?? '(no id)'}: ${s.reason}`).join('\n'),
        );
      }
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
    <div
      ref={setFullscreenRoot}
      style={{ width: '100vw', height: '100vh', display: 'flex', flexDirection: 'column' }}
    >
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
          <button
            type="button"
            data-testid="export-coco"
            onClick={handleExportCoco}
            style={buttonStyle}
          >
            Export COCO RLE
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

      {/* Hidden serialization of all annotations — a stable hook for E2E
          assertions on geometry (type/point counts) without clipboard. */}
      <div data-testid="annotations-json" style={{ display: 'none' }}>
        {JSON.stringify(annotationState.byImage)}
      </div>

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
            data-testid="exported-json"
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
      // The brush's pixel cap and what to do when a stroke exceeds it. The
      // stroke is abandoned whole and nothing on screen changes, so this
      // callback is the only chance to say why — a harness that omits it is
      // showing consumers a silent failure.
      brushOptions={{
        onCapacityExceeded: (error) => {
          console.warn('osdlabel: brush stroke exceeded its pixel cap', error);
          alert(`Stroke too large: ${error.message}`);
        },
      }}
      onAnnotationsChange={(anns) => console.log('Annotations changed:', anns.length, 'total')}
      onConstraintChange={(status) => console.log('Constraint status changed:', status)}
      testMode={true}
      defaultPixelSpacing={{ x: 1, y: 1, unit: 'px' }}
      decorationProviders={DECORATION_PROVIDERS}
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
              borderRadius: '4px',
              padding: '2px 8px',
              fontSize: '12px',
              cursor: 'pointer',
              boxShadow: '0 1px 3px rgba(0,0,0,0.4)',
            }}
            onClick={() => console.log('DOM decoration clicked for', content.annotationId)}
          >
            ★ {content.label}
          </button>
        );
      }}
    >
      <AppContent />
    </AnnotatorProvider>
  );
}
