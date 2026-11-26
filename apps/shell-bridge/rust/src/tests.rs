use super::*;
use crate::fixtures::{snapshot, COMMANDS};

fn tool(t: &str) -> Command {
    Command::Tool {
        tool: Some(t.into()),
    }
}

fn commands(c: Vec<Command>) -> KeyOutcome {
    KeyOutcome::Commands(c)
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
fn a_snapshot_without_a_notice_decodes() {
    // What a shell sees before anything asynchronous has finished.
    let mut v: serde_json::Value = serde_json::from_str(crate::fixtures::SNAPSHOT).unwrap();
    v["notice"] = serde_json::Value::Null;
    let s: Snapshot = serde_json::from_value(v).unwrap();
    assert!(s.notice.is_none());
}

// ── Shortcuts ───────────────────────────────────────────────────────────────

#[test]
fn tool_keys_respect_the_constraints() {
    let s = snapshot();
    assert_eq!(shortcut(Key::Char('3'), &s), commands(vec![tool("line")]));
    // Rectangle is at 2/2 in the fixture.
    assert_eq!(
        shortcut(Key::Char('1'), &s),
        KeyOutcome::Refused("Rectangle is not available in this context".into())
    );
    // Navigate and select are always available.
    assert_eq!(
        shortcut(Key::Char('n'), &s),
        commands(vec![Command::Tool { tool: None }])
    );
    assert_eq!(shortcut(Key::Char('v'), &s), commands(vec![tool("select")]));
}

#[test]
fn keys_that_are_not_shared_shortcuts_are_unhandled() {
    let s = snapshot();
    for key in [
        Key::Char('z'),
        Key::Char('7'),
        Key::Char('?'),
        Key::Tab,
        Key::BackTab,
        Key::Up,
        Key::Down,
        Key::Enter,
    ] {
        assert_eq!(shortcut(key, &s), KeyOutcome::Unhandled, "{key:?}");
    }
}

#[test]
fn brackets_cycle_contexts_and_wrap() {
    let s = snapshot(); // active: ctx-1 of three
    assert_eq!(
        shortcut(Key::Char(']'), &s),
        commands(vec![Command::Context { id: "ctx-2".into() }])
    );
    assert_eq!(
        shortcut(Key::Char('['), &s),
        commands(vec![Command::Context { id: "ctx-3".into() }])
    );
    let empty = Snapshot::default();
    assert_eq!(shortcut(Key::Char(']'), &empty), commands(vec![]));
}

#[test]
fn escape_clears_the_selection_before_leaving_the_tool() {
    let mut s = snapshot();
    assert_eq!(
        shortcut(Key::Esc, &s),
        commands(vec![Command::Select { id: None }])
    );
    s.selected_annotation_id = None;
    assert_eq!(
        shortcut(Key::Esc, &s),
        commands(vec![Command::Tool { tool: None }])
    );
}

#[test]
fn g_cycles_grid_layouts_and_arrows_move_between_cells() {
    let mut s = snapshot(); // 2×1, cell 0
    assert_eq!(
        shortcut(Key::Char('g'), &s),
        commands(vec![Command::Grid {
            columns: 2,
            rows: 2
        }])
    );
    assert_eq!(
        shortcut(Key::Right, &s),
        commands(vec![Command::Cell { index: 1 }])
    );
    assert_eq!(
        shortcut(Key::Left, &s),
        commands(vec![Command::Cell { index: 1 }])
    );

    s.grid = Grid {
        columns: 2,
        rows: 2,
    };
    assert_eq!(
        shortcut(Key::Char('g'), &s),
        commands(vec![Command::Grid {
            columns: 1,
            rows: 1
        }])
    );

    s.grid = Grid::default();
    assert_eq!(
        shortcut(Key::Right, &s),
        commands(vec![]),
        "one cell: nowhere to go"
    );
}

#[test]
fn single_key_commands() {
    let s = snapshot();
    let cases = [
        (Key::Char('x'), Command::Delete),
        (Key::Delete, Command::Delete),
        (Key::Backspace, Command::Delete),
        (Key::Char('u'), Command::Undo),
        (Key::Char('U'), Command::Redo),
        (Key::Char('e'), Command::Export),
        (Key::Char('o'), Command::Import),
        (
            Key::Char('r'),
            Command::View {
                op: ViewOp::RotateCw,
            },
        ),
        (
            Key::Char('R'),
            Command::View {
                op: ViewOp::RotateCcw,
            },
        ),
        (Key::Char('h'), Command::View { op: ViewOp::FlipH }),
        (Key::Char('H'), Command::View { op: ViewOp::FlipV }),
        (Key::Char('i'), Command::View { op: ViewOp::Invert }),
        (
            Key::Char('+'),
            Command::View {
                op: ViewOp::ExposureUp,
            },
        ),
        (
            Key::Char('-'),
            Command::View {
                op: ViewOp::ExposureDown,
            },
        ),
        (
            Key::Char('>'),
            Command::View {
                op: ViewOp::ContrastUp,
            },
        ),
        (
            Key::Char('<'),
            Command::View {
                op: ViewOp::ContrastDown,
            },
        ),
        (Key::Char('0'), Command::View { op: ViewOp::Reset }),
    ];
    for (key, command) in cases {
        assert_eq!(shortcut(key, &s), commands(vec![command]), "{key:?}");
    }
}
