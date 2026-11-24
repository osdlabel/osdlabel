# osdlabel × Leptos (proof of concept)

An osdlabel annotator whose UI is a [Leptos](https://leptos.dev) app, written in Rust and compiled
to WebAssembly. The app owns every control: annotation contexts, tools with their constraint
counts, images, the annotation list, view controls, undo/redo, grid layouts, import/export, and a
help dialog. osdlabel only paints the images and their annotation canvases.

![Demo: drawing, context limits, key routing, selection, undo, grid, help](docs/demo.gif)

It is the second Rust shell over the same bridge as the [Ratzilla PoC](../ratzilla-poc). The
protocol, the shared keymap and the JS bridge live in [`apps/shell-bridge`](../shell-bridge). That
leaves this app with only its UI: about 500 lines of components, a little key and label logic, and a 17-line `main.ts`.

## Running it

Needs a Rust toolchain in addition to the workspace's Node setup:

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.130 --locked   # must match crate/Cargo.toml

pnpm build                                     # the osdlabel packages (dist/)
pnpm --filter @osdlabel/leptos-poc poc:dev     # builds crate/ into pkg/, starts Vite on :5191
```

Every control is a button. The keys are the Ratzilla PoC's shared shortcuts plus `↑` `↓` to step
through the annotations and `?` for the list. Tab, Enter and Space are the browser's.

## How it differs from the Ratzilla PoC

- **The viewer is part of the layout.** Leptos renders the viewer's `<div>` like any other element,
  and once it is in the document (`NodeRef::on_load`) asks the bridge to mount osdlabel into it. No
  overlay to position, no refits, and the help dialog can sit above the viewer.
- **Focus is the browser's.** Lists are keyed `<For>`s and the tool buttons are static with
  reactive attributes, so a snapshot never re-creates the button that has focus. Enter on a focused
  button presses it; it does not reach the shortcuts (the bridge leaves Enter and Space to focused
  buttons).
- **Accessibility comes with the DOM.** Context tabs use `aria-selected`, toggles `aria-pressed`,
  the active image `aria-current`. The status line is `aria-live`, and the help dialog is
  `role="dialog"` and takes focus.

| Piece  | Where                             | Role                                                                                                  |
| ------ | --------------------------------- | ----------------------------------------------------------------------------------------------------- |
| UI     | `crate/src/app.rs`                | The components. Every control sends a `Command`; everything shown derives from the latest `Snapshot`. |
| Keys   | `crate/src/keys.rs`               | Browser keys → `Key`, and `?` / `↑` `↓` on top of the shared keymap. Browser-free, unit-tested.       |
| Labels | `crate/src/labels.rs`             | Counts, transform flags, the viewer's title. Browser-free, unit-tested.                               |
| Entry  | `crate/src/web.rs`, `src/main.ts` | Mounts the app into `#app`; `main.ts` hands it a `mount(host)` that creates the bridge there.         |

## Tests

| Suite              | Command                                            | In CI             |
| ------------------ | -------------------------------------------------- | ----------------- |
| Keys and labels, 9 | `pnpm --filter @osdlabel/leptos-poc poc:test:rust` | `rust-shells.yml` |
| E2E, 12 tests      | `pnpm --filter @osdlabel/leptos-poc poc:test:e2e`  | `rust-shells.yml` |

The E2E suite drives the app through its buttons, keys and the canvas. It checks:

- the viewer filling its pane, also after a resize;
- constraint limits disabling tool buttons;
- key routing (the tool first, then the app);
- list selection and delete;
- undo/redo by button and by key;
- the export → import round trip, and a rejected import;
- grid layouts and cells;
- the help dialog: above the viewer, focused, closed by Escape or a shortcut;
- focus surviving re-renders;
- malformed commands;
- that nothing loads from off the dev server.

Mutation checks: removing the dialog's focus call fails the help test, and removing the tool
buttons' `disabled` fails the constraint test. The suite also caught a real bug in the shared
bridge: Delete left the deleted annotation selected.

As in the Ratzilla PoC, the Rust-dependent scripts are `poc:*`, so the main CI's turbo tasks never
need `cargo`; `typecheck` and `lint` run there against a hand-written `src/wasm.d.ts`.

## Size

Release builds use `opt-level = "s"`, LTO, one codegen unit and stripped symbols: the WASM is
399 KB, 128 KB gzipped. (Without the last two it was 1.9 MB.)
