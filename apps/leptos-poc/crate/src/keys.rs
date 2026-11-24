//! What the app does with a key.
//!
//! The shortcuts every shell shares come from
//! [`osdlabel_shell_protocol::shortcut`]. On top of them the app adds `?` for
//! the help dialog and `↑` / `↓` to step through the annotation list. Tab,
//! Enter and Space are the browser's: the app is made of real buttons.

use osdlabel_shell_protocol::{shortcut, Command, Key, KeyOutcome, Snapshot};

/// The [`Key`] for a `KeyboardEvent.key`, or `None` for keys the app never
/// uses (modifiers, function keys…).
pub fn key_from(key: &str, shift: bool) -> Option<Key> {
    Some(match key {
        "Tab" if shift => Key::BackTab,
        "Tab" => Key::Tab,
        "ArrowUp" => Key::Up,
        "ArrowDown" => Key::Down,
        "ArrowLeft" => Key::Left,
        "ArrowRight" => Key::Right,
        "Enter" => Key::Enter,
        "Escape" => Key::Esc,
        "Delete" => Key::Delete,
        "Backspace" => Key::Backspace,
        _ => {
            let mut chars = key.chars();
            match (chars.next(), chars.next()) {
                (Some(c), None) => Key::Char(c),
                _ => return None,
            }
        }
    })
}

/// The outcome of a key: the help dialog's new state, if it changes, and what
/// to send.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyResult {
    pub help: Option<bool>,
    pub outcome: KeyOutcome,
}

impl KeyResult {
    fn of(outcome: KeyOutcome) -> Self {
        KeyResult {
            help: None,
            outcome,
        }
    }
}

/// Handles a key, given the latest snapshot and whether help is open.
pub fn handle_key(key: Key, snap: &Snapshot, help_open: bool) -> KeyResult {
    let used = KeyOutcome::Commands(vec![]);
    match key {
        Key::Char('?') => KeyResult {
            help: Some(!help_open),
            outcome: used,
        },
        Key::Esc if help_open => KeyResult {
            help: Some(false),
            outcome: used,
        },
        Key::Up => KeyResult::of(KeyOutcome::Commands(step_selection(snap, -1))),
        Key::Down => KeyResult::of(KeyOutcome::Commands(step_selection(snap, 1))),
        _ => {
            let outcome = shortcut(key, snap);
            // A shortcut closes the help dialog as it acts, so the result is
            // visible; keys the app does not use leave it open.
            let help = (help_open && outcome != KeyOutcome::Unhandled).then_some(false);
            KeyResult { help, outcome }
        }
    }
}

/// Selects the annotation `delta` rows from the selected one, wrapping. With
/// nothing selected, ↓ starts at the first and ↑ at the last.
pub fn step_selection(snap: &Snapshot, delta: isize) -> Vec<Command> {
    let n = snap.annotations.len() as isize;
    if n == 0 {
        return vec![];
    }
    let current = snap
        .selected_annotation_id
        .as_ref()
        .and_then(|id| snap.annotations.iter().position(|a| &a.id == id));
    let next = match current {
        Some(i) => (i as isize + delta).rem_euclid(n),
        None if delta > 0 => 0,
        None => n - 1,
    };
    vec![Command::Select {
        id: Some(snap.annotations[next as usize].id.clone()),
    }]
}

#[cfg(test)]
mod tests {
    use super::*;
    use osdlabel_shell_protocol::{fixtures::snapshot, ViewOp};

    fn select(id: &str) -> KeyOutcome {
        KeyOutcome::Commands(vec![Command::Select {
            id: Some(id.into()),
        }])
    }

    #[test]
    fn browser_keys_map_onto_shell_keys() {
        assert_eq!(key_from("ArrowUp", false), Some(Key::Up));
        assert_eq!(key_from("Tab", true), Some(Key::BackTab));
        assert_eq!(key_from("Escape", false), Some(Key::Esc));
        assert_eq!(key_from("r", false), Some(Key::Char('r')));
        assert_eq!(key_from("R", true), Some(Key::Char('R')));
        assert_eq!(key_from("é", false), Some(Key::Char('é')));
        assert_eq!(key_from("Shift", true), None);
        assert_eq!(key_from("F5", false), None);
    }

    #[test]
    fn question_mark_toggles_help() {
        let s = snapshot();
        assert_eq!(handle_key(Key::Char('?'), &s, false).help, Some(true));
        assert_eq!(handle_key(Key::Char('?'), &s, true).help, Some(false));
    }

    #[test]
    fn escape_closes_help_before_anything_else() {
        let s = snapshot(); // has a selection
        assert_eq!(
            handle_key(Key::Esc, &s, true),
            KeyResult {
                help: Some(false),
                outcome: KeyOutcome::Commands(vec![])
            }
        );
        // With help closed, Escape is the shared shortcut again.
        assert_eq!(
            handle_key(Key::Esc, &s, false).outcome,
            KeyOutcome::Commands(vec![Command::Select { id: None }])
        );
    }

    #[test]
    fn a_shortcut_closes_help_as_it_acts_and_other_keys_do_not() {
        let s = snapshot();
        let r = handle_key(Key::Char('r'), &s, true);
        assert_eq!(r.help, Some(false));
        assert_eq!(
            r.outcome,
            KeyOutcome::Commands(vec![Command::View {
                op: ViewOp::RotateCw
            }])
        );
        let tab = handle_key(Key::Tab, &s, true);
        assert_eq!(tab, KeyResult::of(KeyOutcome::Unhandled));
        // A refused shortcut still closes it, so the reason is readable.
        assert_eq!(handle_key(Key::Char('1'), &s, true).help, Some(false));
    }

    #[test]
    fn arrows_step_through_the_annotations_and_wrap() {
        let mut s = snapshot(); // a1, a2; a2 selected
        assert_eq!(handle_key(Key::Up, &s, false).outcome, select("a1"));
        assert_eq!(handle_key(Key::Down, &s, false).outcome, select("a1"));
        s.selected_annotation_id = None;
        assert_eq!(handle_key(Key::Down, &s, false).outcome, select("a1"));
        assert_eq!(handle_key(Key::Up, &s, false).outcome, select("a2"));
        s.annotations.clear();
        assert_eq!(
            handle_key(Key::Down, &s, false).outcome,
            KeyOutcome::Commands(vec![])
        );
    }

    #[test]
    fn tab_and_enter_stay_with_the_browser() {
        let s = snapshot();
        for key in [Key::Tab, Key::BackTab, Key::Enter] {
            assert_eq!(handle_key(key, &s, false).outcome, KeyOutcome::Unhandled);
        }
    }
}
