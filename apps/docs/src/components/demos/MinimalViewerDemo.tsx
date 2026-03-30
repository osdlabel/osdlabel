import { Annotator } from 'osdlabel/components';
import { createImageId } from '@osdlabel/annotation';
import type { ImageSource } from '@osdlabel/annotation';
import { createAnnotationContextId } from '@osdlabel/annotation-context';
import type { AnnotationContext } from '@osdlabel/annotation-context';
import { initFabricModule } from 'osdlabel';

initFabricModule();

const images: ImageSource[] = [
  {
    id: createImageId('sample-1'),
    tileSource: 'https://openseadragon.github.io/example-images/highsmith/highsmith.dzi',
    label: 'Highsmith',
  },
  {
    id: createImageId('sample-2'),
    tileSource: 'https://openseadragon.github.io/example-images/duomo/duomo.dzi',
    label: 'Duomo',
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
      { type: 'path' },
      { type: 'freeHandPath' },
    ],
  },
];

export default function MinimalViewerDemo() {
  return (
    <div
      class="osdlabel-container"
      style={{
        height: '500px',
        width: '100%',
        border: '1px solid #333',
        'border-radius': '6px',
        overflow: 'hidden',
        margin: '1rem 0',
      }}
    >
      <Annotator
        images={images}
        contexts={contexts}
        filmstripPosition="left"
        maxGridSize={{ columns: 4, rows: 4 }}
        showGridControls
        showFilmstrip
        showViewControls
        showFps
      />
    </div>
  );
}
