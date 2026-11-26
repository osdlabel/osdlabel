/**
 * The wasm-bindgen output of `crate/` (built into `pkg/` by `pnpm poc:wasm`).
 * Declared by hand so `tsc` and lint pass in CI, which has no Rust toolchain;
 * Vite aliases the specifier to `pkg/osdlabel_tui.js`.
 */
declare module 'osdlabel-tui-wasm' {
  export default function init(): Promise<unknown>;
  export function start(bridge: import('./tui-bridge.js').TuiBridge): void;
}
