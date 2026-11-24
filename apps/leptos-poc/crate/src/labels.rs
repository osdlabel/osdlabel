//! Display strings derived from a snapshot.

use osdlabel_shell_protocol::{Snapshot, ToolStatus, Transform};

/// A tool's usage: `1/2` with a limit, `3` without, nothing when unavailable.
pub fn count(status: Option<&ToolStatus>) -> String {
    match status {
        Some(s) => match s.max {
            Some(max) => format!("{}/{}", s.current, max),
            None if s.enabled => s.current.to_string(),
            None => String::new(),
        },
        None => String::new(),
    }
}

/// The view transform as short flags: `90° · flip-H · inverted`.
pub fn transform(t: &Transform) -> String {
    let mut flags = vec![format!("{}°", t.rotation)];
    if t.flipped_h {
        flags.push("flip-H".into());
    }
    if t.flipped_v {
        flags.push("flip-V".into());
    }
    if t.inverted {
        flags.push("inverted".into());
    }
    if t.exposure != 0.0 {
        flags.push(format!("exposure {:+.1}", t.exposure));
    }
    if t.contrast != 0.0 {
        flags.push(format!("contrast {:+.1}", t.contrast));
    }
    flags.join(" · ")
}

/// The viewer's heading: the active image, and its cell when there are several.
pub fn viewer_title(s: &Snapshot) -> String {
    let label = s
        .images
        .iter()
        .find(|i| Some(&i.id) == s.active_image_id.as_ref())
        .map(|i| i.label.as_str())
        .unwrap_or("Empty cell");
    let cells = s.grid.columns as usize * s.grid.rows as usize;
    if cells > 1 {
        format!(
            "{label} · cell {}/{} ({}×{})",
            s.active_cell + 1,
            cells,
            s.grid.columns,
            s.grid.rows
        )
    } else {
        label.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use osdlabel_shell_protocol::{fixtures::snapshot, Grid};

    #[test]
    fn counts() {
        let s = snapshot();
        assert_eq!(count(s.constraints.get("rectangle")), "2/2");
        assert_eq!(count(s.constraints.get("circle")), "", "disabled, no limit");
        assert_eq!(count(None), "");
        let open = ToolStatus {
            enabled: true,
            current: 3,
            max: None,
        };
        assert_eq!(count(Some(&open)), "3");
    }

    #[test]
    fn transform_flags() {
        let s = snapshot();
        assert_eq!(transform(&s.transform), "90° · inverted");
        let t = Transform {
            rotation: 0,
            flipped_h: true,
            flipped_v: true,
            inverted: false,
            exposure: 0.2,
            contrast: -0.4,
        };
        assert_eq!(
            transform(&t),
            "0° · flip-H · flip-V · exposure +0.2 · contrast -0.4"
        );
    }

    #[test]
    fn viewer_titles() {
        let mut s = snapshot(); // landscape, 2×1, cell 0
        assert_eq!(viewer_title(&s), "Landscape · cell 1/2 (2×1)");
        s.grid = Grid::default();
        assert_eq!(viewer_title(&s), "Landscape");
        s.active_image_id = None;
        assert_eq!(viewer_title(&s), "Empty cell");
    }
}
