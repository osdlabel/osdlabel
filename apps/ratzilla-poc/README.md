# osdlabel × Ratzilla (proof of concept)

An osdlabel annotator whose entire shell is a [Ratatui](https://ratatui.rs) TUI compiled to
WebAssembly and rendered in the browser by [Ratzilla](https://github.com/ratatui/ratzilla): tools,
annotation contexts, images, the annotation list, view controls, undo/redo, grid layouts, import and
export. osdlabel only paints the images and their annotation canvases.

![Demo: drawing, context limits, key routing, selection, undo, grid, view controls](docs/demo.gif)

```
┌ osdlabel × Ratzilla ──────────────────────────────────────────────────┐
│ Fracture │ Pneumothorax │ General                   [ ] context  ? help│
└───────────────────────────────────────────────────────────────────────┘
┌ Tools ─────────────┐┌ Landscape · cell 1/2 (2×1) ──────────────────────┐
│› n  Navigate       ││                                                  │
│  1  Rectangle  1/2 ││   <div id="viewer">: osdlabel's                  │
│  3  Line       0/3 ││   <AnnotatorProvider><GridView/>,                │
├ Images ────────────┤│   positioned over exactly these cells            │
│ ▶ Landscape      1 ││                                                  │
├ Annotations (1) ───┤│                                                  │
│ ● rectangle Fract… ││                                                  │
└────────────────────┘└─────────────────────────────────────── 0° ───────┘
 n/v/1-6 tool  Tab pane  [ ] context  x delete  u/U undo/redo  g grid  …
```

## Running it

Needs a Rust toolchain in addition to the workspace's Node setup:

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.130 --locked   # must match crate/Cargo.toml

pnpm build                                        # the osdlabel packages (dist/)
pnpm --filter @osdlabel/ratzilla-poc poc:dev      # builds crate/ into pkg/, starts Vite on :5190
```

Press `?` in the app for every key.

| Keys                                    | Does                                            |
| --------------------------------------- | ----------------------------------------------- |
| `n` `v` `1`–`6`                         | navigate, select, the drawing tools             |
| `Tab` / `Shift+Tab`, `↑↓` / `jk`, ⏎     | move between panes, through a pane, activate    |
| `[` `]`                                 | previous / next annotation context              |
| `x` / `Delete`, `Esc`                   | delete the selection; clear it, then navigate   |
| `u` `U`                                 | undo / redo                                     |
| `g`, `←` `→`                            | cycle 1×1 → 2×1 → 2×2, move between cells       |
| `r` `R` `h` `H` `i` `+` `-` `>` `<` `0` | rotate, flip, invert, exposure, contrast, reset |
| `e` `o`                                 | export / import `annotations.json`              |

The TUI is clickable too: tool rows, images, annotations and context tabs.

## How it fits together

| Piece        | Where                                                  | Role                                                                                                                          |
| ------------ | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Shell logic  | `crate/src/shell.rs`                                   | Layout, keys and clicks → typed `Command`s, drawn from the latest `Snapshot`. No browser APIs: `cargo test` runs it natively. |
| Browser glue | `crate/src/web.rs`                                     | Ratzilla's DOM backend, the draw loop, resize/font refits, and the `Bridge` bindings.                                         |
| Bridge       | `src/bridge.tsx`                                       | Mounts `<AnnotatorProvider>` + `<GridView>`, applies commands, publishes snapshots, routes keys, places the overlay.          |
| Pure parts   | `src/commands.ts`, `src/snapshot.ts`, `src/history.ts` | The Valibot command schema, the snapshot builder, and the undo history; each has a Vitest suite.                              |
| Contract     | `contract/*.json`                                      | The wire format, as fixtures both the crate's tests and the Vitest suites check, so the two sides cannot drift.               |
| Entry        | `src/main.ts`                                          | Images and contexts (`apps/dev`'s local sample data), mounts the bridge, then calls the WASM `start(bridge)`.                 |

The shell never keeps its own copy of annotation state. It sends commands and redraws from whatever
the next snapshot says. The `Bridge` handle:

- **`dispatch(json)`**: Rust → JS. Each command is validated against a Valibot schema before it
  touches the annotator (a rejected one comes back as the status line), then mapped onto
  `useAnnotator().actions`. Branded ids are looked up, never cast.
- **`subscribe(cb)`**: JS → Rust. An effect over the annotator's stores serialises a `Snapshot`.
  Delivery is coalesced to one per microtask, which also guarantees it never re-enters Rust while a
  `dispatch` is still on the stack (the shell holds a `RefCell` borrow while it dispatches). Work that
  finishes later than its command (an import) reports back through the snapshot's `notice`.
- **`onKey(cb)`**: the bridge owns the only `keydown` listener. The active tool gets first refusal
  through `activeToolKeyHandlerRef`, so Escape cancels an in-progress polyline, Enter finishes it, and
  Backspace drops a vertex. Every other key goes to the shell. osdlabel's shortcut map is turned off
  with `shouldSkipKeyboardShortcutPredicate={() => true}`, so no key does two things. That predicate
  also runs before the tool handler, which is why the bridge calls the handler itself.
- **`setViewerRect(col, row, cols, rows)`**: after each draw that moved it, the shell reports the
  viewer block's inner area in cells. The bridge converts it to pixels from Ratzilla's own cell
  `<span>`s, so whatever font the grid renders with, the overlay lines up.

**Undo/redo** lives in the bridge, since osdlabel has no history: every committed change (a draw, an
edit's `object:modified`, a delete, an import) is recorded, and a restore goes through
`loadAnnotations`. The bridge knows the change counter a restore will produce, so restores are not
recorded as new steps.

## Tests

| Suite                       | Command                                              | In CI                       |
| --------------------------- | ---------------------------------------------------- | --------------------------- |
| Shell logic, 17 tests       | `pnpm --filter @osdlabel/ratzilla-poc poc:test:rust` | `ratzilla-poc.yml`          |
| Commands, snapshot, history | `pnpm --filter @osdlabel/ratzilla-poc test`          | `ci.yml` (via `turbo test`) |
| E2E, 11 tests               | `pnpm --filter @osdlabel/ratzilla-poc poc:test:e2e`  | `ratzilla-poc.yml`          |

The E2E suite drives the app only through the TUI and the canvas. It checks:

- overlay alignment against the reserved cells, also after a resize;
- constraint limits;
- key routing;
- list selection and delete;
- undo/redo;
- the export → import round trip, and a rejected import;
- grid layouts and the help screen;
- malformed commands;
- that nothing loads from off the dev server.

Each test was mutation-checked against the bug it guards. To run against a Chromium other than the
one Playwright downloads, set `POC_CHROMIUM` to its path.

The Rust-dependent scripts are named `poc:*` on purpose: the main CI has no Rust toolchain, so
`turbo build` / `dev` / `test:e2e` must not reach this app. `typecheck`, `lint` and `test` do run
there. They pass without the WASM build because `src/wasm.d.ts` declares the generated module by
hand. `.github/workflows/ratzilla-poc.yml` sets up Rust and runs the rest, path-filtered to this
app, the library packages and the sample data.

## Ratzilla 0.3 quirks worked around

- **`DomBackend`'s `Backend::size()` comes from the window size with a nominal 10×20 px cell**,
  not from the grid it actually builds (measured from the font). With a smaller font the terminal
  under-fills the page; with a larger one the frame is bigger than the grid and the draw indexes
  past its cells. The shell uses a `Viewport::Fixed` sized from `window_size().columns_rows` (the
  measured grid), refitted on every window resize and when web fonts finish loading. The refit
  first draws a zero-sized frame, so the backend rebuilds its grid without being handed cells it
  no longer has.
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

## Limits

- **The help screen hides the viewer.** The overlay `<div>` sits above the terminal, so a TUI popup
  over the viewer area would be covered. The shell reports an empty viewer area while help is up.
- **The annotations list shows every context.** Annotations the canvas doesn't paint (their context
  is neither active nor displayed, ViewerCell's rule) are dimmed.
- **Undo history is whole-state snapshots**, capped at 100 steps. That is fine at PoC scale, but a
  real app with thousands of annotations would want per-action diffs.
- **The polyline's in-progress keys depend on a workaround.** osdlabel cannot turn off its shortcut
  map while keeping the active tool's key handler, so the bridge reimplements that dispatch. A
  library option for exactly that would remove the workaround.
