import { render } from 'solid-js/web';
import { AnnotatorProvider, GridControls } from '@osdlabel/solid';

/**
 * `<GridControls>` in a host toolbar slot, for the popover edge-flip (#147).
 *
 * The popover opens rightward from its button by default, so a button placed
 * near a right edge clipped it. This page puts the control in a fixed-width
 * slot and lets a spec choose where it sits and what clips it:
 *
 * - `?align=start|end` — the button at the slot's left or right edge
 *   (default `start`);
 * - `?width=<px>` — the slot's width (default 360);
 * - `?clip=slot|viewport` — whether the slot clips its overflow, as a toolbar
 *   container might, or only the viewport does, with the slot pushed against
 *   the window's right edge (default `slot`).
 */

const params = new URLSearchParams(window.location.search);
const align = params.get('align') === 'end' ? 'end' : 'start';
const clip = params.get('clip') === 'viewport' ? 'viewport' : 'slot';
const requested = Number(params.get('width'));
const width = Number.isFinite(requested) && requested > 0 ? requested : 360;

const root = document.getElementById('app');
if (root) {
  render(
    () => (
      <AnnotatorProvider>
        <div
          style={{
            display: 'flex',
            'justify-content': clip === 'viewport' ? 'flex-end' : 'flex-start',
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
              'align-items': 'flex-start',
              'justify-content': align === 'end' ? 'flex-end' : 'flex-start',
              overflow: clip === 'slot' ? 'hidden' : 'visible',
              background: '#1a1a1a',
              outline: '1px dashed #555',
            }}
          >
            <GridControls maxColumns={6} maxRows={4} />
          </div>
        </div>
      </AnnotatorProvider>
    ),
    root,
  );
}
