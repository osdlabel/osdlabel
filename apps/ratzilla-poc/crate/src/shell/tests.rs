use super::*;
use ratatui::{backend::TestBackend, buffer::Buffer, Terminal};

/// The shared fixtures in `apps/ratzilla-poc/contract/`; the bridge's Vitest
/// suite checks the same files from the JS side.
const COMMANDS: &str = include_str!("../../../contract/commands.json");
const SNAPSHOT: &str = include_str!("../../../contract/snapshot.json");

fn snapshot() -> Snapshot {
    serde_json::from_str(SNAPSHOT).expect("contract/snapshot.json parses")
}

/// An app that has received the fixture snapshot.
fn app() -> App {
    let mut app = App::new();
    app.on_snapshot(snapshot());
    app
}

fn tool(t: &str) -> Command {
    Command::Tool {
        tool: Some(t.into()),
    }
}

/// Renders `app` at 100×30 and returns the buffer.
fn render(app: &mut App) -> Buffer {
    let mut terminal = Terminal::new(TestBackend::new(100, 30)).unwrap();
    terminal.draw(|f| app.render(f)).unwrap();
    terminal.backend().buffer().clone()
}

fn row_text(buf: &Buffer, y: u16) -> String {
    (0..buf.area.width).map(|x| buf[(x, y)].symbol()).collect()
}

/// The first cell whose row text contains `needle`, as (x, y).
fn find(buf: &Buffer, needle: &str) -> (u16, u16) {
    for y in 0..buf.area.height {
        let row = row_text(buf, y);
        if let Some(byte) = row.find(needle) {
            return (row[..byte].chars().count() as u16, y);
        }
    }
    panic!("{needle:?} not rendered");
}

// ── Wire format ─────────────────────────────────────────────────────────────

#[test]
fn commands_encode_as_the_contract_says() {
    let contract: serde_json::Map<String, serde_json::Value> =
        serde_json::from_str(COMMANDS).unwrap();
    let ops = [
        ("rotateCw", ViewOp::RotateCw),
        ("rotateCcw", ViewOp::RotateCcw),
        ("flipH", ViewOp::FlipH),
        ("flipV", ViewOp::FlipV),
        ("invert", ViewOp::Invert),
        ("exposureUp", ViewOp::ExposureUp),
        ("exposureDown", ViewOp::ExposureDown),
        ("contrastUp", ViewOp::ContrastUp),
        ("contrastDown", ViewOp::ContrastDown),
        ("reset", ViewOp::Reset),
    ];
    let mut cases: Vec<(String, Command)> = vec![
        ("tool".into(), tool("rectangle")),
        ("navigate".into(), Command::Tool { tool: None }),
        ("context".into(), Command::Context { id: "ctx-2".into() }),
        (
            "image".into(),
            Command::Image {
                id: "portrait".into(),
            },
        ),
        (
            "select".into(),
            Command::Select {
                id: Some("a1".into()),
            },
        ),
        ("deselect".into(), Command::Select { id: None }),
        ("delete".into(), Command::Delete),
        ("export".into(), Command::Export),
        ("import".into(), Command::Import),
        ("undo".into(), Command::Undo),
        ("redo".into(), Command::Redo),
        (
            "grid".into(),
            Command::Grid {
                columns: 2,
                rows: 1,
            },
        ),
        ("cell".into(), Command::Cell { index: 1 }),
    ];
    cases.extend(ops.map(|(name, op)| (format!("view:{name}"), Command::View { op })));

    for (name, command) in &cases {
        let expected = contract
            .get(name)
            .unwrap_or_else(|| panic!("{name} not in contract"));
        assert_eq!(&serde_json::to_value(command).unwrap(), expected, "{name}");
    }
    // Every contract entry is produced by some command, so neither side can
    // grow a command the other does not know.
    assert_eq!(cases.len(), contract.len());
}

#[test]
fn snapshot_contract_decodes() {
    let s = snapshot();
    assert_eq!(s.active_tool.as_deref(), Some("rectangle"));
    assert_eq!(s.contexts.len(), 3);
    assert_eq!(s.constraints["rectangle"].max, Some(2));
    assert_eq!(s.constraints["circle"].max, None);
    assert!(!s.annotations[1].visible);
    assert_eq!(s.transform.rotation, 90);
    assert_eq!(
        s.grid,
        Grid {
            columns: 2,
            rows: 1
        }
    );
    assert!(s.can_undo && !s.can_redo);
    assert_eq!(s.notice.unwrap().seq, 1);
}

#[test]
fn a_snapshot_without_optional_fields_decodes() {
    // What the shell sees before the bridge's first real snapshot.
    let s: Snapshot = serde_json::from_str(
        r#"{"activeTool":null,"activeContextId":null,"contexts":[],"images":[],
            "activeImageId":null,"selectedAnnotationId":null,"constraints":{},
            "annotations":[],"transform":{"rotation":0,"flippedH":false,"flippedV":false,
            "inverted":false,"exposure":0,"contrast":0},"grid":{"columns":1,"rows":1},
            "activeCell":0,"canUndo":false,"canRedo":false,"notice":null}"#,
    )
    .unwrap();
    assert!(s.notice.is_none());
}

// ── Keys ────────────────────────────────────────────────────────────────────

#[test]
fn tool_keys_respect_the_constraints() {
    let mut app = app();
    assert_eq!(app.on_key(Key::Char('3')), Some(vec![tool("line")]));
    // Rectangle is at 2/2: the key is used (no browser default) but sends nothing.
    assert_eq!(app.on_key(Key::Char('1')), Some(vec![]));
    assert_eq!(app.status(), "Rectangle is not available in this context");
    // Navigate and select are always available.
    assert_eq!(
        app.on_key(Key::Char('n')),
        Some(vec![Command::Tool { tool: None }])
    );
    assert_eq!(app.on_key(Key::Char('v')), Some(vec![tool("select")]));
}

#[test]
fn unknown_keys_are_left_to_the_browser() {
    let mut app = app();
    assert_eq!(app.on_key(Key::Char('z')), None);
    assert_eq!(app.on_key(Key::Char('7')), None);
}

#[test]
fn brackets_cycle_contexts_and_wrap() {
    let mut app = app();
    assert_eq!(
        app.on_key(Key::Char(']')),
        Some(vec![Command::Context { id: "ctx-2".into() }])
    );
    assert_eq!(
        app.on_key(Key::Char('[')),
        Some(vec![Command::Context { id: "ctx-3".into() }])
    );
}

#[test]
fn escape_clears_the_selection_before_leaving_the_tool() {
    let mut app = app();
    assert_eq!(
        app.on_key(Key::Esc),
        Some(vec![Command::Select { id: None }])
    );
    let mut s = snapshot();
    s.selected_annotation_id = None;
    app.on_snapshot(s);
    assert_eq!(
        app.on_key(Key::Esc),
        Some(vec![Command::Tool { tool: None }])
    );
}

#[test]
fn tab_cycles_panes_and_arrows_select_annotations() {
    let mut app = app();
    assert_eq!(app.focus(), Pane::Tools);
    app.on_key(Key::BackTab);
    assert_eq!(app.focus(), Pane::Annotations);
    // The cursor follows the selection (a2, index 1); ↓ wraps to a1.
    assert_eq!(
        app.on_key(Key::Down),
        Some(vec![Command::Select {
            id: Some("a1".into())
        }])
    );
    app.on_key(Key::Tab);
    assert_eq!(app.focus(), Pane::Tools);
    // Moving in the tools pane only moves the cursor; Enter activates. The
    // cursor follows the active tool (rectangle), so ↓ lands on circle, which
    // this context disables, and ↓ again on line.
    assert_eq!(app.on_key(Key::Down), Some(vec![]));
    assert_eq!(app.on_key(Key::Enter), Some(vec![]));
    assert_eq!(app.status(), "Circle is not available in this context");
    app.on_key(Key::Down);
    assert_eq!(app.on_key(Key::Enter), Some(vec![tool("line")]));
}

#[test]
fn enter_activates_the_image_under_the_cursor() {
    let mut app = app();
    app.on_key(Key::Tab);
    assert_eq!(app.focus(), Pane::Images);
    app.on_key(Key::Down);
    assert_eq!(
        app.on_key(Key::Enter),
        Some(vec![Command::Image {
            id: "portrait".into()
        }])
    );
}

#[test]
fn g_cycles_grid_layouts_and_arrows_move_between_cells() {
    let mut app = app(); // fixture grid: 2×1, cell 0
    assert_eq!(
        app.on_key(Key::Char('g')),
        Some(vec![Command::Grid {
            columns: 2,
            rows: 2
        }])
    );
    assert_eq!(
        app.on_key(Key::Right),
        Some(vec![Command::Cell { index: 1 }])
    );
    assert_eq!(
        app.on_key(Key::Left),
        Some(vec![Command::Cell { index: 1 }])
    );

    let mut s = snapshot();
    s.grid = Grid {
        columns: 2,
        rows: 2,
    };
    app.on_snapshot(s);
    assert_eq!(
        app.on_key(Key::Char('g')),
        Some(vec![Command::Grid {
            columns: 1,
            rows: 1
        }])
    );

    let mut s = snapshot();
    s.grid = Grid::default();
    app.on_snapshot(s);
    assert_eq!(
        app.on_key(Key::Right),
        Some(vec![]),
        "one cell: nowhere to go"
    );
}

#[test]
fn single_key_commands() {
    let mut app = app();
    let cases = [
        ('x', Command::Delete),
        ('u', Command::Undo),
        ('U', Command::Redo),
        ('e', Command::Export),
        ('o', Command::Import),
        (
            'r',
            Command::View {
                op: ViewOp::RotateCw,
            },
        ),
        (
            'R',
            Command::View {
                op: ViewOp::RotateCcw,
            },
        ),
        ('h', Command::View { op: ViewOp::FlipH }),
        ('H', Command::View { op: ViewOp::FlipV }),
        ('i', Command::View { op: ViewOp::Invert }),
        ('0', Command::View { op: ViewOp::Reset }),
    ];
    for (key, command) in cases {
        assert_eq!(app.on_key(Key::Char(key)), Some(vec![command]), "{key}");
    }
    assert_eq!(app.on_key(Key::Delete), Some(vec![Command::Delete]));
}

#[test]
fn help_hides_the_viewer_and_any_key_closes_it() {
    let mut app = app();
    render(&mut app);
    assert!(app.viewer_area().area() > 0);

    assert_eq!(app.on_key(Key::Char('?')), Some(vec![]));
    let buf = render(&mut app);
    find(&buf, " Keys ");
    assert_eq!(
        app.viewer_area(),
        Rect::default(),
        "the overlay would cover the help"
    );

    // A key other than ? / Esc closes the help *and* acts.
    assert_eq!(app.on_key(Key::Char('3')), Some(vec![tool("line")]));
    render(&mut app);
    assert!(app.viewer_area().area() > 0);

    app.on_key(Key::Char('?'));
    assert_eq!(
        app.on_key(Key::Esc),
        Some(vec![]),
        "Esc only closes the help"
    );
}

// ── Snapshots ───────────────────────────────────────────────────────────────

#[test]
fn a_notice_becomes_the_status_once() {
    let mut app = app();
    assert_eq!(app.status(), "Imported 2 annotation(s)");
    app.set_status("Tool: line");
    app.on_snapshot(snapshot()); // same seq
    assert_eq!(app.status(), "Tool: line");
}

// ── Rendering ───────────────────────────────────────────────────────────────

#[test]
fn renders_counts_contexts_and_the_viewer_beside_the_sidebar() {
    let mut app = app();
    let buf = render(&mut app);
    for text in [
        "Fracture",
        "Pneumothorax",
        "General",
        "2/2",
        "0/3",
        "Annotations (2)",
    ] {
        find(&buf, text);
    }
    // The viewer block's title, its transform flags, and the grid position.
    find(&buf, "Landscape · cell 1/2 (2×1)");
    find(&buf, "90° · inverted");

    let viewer = app.viewer_area();
    assert_eq!(
        viewer.x, 31,
        "right of the 30-column sidebar and its border"
    );
    assert_eq!(viewer.y, 4, "below the 3-row header and the border");
    assert_eq!(viewer.right(), 99);
    assert_eq!(viewer.bottom(), 27, "above the 2-row footer and the border");
}

#[test]
fn disabled_tools_are_dimmed_and_the_active_one_highlighted() {
    let mut app = app();
    let buf = render(&mut app);
    let (x, y) = find(&buf, "Circle");
    assert_eq!(buf[(x, y)].fg, Color::DarkGray);
    let (x, y) = find(&buf, "Rectangle");
    assert_eq!(buf[(x, y)].bg, Color::Green, "rectangle is the active tool");
    let (x, y) = find(&buf, "Line");
    assert_eq!(buf[(x, y)].fg, Color::Reset);
}

#[test]
fn clicks_hit_tools_images_annotations_and_contexts() {
    let mut app = app();
    let buf = render(&mut app);

    let (x, y) = find(&buf, "3  Line");
    assert_eq!(app.on_click(x, y), vec![tool("line")]);
    assert_eq!(app.focus(), Pane::Tools);

    let (x, y) = find(&buf, "Portrait");
    assert_eq!(
        app.on_click(x, y),
        vec![Command::Image {
            id: "portrait".into()
        }]
    );
    assert_eq!(app.focus(), Pane::Images);

    let (x, y) = find(&buf, "rectangle  ");
    assert_eq!(
        app.on_click(x, y),
        vec![Command::Select {
            id: Some("a1".into())
        }]
    );
    assert_eq!(app.focus(), Pane::Annotations);

    let (x, y) = find(&buf, "General");
    assert_eq!(
        app.on_click(x, y),
        vec![Command::Context { id: "ctx-3".into() }]
    );

    // A disabled tool, and empty space, send nothing.
    let (x, y) = find(&buf, "2  Circle");
    assert_eq!(app.on_click(x, y), vec![]);
    assert_eq!(app.on_click(60, 15), vec![]);
}

#[test]
fn rendering_survives_a_tiny_terminal() {
    let mut app = app();
    let mut terminal = Terminal::new(TestBackend::new(20, 6)).unwrap();
    terminal.draw(|f| app.render(f)).unwrap();
    app.on_key(Key::Char('?'));
    terminal.draw(|f| app.render(f)).unwrap();
}
