/**
 * The wasm-bindgen output of `crate/` (built into `pkg/` by `pnpm poc:wasm`).
 * Declared by hand so `tsc` and lint pass in CI, which has no Rust toolchain;
 * Vite aliases the specifier to `pkg/osdlabel_leptos.js`.
 */
declare module 'osdlabel-leptos-wasm' {
  export default function init(): Promise<unknown>;
  export function start(host: {
    mount(host: HTMLElement): import('@osdlabel/shell-bridge/bridge').Bridge;
  }): void;
}
