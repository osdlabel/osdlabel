//! An osdlabel annotator shell written as a Ratatui TUI, run in the browser by
//! Ratzilla.
//!
//! The TUI owns every control: tools, annotation contexts, images, view
//! transforms, the annotation list, undo, grid layout, import and export.
//! osdlabel only paints the image and its annotation canvas, into a `<div>`
//! the JS bridge lays over the terminal cells this shell leaves for it.
//!
//! - [`shell`]: logic and layout, browser-free and unit-tested natively.
//! - `web` (wasm32 only): Ratzilla's backend, the draw loop, the bridge.

pub mod shell;

#[cfg(target_arch = "wasm32")]
mod web;
