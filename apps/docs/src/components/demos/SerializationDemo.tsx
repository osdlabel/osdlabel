import { createMemo, onMount } from 'solid-js';
import { initFabricModule } from 'osdlabel';
import { Annotator } from 'osdlabel/components';
import { AnnotatorProvider, useAnnotator } from 'osdlabel/state';
import { serialize, createImageId } from '@osdlabel/annotation';
import type { ImageSource } from '@osdlabel/annotation';
import { createAnnotationContextId } from '@osdlabel/annotation-context';
import type { AnnotationContext } from '@osdlabel/annotation-context';

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

function SerializedJson() {
  const { annotationState } = useAnnotator();

  const json = createMemo(() => {
    const doc = serialize(annotationState, images);
    return JSON.stringify(doc, null, 2);
  });

  return (
    <div
      style={{
        maxHeight: '450px',
        background: '#1e1e1e',
        color: '#00ff00',
        overflow: 'auto',
        padding: '8px',
        'font-family': 'monospace',
        'font-size': '11px',
        'border-top': '1px solid #333',
      }}
    >
      <pre>{json()}</pre>
    </div>
  );
}

function RealSerializationDemo() {
  return (
    <div
      class="osdlabel-container"
      style={{
        display: 'flex',
        'flex-direction': 'column',
        border: '1px solid #333',
        'border-radius': '6px',
        overflow: 'hidden',
        margin: '1rem 0',
        height: '1000px',
      }}
    >
      <Annotator
        images={images}
        contexts={contexts}
        filmstripPosition="left"
        maxGridSize={{ columns: 1, rows: 1 }}
        showGridControls
        showFilmstrip
        showViewControls
        showFps
        providerChildren={<SerializedJson />}
      />
    </div>
  );
}

export default function SerializationDemo() {
  return (
    <AnnotatorProvider>
      <RealSerializationDemo />
    </AnnotatorProvider>
  );
}
