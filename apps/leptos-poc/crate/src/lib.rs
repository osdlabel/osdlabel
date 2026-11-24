//! An osdlabel annotator whose UI is a Leptos app, compiled to WebAssembly.
//!
//! The app owns every control: tools, annotation contexts, images, the
//! annotation list, view transforms, undo/redo, grid layouts, import and
//! export. osdlabel only paints the images and their annotation canvases, into
//! an element the app renders like any other; the JS bridge
//! (`apps/shell-bridge/src/bridge.tsx`) mounts it there and speaks the protocol
//! in `osdlabel-shell-protocol`, the same one the Ratzilla TUI uses.
//!
//! - [`keys`] and [`labels`]: browser-free, unit-tested natively.
//! - `app` and `web` (wasm32 only): the components and the entry point.

pub mod keys;
pub mod labels;

#[cfg(target_arch = "wasm32")]
mod app;
#[cfg(target_arch = "wasm32")]
mod web;
