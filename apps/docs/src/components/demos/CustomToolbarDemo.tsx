import { GridView, StatusBar } from 'osdlabel/components';
import { createImageId } from '@osdlabel/annotation';
import { createAnnotationContextId } from '@osdlabel/annotation-context';
import { useConstraints } from 'osdlabel/hooks';
import { AnnotatorProvider, useAnnotator } from 'osdlabel/state';
import type { ToolType } from '@osdlabel/annotation';
import type { ImageSource } from '@osdlabel/viewer-api';
import type { AnnotationContext } from '@osdlabel/annotation-context';
import { initFabricModule } from 'osdlabel';
import { onMount } from 'solid-js';

initFabricModule();

const images: ImageSource[] = [
  {
    id: createImageId('sample'),
    tileSource: 'https://openseadragon.github.io/example-images/highsmith/highsmith.dzi',
    label: 'Sample',
  },
];

const contexts: AnnotationContext[] = [
  {
    id: createAnnotationContextId('default'),
    label: 'Default',
    tools: [{ type: 'rectangle', maxCount: 5 }, { type: 'circle', maxCount: 3 }, { type: 'line' }],
  },
];

function CustomToolbar() {
  const { actions, uiState, constraintStatus } = useAnnotator();
  const { isToolEnabled } = useConstraints();

  const tools: { type: ToolType | 'select'; label: string }[] = [
    { type: 'select', label: 'Select' },
    { type: 'rectangle', label: 'Rect' },
    { type: 'circle', label: 'Circle' },
    { type: 'line', label: 'Line' },
  ];

  const toolInfo = (type: ToolType) => {
    const status = constraintStatus();
    const s = status[type];
    if (s.maxCount === null) return '';
    return ` (${s.currentCount}/${s.maxCount})`;
  };

  return (
    <div style={{ display: 'flex', gap: '4px', padding: '8px', background: '#1a1a2e' }}>
      {tools.map((tool) => (
        <button
          disabled={tool.type !== 'select' && !isToolEnabled(tool.type as ToolType)}
          onClick={() => actions.setActiveTool(tool.type)}
          style={{
            padding: '4px 8px',
            border: uiState.activeTool === tool.type ? '2px solid #4f6df5' : '1px solid #555',
            'border-radius': '4px',
            background: uiState.activeTool === tool.type ? '#2a2a5e' : '#2a2a3e',
            color: '#fff',
            cursor: 'pointer',
            opacity: tool.type !== 'select' && !isToolEnabled(tool.type as ToolType) ? '0.5' : '1',
            'font-size': '12px',
          }}
        >
          {tool.label}
          {tool.type !== 'select' && toolInfo(tool.type as ToolType)}
        </button>
      ))}

      <button
        onClick={() => actions.setActiveTool(null)}
        style={{
          'margin-left': 'auto',
          padding: '4px 8px',
          border: '1px solid #555',
          'border-radius': '4px',
          background: '#2a2a3e',
          color: '#fff',
          cursor: 'pointer',
          'font-size': '12px',
        }}
      >
        Navigate
      </button>
    </div>
  );
}

function AppContent() {
  const { uiState, actions, activeImageId } = useAnnotator();

  onMount(() => {
    actions.setContexts(contexts);
    actions.setActiveContext(contexts[0]!.id);
    actions.assignImageToCell(0, createImageId('sample'));
  });

  return (
    <div
      class="osdlabel-container"
      style={{
        height: '420px',
        display: 'flex',
        'flex-direction': 'column',
        border: '1px solid #333',
        'border-radius': '6px',
        overflow: 'hidden',
      }}
    >
      <CustomToolbar />
      <div style={{ flex: '1', 'min-height': '0' }}>
        <GridView columns={1} rows={1} maxColumns={1} maxRows={1} images={images} />
      </div>
      <StatusBar imageId={activeImageId()} />
    </div>
  );
}

export default function CustomToolbarDemo() {
  return (
    <div style={{ margin: '1rem 0' }}>
      <AnnotatorProvider>
        <AppContent />
      </AnnotatorProvider>
    </div>
  );
}
