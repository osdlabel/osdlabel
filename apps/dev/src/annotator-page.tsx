import { render } from 'solid-js/web';
import { Annotator, createImageId, createAnnotationContextId } from '@osdlabel/solid';
import type { AnnotationContext, ImageSource } from '@osdlabel/solid';

/**
 * The stock `<Annotator>`, mounted as a host would mount it.
 *
 * `App.tsx` composes its own layout from the individual components, so it never
 * renders `<Annotator>` itself — and bugs that live only in the stock layout
 * went unexercised (#147: its toolbar bar did not wrap, and below ~700px the
 * right-hand controls were clipped and unreachable).
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
  render(
    () => (
      <div data-testid="annotator-host" style={{ width: `${width}px`, height: '100%' }}>
        <Annotator
          images={IMAGES}
          contexts={CONTEXTS}
          showGridControls
          showContextSwitcher
          testMode
        />
      </div>
    ),
    root,
  );
}
