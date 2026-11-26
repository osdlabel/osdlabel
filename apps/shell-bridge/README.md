# Shell bridge (shared by the Rust shell PoCs)

Two proofs of concept give osdlabel a UI written in Rust and compiled to WebAssembly:

- [`apps/ratzilla-poc`](../ratzilla-poc): a Ratatui TUI, rendered by Ratzilla.
- [`apps/leptos-poc`](../leptos-poc): a Leptos app, rendered as ordinary DOM.

They share everything except their UI. That shared part lives here, on both sides of the WASM
boundary.

| Piece    | Where                               | Role                                                                                                                                          |
| -------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Bridge   | `src/bridge.tsx`                    | `mountBridge({ host, images, contexts })` renders osdlabel into `host` and returns the `Bridge` handle a shell drives.                        |
| Commands | `src/commands.ts`                   | The Valibot schema every command from a shell is validated against before it touches the annotator.                                           |
| Snapshot | `src/snapshot.ts`                   | `buildSnapshot()`: the state a shell draws from, built by a pure function.                                                                    |
| History  | `src/history.ts`                    | Undo/redo over whole annotation states (osdlabel has none of its own).                                                                        |
| Sample   | `src/sample.ts`                     | The images (`apps/dev/sample-data`) and annotation contexts both shells open with.                                                            |
| Contract | `contract/*.json`                   | The wire format, as fixtures. The Rust crate's tests and the Vitest suites both check them, so the two sides cannot drift.                    |
| Protocol | `rust/` (`osdlabel-shell-protocol`) | `Command`, `Snapshot`, `Key`, `TOOLS` / `GRIDS`, and `shortcut()`: the keys both shells share. Browser-free, so it builds and tests natively. |

## The `Bridge` handle

- **`dispatch(json)`**: a shell → JS command, validated, then mapped onto
  `useAnnotator().actions`. Returns a status line; a rejected command says why.
- **`subscribe(cb)` / `getSnapshot()`**: JS → shell. An effect over the annotator's stores
  serialises a snapshot. Delivery is coalesced to one per microtask, so it never re-enters a shell
  while that shell's `dispatch` is still on the stack. Work that finishes later than its command (an
  import) reports back through the snapshot's `notice`.
- **`onKey(cb)`**: the bridge owns the only `keydown` listener. The active tool gets each key first
  (Escape cancels a polyline, Enter finishes it), and the rest go to the shell. osdlabel's own
  shortcut map is off, so no key does two things. [#248](https://github.com/osdlabel/osdlabel/issues/248)
  proposes a library option that would let osdlabel do this routing itself.
- **`destroy()`**: unmounts the annotator and removes the listener.

Where `host` sits is the shell's business. Ratzilla lays it over the terminal cells it reserves (and
adds a `setViewerRect` call for that); Leptos renders it as part of its own layout.

## Tests

| Suite                                | Command                                              | In CI                       |
| ------------------------------------ | ---------------------------------------------------- | --------------------------- |
| Commands, snapshot, history (Vitest) | `pnpm --filter @osdlabel/shell-bridge test`          | `ci.yml` (via `turbo test`) |
| Protocol and keymap (`cargo test`)   | `pnpm --filter @osdlabel/shell-bridge poc:test:rust` | `rust-shells.yml`           |

The bridge's wiring itself (`bridge.tsx`) is covered by both shells' E2E suites.
