import { createRoot } from 'react-dom/client';
import {
  AnnotatorProvider,
  GridControls,
  choosePopoverAlignment,
  getHorizontalClipBounds,
} from '@osdlabel/react';

/**
 * `<GridControls>` in a host toolbar slot, for the popover edge-flip (#147) —
 * the React twin of `apps/dev/src/grid-controls-page.tsx`, which documents the
 * query parameters. `grid-popover.spec.ts` runs against both.
 *
 * - `?align=start|end` — the button at the slot's left or right edge;
 * - `?width=<px>` — the slot's width (default 360);
 * - `?clip=slot|viewport` — whether the slot or only the viewport clips.
 */

// The placement helpers, for specs that check them directly against DOM
// fixtures that would be awkward to mount the component into.
(
  window as unknown as {
    __popoverPlacement: {
      choosePopoverAlignment: typeof choosePopoverAlignment;
      getHorizontalClipBounds: typeof getHorizontalClipBounds;
    };
  }
).__popoverPlacement = { choosePopoverAlignment, getHorizontalClipBounds };

const params = new URLSearchParams(window.location.search);
const align = params.get('align') === 'end' ? 'end' : 'start';
const clip = params.get('clip') === 'viewport' ? 'viewport' : 'slot';
const requested = Number(params.get('width'));
const width = Number.isFinite(requested) && requested > 0 ? requested : 360;

const root = document.getElementById('app');
if (root) {
  createRoot(root).render(
    <AnnotatorProvider>
      <div
        style={{
          display: 'flex',
          justifyContent: clip === 'viewport' ? 'flex-end' : 'flex-start',
          padding: clip === 'viewport' ? '0' : '24px',
          background: '#111',
          height: '100%',
        }}
      >
        <div
          data-testid="grid-host-slot"
          style={{
            width: `${width}px`,
            height: '260px',
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: align === 'end' ? 'flex-end' : 'flex-start',
            overflow: clip === 'slot' ? 'hidden' : 'visible',
            background: '#1a1a1a',
            outline: '1px dashed #555',
          }}
        >
          <GridControls maxColumns={6} maxRows={4} />
        </div>
      </div>
    </AnnotatorProvider>,
  );
}
