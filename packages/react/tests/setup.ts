/**
 * Vitest global test setup.
 *
 * `IS_REACT_ACT_ENVIRONMENT` tells React 19 that every update in this
 * environment is wrapped in `act()`. Without it `act` still flushes, but React
 * logs "The current testing environment is not configured to support act(...)"
 * on every call.
 *
 * The console filter suppresses jsdom's "Not implemented:
 * HTMLCanvasElement.prototype.getContext" warning, which fires when Fabric is
 * imported in a jsdom environment. The unit tests mock the OSD viewer and the
 * Fabric overlay and never draw to a real canvas, so it is harmless noise.
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const originalError = console.error.bind(console);

console.error = (...args: unknown[]) => {
  const msg = typeof args[0] === 'string' ? args[0] : '';
  if (msg.includes('Not implemented: HTMLCanvasElement.prototype.getContext')) {
    return; // suppress
  }
  originalError(...args);
};
