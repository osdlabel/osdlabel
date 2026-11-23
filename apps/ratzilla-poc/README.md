# osdlabel × Ratzilla (proof of concept)

An osdlabel annotator whose entire shell (tools, contexts, images, annotation list, view controls,
delete, export) is a [Ratatui](https://ratatui.rs) TUI compiled to WebAssembly and rendered in the
browser by [Ratzilla](https://github.com/ratatui/ratzilla). osdlabel only paints the image and its
annotation canvas.

![Demo: drawing, context limits, key routing, selection, view controls, export](docs/demo.gif)

```
┌ osdlabel × Ratzilla ───────────────────────────────────────────┐
│ Fracture │ Pneumothorax │ General                    [ ] context│
└────────────────────────────────────────────────────────────────┘
┌ Tools ─────────────┐┌ Landscape ────────────────────────────────┐
│› n  Navigate       ││                                           │
│  1  Rectangle  1/2 ││     <div id="viewer">: osdlabel's         │
│  3  Line       0/3 ││     <AnnotatorProvider><GridView/>,       │
├ Images ────────────┤│     positioned over these cells           │
│ ▶ Landscape      1 ││                                           │
├ Annotations (1) ───┤│                                           │
│ ● rectangle Fract… ││                                           │
└────────────────────┘└──────────────────────────────── 0° ───────┘
 n/v/1-6 tool  Tab pane  ↑↓ Enter pick  [ ] context  x delete  …
```

## Running it

Needs a Rust toolchain in addition to the workspace's Node setup:

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.130 --locked   # must match crate/Cargo.toml

pnpm build                                           # the osdlabel packages (dist/)
pnpm --filter @osdlabel/ratzilla-poc poc:dev         # builds crate/ into pkg/, starts Vite on :5190
```

The scripts are named `poc:*` on purpose: CI has no Rust toolchain, so the workspace-wide `turbo
build` / `dev` must not reach this app. `typecheck` and `lint` do run in CI. They pass without the
WASM build because `src/wasm.d.ts` declares the generated module by hand.

## How it fits together

| Piece  | Where              | Role                                                                                                                    |
| ------ | ------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Shell  | `crate/src/lib.rs` | Ratatui layout, keys, mouse, and the rAF draw loop. Holds no annotation state of its own: it redraws from snapshots.    |
| Bridge | `src/bridge.tsx`   | Mounts `<AnnotatorProvider>` + a 1×1 `<GridView>`, and exposes the `Bridge` handle the shell talks to.                  |
| Entry  | `src/main.ts`      | Images and contexts (the same local sample data as `apps/dev`), mounts the bridge, then calls the WASM `start(bridge)`. |

The `Bridge` handle:

- **`dispatch(json)`**: Rust → JS commands (`tool`, `context`, `image`, `select`, `delete`, `view`,
  `export`), each mapped onto one or two `useAnnotator().actions` calls. Returns a status line.
- **`subscribe(cb)`**: JS → Rust. A `createEffect` over `uiState`, `contextState`, the annotations
  and `constraintStatus` serialises a `Snapshot`. Delivery is coalesced to one per microtask, which
  also guarantees it never re-enters Rust while a `dispatch` is still on the stack (the shell holds
  a `RefCell` borrow while it dispatches).
- **`onKey(cb)`**: the bridge owns the only `keydown` listener. The active tool gets first refusal
  through `activeToolKeyHandlerRef`, so Escape cancels an in-progress polyline, Enter finishes it, and
  Backspace drops a vertex. Every other key goes to the shell. osdlabel's own shortcut map is turned
  off with `shouldSkipKeyboardShortcutPredicate={() => true}`, so no key does two things. (That
  predicate runs before the tool handler too, which is why the bridge calls the handler itself
  rather than keeping the built-in listener.)
- **`setViewerRect(col, row, cols, rows)`**: the shell reports the viewer block's inner area in
  cells after each draw that changed it. The bridge converts it to pixels from Ratzilla's own cell
  `<span>`s, so whatever font the grid renders with, the overlay lines up.

## Ratzilla 0.3 quirks worked around

- **`DomBackend`'s `Backend::size()` comes from the window size with a nominal 10×20 px cell**,
  not from the grid it actually builds (measured from the font). With a smaller font the terminal
  under-fills the page; with a larger one the frame is bigger than the grid and the draw indexes
  past its cells. The shell uses a `Viewport::Fixed` sized from `window_size().columns_rows` (the
  measured grid), refitted on every window resize. The refit first draws a zero-sized frame, so the
  backend rebuilds its grid without being handed cells it no longer has.
- **`draw_web` takes the terminal by value**, which leaves no way to resize it, so the shell runs
  its own `requestAnimationFrame` loop.
- **`on_key_event` listens on the grid element**, which loses focus the moment you click the
  viewer. Keys come through the bridge's window-level listener instead.
- **Mouse coordinates are computed from the grid size at registration**, so `on_mouse_event` is
  re-registered after every refit.
- **`Modifier::REVERSED` renders a list highlight as a blank bar** on the DOM backend. Highlights
  use bold + underline instead.
- **ratatui needs a `critical-section` implementation on wasm32.** The crate depends on
  `critical-section` with `std` to satisfy the linker.

## Limits of the PoC

- **One viewer cell.** The grid is fixed at 1×1. Multi-cell grids work the same way, with one more
  command (`setGridDimensions`) and one rect per cell.
- **No undo/redo.** osdlabel's actions have no history.
- **No import.** Export downloads `annotations.json` (`serialize()`); `deserialize()` +
  `loadAnnotations` would be the import path.
- **The annotations list shows every context.** Annotations the canvas doesn't paint (their context
  is neither active nor displayed, ViewerCell's rule) are dimmed.
- **No automated tests.** The flows above were exercised by hand-written Playwright scripts. They
  aren't wired into the E2E suite because CI cannot build the crate.
