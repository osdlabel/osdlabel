//! The Leptos UI.
//!
//! It holds no annotation state of its own: every control sends a [`Command`]
//! through the bridge, and everything on screen is derived from the latest
//! [`Snapshot`] the bridge pushes back.

use leptos::{html::Div, prelude::*};
use osdlabel_shell_protocol::{
    tool_command, tool_enabled, AnnotationEntry, Command, ImageEntry, KeyOutcome, Named, Snapshot,
    ViewOp, GRIDS, TOOLS,
};
use wasm_bindgen::prelude::*;

use crate::{
    keys::{handle_key, key_from},
    labels,
    web::{Bridge, Host},
};

const HELP: &[(&str, &str)] = &[
    ("n  v  1–6", "navigate, select, the drawing tools"),
    ("[  ]", "previous / next annotation context"),
    ("↑  ↓", "previous / next annotation"),
    ("Esc", "clear the selection, then navigate"),
    ("x  Delete", "delete the selected annotation"),
    ("u  U", "undo / redo"),
    ("g  ←  →", "grid layout, active cell"),
    ("r  R  h  H  i", "rotate, flip, invert"),
    ("+  -  >  <  0", "exposure, contrast, reset view"),
    ("e  o", "export / import annotations.json"),
    ("?", "this list"),
];

const VIEW_BUTTONS: &[(ViewOp, &str, &str, &str)] = &[
    (ViewOp::RotateCcw, "⟲", "Rotate left", "R"),
    (ViewOp::RotateCw, "⟳", "Rotate right", "r"),
    (ViewOp::FlipH, "⇋", "Flip horizontally", "h"),
    (ViewOp::FlipV, "⇵", "Flip vertically", "H"),
    (ViewOp::Invert, "Invert", "Invert", "i"),
    (ViewOp::ExposureDown, "Exp −", "Less exposure", "-"),
    (ViewOp::ExposureUp, "Exp +", "More exposure", "+"),
    (ViewOp::ContrastDown, "Con −", "Less contrast", "<"),
    (ViewOp::ContrastUp, "Con +", "More contrast", ">"),
    (ViewOp::Reset, "Reset", "Reset view", "0"),
];

fn view_op_id(op: ViewOp) -> String {
    serde_json::to_value(op)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_default()
}

#[component]
pub fn App(host: StoredValue<Host, LocalStorage>) -> impl IntoView {
    let snap = RwSignal::new(Snapshot::default());
    let status = RwSignal::new(String::from("Ready. Press ? for the keys"));
    let help = RwSignal::new(false);
    let bridge = StoredValue::new_local(None::<Bridge>);
    let last_notice = StoredValue::new(0u32);

    // Commands go out one at a time; the last one's reply is the status line.
    // Snapshots come back on a microtask, never while this is on the stack.
    let send = move |commands: Vec<Command>| {
        bridge.with_value(|b| {
            let Some(b) = b else { return };
            for command in &commands {
                match serde_json::to_string(command) {
                    Ok(json) => status.set(b.dispatch(&json)),
                    Err(e) => status.set(format!("encode failed: {e}")),
                }
            }
        });
    };
    let apply = move |outcome: KeyOutcome| match outcome {
        KeyOutcome::Commands(commands) => send(commands),
        KeyOutcome::Refused(reason) => status.set(reason),
        KeyOutcome::Unhandled => {}
    };

    let viewer = NodeRef::<Div>::new();
    viewer.on_load(move |el| {
        let b = host.with_value(|h| h.mount(&el));

        let on_snapshot = Closure::<dyn FnMut(String)>::new(move |json: String| {
            match serde_json::from_str::<Snapshot>(&json) {
                Ok(s) => {
                    if let Some(n) = &s.notice {
                        if n.seq != last_notice.get_value() {
                            last_notice.set_value(n.seq);
                            status.set(n.text.clone());
                        }
                    }
                    snap.set(s);
                }
                Err(e) => web_sys::console::error_1(&format!("bad snapshot: {e}").into()),
            }
        });
        b.subscribe(&on_snapshot);
        on_snapshot.forget();

        let on_key =
            Closure::<dyn FnMut(web_sys::KeyboardEvent)>::new(move |e: web_sys::KeyboardEvent| {
                if e.ctrl_key() || e.meta_key() || e.alt_key() {
                    return;
                }
                let Some(key) = key_from(&e.key(), e.shift_key()) else {
                    return;
                };
                let result = snap.with_untracked(|s| handle_key(key, s, help.get_untracked()));
                if let Some(open) = result.help {
                    help.set(open);
                }
                if result.outcome != KeyOutcome::Unhandled || result.help.is_some() {
                    e.prevent_default();
                }
                apply(result.outcome);
            });
        b.on_key(&on_key);
        on_key.forget();

        bridge.set_value(Some(b));
    });

    view! {
        <div class="app">
            <header class="top">
                <h1>
                    "osdlabel " <span class="dim">"× Leptos"</span>
                </h1>
                <Contexts snap send />
                <button
                    class="help-button"
                    title="Keyboard shortcuts (?)"
                    aria-haspopup="dialog"
                    data-testid="help-button"
                    on:click=move |_| help.set(true)
                >
                    "?"
                </button>
            </header>

            <aside class="sidebar">
                <Tools snap apply />
                <Images snap send />
                <Annotations snap send />
            </aside>

            <main class="viewer-pane">
                <div class="viewer-head">
                    <h2 data-testid="viewer-title">{move || snap.with(labels::viewer_title)}</h2>
                    <span class="flags" data-testid="transform">
                        {move || snap.with(|s| labels::transform(&s.transform))}
                    </span>
                </div>
                <Toolbar snap send />
                <div class="viewer" node_ref=viewer data-testid="viewer"></div>
            </main>

            <footer class="status" role="status" aria-live="polite" data-testid="status">
                {move || status.get()}
            </footer>

            <Show when=move || help.get()>
                <Help on_close=move || help.set(false) />
            </Show>
        </div>
    }
}

#[component]
fn Contexts(
    snap: RwSignal<Snapshot>,
    send: impl Fn(Vec<Command>) + Copy + Send + Sync + 'static,
) -> impl IntoView {
    view! {
        <nav class="contexts" role="tablist" aria-label="Annotation contexts">
            <For
                each=move || snap.with(|s| s.contexts.clone())
                key=|c: &Named| c.id.clone()
                children=move |c: Named| {
                    let id = c.id.clone();
                    let active = {
                        let id = id.clone();
                        move || snap.with(|s| s.active_context_id.as_ref() == Some(&id))
                    };
                    view! {
                        <button
                            role="tab"
                            class="context"
                            class:active=active.clone()
                            aria-selected=move || active().to_string()
                            data-testid=format!("context-{}", c.id)
                            on:click=move |_| send(vec![Command::Context { id: id.clone() }])
                        >
                            {c.label}
                        </button>
                    }
                }
            />
        </nav>
    }
}

#[component]
fn Tools(
    snap: RwSignal<Snapshot>,
    apply: impl Fn(KeyOutcome) + Copy + Send + Sync + 'static,
) -> impl IntoView {
    let rows = TOOLS
        .iter()
        .enumerate()
        .map(|(i, (key, tool, label))| {
            let tool = *tool;
            let id = tool.unwrap_or("navigate");
            view! {
                <li>
                    <button
                        class="tool"
                        class:active=move || snap.with(|s| s.active_tool.as_deref() == tool)
                        aria-pressed=move || {
                            snap.with(|s| s.active_tool.as_deref() == tool).to_string()
                        }
                        disabled=move || !snap.with(|s| tool_enabled(s, tool))
                        aria-keyshortcuts=key.to_string()
                        data-testid=format!("tool-{id}")
                        on:click=move |_| apply(snap.with_untracked(|s| tool_command(s, i)))
                    >
                        <kbd>{key.to_string()}</kbd>
                        <span class="label">{*label}</span>
                        <span class="count">
                            {move || {
                                if tool.is_some_and(|t| t != "select") {
                                    snap.with(|s| labels::count(tool.and_then(|t| s.constraints.get(t))))
                                } else {
                                    String::new()
                                }
                            }}
                        </span>
                    </button>
                </li>
            }
        })
        .collect_view();
    view! {
        <section class="panel">
            <h2>"Tools"</h2>
            <ul class="list">{rows}</ul>
        </section>
    }
}

#[component]
fn Images(
    snap: RwSignal<Snapshot>,
    send: impl Fn(Vec<Command>) + Copy + Send + Sync + 'static,
) -> impl IntoView {
    view! {
        <section class="panel">
            <h2>"Images"</h2>
            <ul class="list">
                <For
                    each=move || snap.with(|s| s.images.iter().map(|i| i.id.clone()).collect::<Vec<_>>())
                    key=|id: &String| id.clone()
                    children=move |id: String| {
                        let entry = {
                            let id = id.clone();
                            move || snap.with(|s| s.images.iter().find(|i| i.id == id).cloned())
                        };
                        let active = {
                            let id = id.clone();
                            move || snap.with(|s| s.active_image_id.as_ref() == Some(&id))
                        };
                        let image = entry.clone();
                        view! {
                            <li>
                                <button
                                    class="image"
                                    class:active=active.clone()
                                    aria-current=move || active().then_some("true")
                                    data-testid=format!("image-{id}")
                                    on:click={
                                        let id = id.clone();
                                        move |_| send(vec![Command::Image { id: id.clone() }])
                                    }
                                >
                                    <span class="label">
                                        {move || image().map(|i: ImageEntry| i.label).unwrap_or_default()}
                                    </span>
                                    <span class="count">
                                        {move || entry().map(|i| i.count.to_string()).unwrap_or_default()}
                                    </span>
                                </button>
                            </li>
                        }
                    }
                />
            </ul>
        </section>
    }
}

#[component]
fn Annotations(
    snap: RwSignal<Snapshot>,
    send: impl Fn(Vec<Command>) + Copy + Send + Sync + 'static,
) -> impl IntoView {
    view! {
        <section class="panel grow">
            <h2>{move || format!("Annotations ({})", snap.with(|s| s.annotations.len()))}</h2>
            <Show
                when=move || snap.with(|s| !s.annotations.is_empty())
                fallback=|| view! { <p class="empty">"None yet: pick a tool and draw."</p> }
            >
                <ul class="list" data-testid="annotations">
                    <For
                        each=move || snap.with(|s| s.annotations.clone())
                        key=|a: &AnnotationEntry| a.id.clone()
                        children=move |a: AnnotationEntry| {
                            let id = a.id.clone();
                            let selected = {
                                let id = id.clone();
                                move || snap.with(|s| s.selected_annotation_id.as_ref() == Some(&id))
                            };
                            let hidden = {
                                let id = id.clone();
                                move || {
                                    snap.with(|s| {
                                        s.annotations.iter().any(|x| x.id == id && !x.visible)
                                    })
                                }
                            };
                            view! {
                                <li>
                                    <button
                                        class="annotation"
                                        class:selected=selected.clone()
                                        class:hidden=hidden.clone()
                                        aria-pressed=move || selected().to_string()
                                        title=move || {
                                            if hidden() {
                                                "Another context's annotation: not shown on the canvas"
                                            } else {
                                                ""
                                            }
                                        }
                                        data-testid=format!("annotation-{id}")
                                        on:click={
                                            let id = id.clone();
                                            move |_| {
                                                send(vec![Command::Select { id: Some(id.clone()) }])
                                            }
                                        }
                                    >
                                        <span class="label">{a.tool}</span>
                                        <span class="dim">{a.context}</span>
                                    </button>
                                </li>
                            }
                        }
                    />
                </ul>
            </Show>
        </section>
    }
}

#[component]
fn Toolbar(
    snap: RwSignal<Snapshot>,
    send: impl Fn(Vec<Command>) + Copy + Send + Sync + 'static,
) -> impl IntoView {
    let view_buttons = VIEW_BUTTONS
        .iter()
        .map(|(op, glyph, title, key)| {
            let op = *op;
            view! {
                <button
                    title=format!("{title} ({key})")
                    aria-label=*title
                    aria-keyshortcuts=*key
                    data-testid=format!("view-{}", view_op_id(op))
                    on:click=move |_| send(vec![Command::View { op }])
                >
                    {*glyph}
                </button>
            }
        })
        .collect_view();
    let grid_buttons = GRIDS
        .iter()
        .map(|g| {
            let g = *g;
            let label = format!("{}×{}", g.columns, g.rows);
            view! {
                <button
                    aria-pressed=move || snap.with(|s| s.grid == g).to_string()
                    class:active=move || snap.with(|s| s.grid == g)
                    title=format!("{label} grid (g cycles)")
                    data-testid=format!("grid-{}x{}", g.columns, g.rows)
                    on:click=move |_| {
                        send(vec![Command::Grid { columns: g.columns, rows: g.rows }])
                    }
                >
                    {label.clone()}
                </button>
            }
        })
        .collect_view();
    view! {
        <div class="toolbar" role="toolbar" aria-label="Viewer">
            <div class="group">
                <button
                    title="Undo (u)"
                    aria-keyshortcuts="u"
                    disabled=move || !snap.with(|s| s.can_undo)
                    data-testid="undo"
                    on:click=move |_| send(vec![Command::Undo])
                >
                    "Undo"
                </button>
                <button
                    title="Redo (U)"
                    aria-keyshortcuts="Shift+U"
                    disabled=move || !snap.with(|s| s.can_redo)
                    data-testid="redo"
                    on:click=move |_| send(vec![Command::Redo])
                >
                    "Redo"
                </button>
                <button
                    title="Delete the selection (x)"
                    aria-keyshortcuts="x"
                    disabled=move || snap.with(|s| s.selected_annotation_id.is_none())
                    data-testid="delete"
                    on:click=move |_| send(vec![Command::Delete])
                >
                    "Delete"
                </button>
            </div>
            <div class="group">{view_buttons}</div>
            <div class="group">{grid_buttons}</div>
            <div class="group">
                <button
                    title="Export annotations.json (e)"
                    aria-keyshortcuts="e"
                    data-testid="export"
                    on:click=move |_| send(vec![Command::Export])
                >
                    "Export"
                </button>
                <button
                    title="Import annotations.json (o)"
                    aria-keyshortcuts="o"
                    data-testid="import"
                    on:click=move |_| send(vec![Command::Import])
                >
                    "Import"
                </button>
            </div>
        </div>
    }
}

#[component]
fn Help(on_close: impl Fn() + Copy + Send + Sync + 'static) -> impl IntoView {
    let close = NodeRef::<leptos::html::Button>::new();
    // Focus the dialog's button so Tab stays in the dialog's neighbourhood and
    // Enter closes it.
    close.on_load(|b| {
        let _ = b.focus();
    });
    view! {
        <div class="backdrop" on:click=move |_| on_close()>
            <div
                class="dialog"
                role="dialog"
                aria-modal="true"
                aria-labelledby="help-title"
                data-testid="help"
                on:click=|e| e.stop_propagation()
            >
                <h2 id="help-title">"Keyboard shortcuts"</h2>
                <dl>
                    {HELP
                        .iter()
                        .map(|(keys, what)| {
                            view! {
                                <dt>
                                    <kbd>{*keys}</kbd>
                                </dt>
                                <dd>{*what}</dd>
                            }
                        })
                        .collect_view()}
                </dl>
                <button node_ref=close class="primary" on:click=move |_| on_close()>
                    "Close"
                </button>
            </div>
        </div>
    }
}
