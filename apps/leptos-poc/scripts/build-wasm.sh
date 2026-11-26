#!/bin/sh
# Builds crate/ to WebAssembly and generates the JS glue into pkg/.
# Needs: rustup target add wasm32-unknown-unknown
#        cargo install wasm-bindgen-cli --version 0.2.130 --locked
set -eu
cd "$(dirname "$0")/.."
cargo build --manifest-path crate/Cargo.toml --release --target wasm32-unknown-unknown
wasm-bindgen --target web --out-dir pkg --out-name osdlabel_leptos \
  crate/target/wasm32-unknown-unknown/release/osdlabel_leptos.wasm
