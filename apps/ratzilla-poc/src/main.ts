import init, { start } from 'osdlabel-tui-wasm';
import { mountBridge } from '@osdlabel/shell-bridge/bridge';
import { CONTEXTS, IMAGES } from '@osdlabel/shell-bridge/sample';
import { placeOverlay } from './overlay.js';
import type { TuiBridge } from './tui-bridge.js';

const host = document.getElementById('viewer');
if (!host) throw new Error('#viewer missing');

const bridge = mountBridge({ host, images: IMAGES, contexts: CONTEXTS });

// Test hooks for tests/e2e: the bridge itself, and the cells the shell last
// asked the viewer to cover (so a spec can check the overlay against them).
const hooks: { bridge: TuiBridge; viewerCells: readonly number[] | null } = {
  bridge: {
    ...bridge,
    setViewerRect(col, row, cols, rows) {
      hooks.viewerCells = [col, row, cols, rows];
      placeOverlay(host, document.getElementById('tui_ratzilla_grid'), col, row, cols, rows);
    },
  },
  viewerCells: null,
};
(window as unknown as { __poc: typeof hooks }).__poc = hooks;

await init();
start(hooks.bridge);
