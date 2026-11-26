//! The protocol between a Rust shell (the Ratzilla TUI, the Leptos app) and
//! the osdlabel bridge (`apps/shell-bridge/src/bridge.tsx`), and the keymap
//! both shells share.
//!
//! Both directions are JSON. The bridge validates every command against a
//! Valibot schema, and `../contract/*.json` pins the encoding on both sides:
//! this crate's tests and the bridge's Vitest suites check the same files.
//!
//! No browser APIs here: it builds and tests natively.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

// ── Wire format ─────────────────────────────────────────────────────────────
//
// Both directions are JSON. `src/bridge.tsx` validates every command against a
// Valibot schema, and `contract/commands.json` pins the encoding on both sides.

/// What the shell asks the annotator to do (Rust → JS).
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(tag = "t", rename_all = "camelCase")]
pub enum Command {
    /// `None` is navigation mode.
    Tool {
        tool: Option<String>,
    },
    Context {
        id: String,
    },
    /// Shows an image in the active cell.
    Image {
        id: String,
    },
    Select {
        id: Option<String>,
    },
    /// Deletes the selected annotation.
    Delete,
    View {
        op: ViewOp,
    },
    Export,
    /// Opens a file picker; the outcome arrives as a snapshot `notice`.
    Import,
    Undo,
    Redo,
    Grid {
        columns: u8,
        rows: u8,
    },
    Cell {
        index: usize,
    },
}

#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ViewOp {
    RotateCw,
    RotateCcw,
    FlipH,
    FlipV,
    Invert,
    ExposureUp,
    ExposureDown,
    ContrastUp,
    ContrastDown,
    Reset,
}

/// The annotator's state as the shell needs it (JS → Rust).
#[derive(Deserialize, Default, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub active_tool: Option<String>,
    pub active_context_id: Option<String>,
    pub contexts: Vec<Named>,
    pub images: Vec<ImageEntry>,
    pub active_image_id: Option<String>,
    pub selected_annotation_id: Option<String>,
    pub constraints: HashMap<String, ToolStatus>,
    /// The active image's annotations, oldest first.
    pub annotations: Vec<AnnotationEntry>,
    pub transform: Transform,
    pub grid: Grid,
    pub active_cell: usize,
    pub can_undo: bool,
    pub can_redo: bool,
    /// The outcome of something that finished later than its command (an
    /// import). Shown once per `seq`.
    pub notice: Option<Notice>,
}

#[derive(Deserialize, Clone, Debug, PartialEq)]
pub struct Named {
    pub id: String,
    pub label: String,
}

#[derive(Deserialize, Clone, Debug, PartialEq)]
pub struct ImageEntry {
    pub id: String,
    pub label: String,
    pub count: usize,
}

#[derive(Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct ToolStatus {
    pub enabled: bool,
    pub current: u32,
    pub max: Option<u32>,
}

#[derive(Deserialize, Clone, Debug, PartialEq)]
pub struct AnnotationEntry {
    pub id: String,
    pub tool: String,
    pub context: String,
    /// Painted on the canvas (its context is the active or a displayed one).
    pub visible: bool,
}

#[derive(Deserialize, Default, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Transform {
    pub rotation: i32,
    pub flipped_h: bool,
    pub flipped_v: bool,
    pub inverted: bool,
    pub exposure: f64,
    pub contrast: f64,
}

#[derive(Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct Grid {
    pub columns: u8,
    pub rows: u8,
}

impl Default for Grid {
    fn default() -> Self {
        Grid {
            columns: 1,
            rows: 1,
        }
    }
}

#[derive(Deserialize, Clone, Debug, PartialEq)]
pub struct Notice {
    pub seq: u32,
    pub text: String,
}

// ── Input ───────────────────────────────────────────────────────────────────

/// A key, as the shell sees it. The wasm glue maps browser keys onto this.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Key {
    Char(char),
    Tab,
    BackTab,
    Up,
    Down,
    Left,
    Right,
    Enter,
    Esc,
    Delete,
    Backspace,
}

// ── Tools and layouts ───────────────────────────────────────────────────────

/// (key, tool id or `None` for navigation, label)
pub const TOOLS: [(char, Option<&str>, &str); 8] = [
    ('n', None, "Navigate"),
    ('v', Some("select"), "Select"),
    ('1', Some("rectangle"), "Rectangle"),
    ('2', Some("circle"), "Circle"),
    ('3', Some("line"), "Line"),
    ('4', Some("point"), "Point"),
    ('5', Some("polyline"), "Polyline"),
    ('6', Some("freeHandPath"), "Freehand"),
];

/// The layouts `g` cycles through.
pub const GRIDS: [Grid; 3] = [
    Grid {
        columns: 1,
        rows: 1,
    },
    Grid {
        columns: 2,
        rows: 1,
    },
    Grid {
        columns: 2,
        rows: 2,
    },
];

// ── Shared shortcuts ────────────────────────────────────────────────────────

/// What a key asks for, as far as the shared shortcuts go.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeyOutcome {
    /// Send these commands (possibly none: the key is used, but there is
    /// nothing to do, such as `→` in a one-cell grid).
    Commands(Vec<Command>),
    /// The key is a shortcut, but not allowed now; show this reason.
    Refused(String),
    /// Not a shared shortcut. The shell may use it, or leave it to the browser.
    Unhandled,
}

/// Whether a tool (`None`: navigation) is usable in the current context.
pub fn tool_enabled(snap: &Snapshot, tool: Option<&str>) -> bool {
    match tool {
        None | Some("select") => true,
        Some(t) => snap.constraints.get(t).is_some_and(|s| s.enabled),
    }
}

/// Activates `TOOLS[index]`, unless the context's constraints forbid it.
pub fn tool_command(snap: &Snapshot, index: usize) -> KeyOutcome {
    let Some((_, tool, label)) = TOOLS.get(index) else {
        return KeyOutcome::Unhandled;
    };
    if !tool_enabled(snap, *tool) {
        return KeyOutcome::Refused(format!("{label} is not available in this context"));
    }
    KeyOutcome::Commands(vec![Command::Tool {
        tool: tool.map(str::to_owned),
    }])
}

/// The context `delta` steps from the active one, wrapping.
pub fn cycle_context(snap: &Snapshot, delta: isize) -> Vec<Command> {
    let n = snap.contexts.len() as isize;
    if n == 0 {
        return vec![];
    }
    let current = snap
        .contexts
        .iter()
        .position(|c| Some(&c.id) == snap.active_context_id.as_ref())
        .unwrap_or(0) as isize;
    let next = &snap.contexts[(current + delta).rem_euclid(n) as usize];
    vec![Command::Context {
        id: next.id.clone(),
    }]
}

/// The next layout in [`GRIDS`].
pub fn cycle_grid(snap: &Snapshot) -> Vec<Command> {
    let i = GRIDS.iter().position(|g| *g == snap.grid).unwrap_or(0);
    let next = GRIDS[(i + 1) % GRIDS.len()];
    vec![Command::Grid {
        columns: next.columns,
        rows: next.rows,
    }]
}

/// The cell `delta` steps from the active one, wrapping; nothing in one cell.
pub fn cycle_cell(snap: &Snapshot, delta: isize) -> Vec<Command> {
    let n = (snap.grid.columns as isize) * (snap.grid.rows as isize);
    if n <= 1 {
        return vec![];
    }
    let index = (snap.active_cell as isize + delta).rem_euclid(n) as usize;
    vec![Command::Cell { index }]
}

/// The keys every shell shares: tools, contexts, delete, undo, grid, view,
/// export/import. Keys for a shell's own UI (the TUI's panes, help) are the
/// shell's, so they come back [`KeyOutcome::Unhandled`].
pub fn shortcut(key: Key, snap: &Snapshot) -> KeyOutcome {
    use KeyOutcome::Commands;
    let one = |c| Commands(vec![c]);
    let view = |op| Commands(vec![Command::View { op }]);
    match key {
        Key::Esc => {
            if snap.selected_annotation_id.is_some() {
                one(Command::Select { id: None })
            } else {
                one(Command::Tool { tool: None })
            }
        }
        Key::Delete | Key::Backspace | Key::Char('x') => one(Command::Delete),
        Key::Left => Commands(cycle_cell(snap, -1)),
        Key::Right => Commands(cycle_cell(snap, 1)),
        Key::Char('[') => Commands(cycle_context(snap, -1)),
        Key::Char(']') => Commands(cycle_context(snap, 1)),
        Key::Char('u') => one(Command::Undo),
        Key::Char('U') => one(Command::Redo),
        Key::Char('g') => Commands(cycle_grid(snap)),
        Key::Char('e') => one(Command::Export),
        Key::Char('o') => one(Command::Import),
        Key::Char('r') => view(ViewOp::RotateCw),
        Key::Char('R') => view(ViewOp::RotateCcw),
        Key::Char('h') => view(ViewOp::FlipH),
        Key::Char('H') => view(ViewOp::FlipV),
        Key::Char('i') => view(ViewOp::Invert),
        Key::Char('+') => view(ViewOp::ExposureUp),
        Key::Char('-') => view(ViewOp::ExposureDown),
        Key::Char('>') => view(ViewOp::ContrastUp),
        Key::Char('<') => view(ViewOp::ContrastDown),
        Key::Char('0') => view(ViewOp::Reset),
        Key::Char(c) => match TOOLS.iter().position(|(k, _, _)| *k == c) {
            Some(i) => tool_command(snap, i),
            None => KeyOutcome::Unhandled,
        },
        Key::Tab | Key::BackTab | Key::Up | Key::Down | Key::Enter => KeyOutcome::Unhandled,
    }
}

/// The contract fixtures, for dependents' tests.
#[cfg(any(test, feature = "fixtures"))]
pub mod fixtures {
    /// `contract/commands.json`: every command, by name.
    pub const COMMANDS: &str = include_str!("../../contract/commands.json");
    /// `contract/snapshot.json`: a representative snapshot.
    pub const SNAPSHOT: &str = include_str!("../../contract/snapshot.json");

    /// The decoded [`SNAPSHOT`].
    pub fn snapshot() -> super::Snapshot {
        serde_json::from_str(SNAPSHOT).expect("contract/snapshot.json decodes")
    }
}

#[cfg(test)]
mod tests;
