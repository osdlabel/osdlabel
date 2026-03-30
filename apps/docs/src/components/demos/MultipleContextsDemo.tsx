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
    label: 'Region North',
  },
  {
    id: createImageId('sample-2'),
    tileSource: 'https://openseadragon.github.io/example-images/duomo/duomo.dzi',
    label: 'Region South',
  },
];

const contexts: AnnotationContext[] = [
  {
    id: createAnnotationContextId('buildings'),
    label: 'Buildings',
    // Only annotate buildings in specific regions
    imageIds: [createImageId('sample-1'), createImageId('sample-2')],
    tools: [
      // Up to 10 building outlines per image
      { type: 'rectangle', maxCount: 10, countScope: 'per-image' },
      // Up to 5 freehand boundaries total for irregular shapes
      { type: 'path', maxCount: 5 },
    ],
  },
  {
    id: createAnnotationContextId('roads'),
    label: 'Roads',
    tools: [
      // Trace road segments with lines
      { type: 'line', maxCount: 20, countScope: 'per-image' },
      // Mark intersections
      { type: 'point', maxCount: 15 },
    ],
  },
  {
    id: createAnnotationContextId('landmarks'),
    label: 'Landmarks',
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

export default function MultipleContextsDemo() {
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
        showContextSwitcher={true}
        filmstripPosition="left"
        maxGridSize={{ columns: 2, rows: 1 }}
      />
    </div>
  );
}
