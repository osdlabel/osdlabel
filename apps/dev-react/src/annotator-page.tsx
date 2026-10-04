import { createRoot } from 'react-dom/client';
import { Annotator, createImageId, createAnnotationContextId } from '@osdlabel/react';
import type { AnnotationContext, ImageSource } from '@osdlabel/react';

/**
 * The stock `<Annotator>`, mounted as a host would mount it — the React twin of
 * `apps/dev/src/annotator-page.tsx`, which explains why the page exists (#147).
 * `annotator-layout.spec.ts` and `grid-popover.spec.ts` run against both.
 *
 * The container width comes from `?width=<px>` (default 560) so a spec can
 * pin a narrow host. Local images only; see `offline.spec.ts`.
 */

const IMAGES: ImageSource[] = [
  { id: createImageId('landscape'), tileSource: './sample-data/landscape.png', label: 'Landscape' },
  { id: createImageId('portrait'), tileSource: './sample-data/portrait.png', label: 'Portrait' },
];

const CONTEXTS: AnnotationContext[] = [
  {
    id: createAnnotationContextId('general'),
    label: 'General',
    tools: [{ type: 'rectangle' }, { type: 'circle' }, { type: 'line' }, { type: 'point' }],
  },
];

const requested = Number(new URLSearchParams(window.location.search).get('width'));
const width = Number.isFinite(requested) && requested > 0 ? requested : 560;

const root = document.getElementById('app');
if (root) {
  createRoot(root).render(
    <div data-testid="annotator-host" style={{ width: `${width}px`, height: '100%' }}>
      <Annotator
        images={IMAGES}
        contexts={CONTEXTS}
        showGridControls
        showContextSwitcher
        testMode
      />
    </div>,
  );
}
