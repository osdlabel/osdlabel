import init, { start } from 'osdlabel-leptos-wasm';
import { mountBridge, type Bridge } from '@osdlabel/shell-bridge/bridge';
import { CONTEXTS, IMAGES } from '@osdlabel/shell-bridge/sample';

// Test hook for tests/e2e: the bridge, once the app has mounted it.
const hooks: { bridge: Bridge | null } = { bridge: null };
(window as unknown as { __poc: typeof hooks }).__poc = hooks;

await init();
// The Leptos app renders the element osdlabel goes in, then asks for it to be
// mounted there.
start({
  mount(host: HTMLElement): Bridge {
    hooks.bridge = mountBridge({ host, images: IMAGES, contexts: CONTEXTS });
    return hooks.bridge;
  },
});
