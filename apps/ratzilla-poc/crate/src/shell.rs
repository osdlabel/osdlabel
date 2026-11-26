//! The shell's logic and layout, with no browser APIs.
//!
//! [`App`] turns keys and clicks into [`Command`]s for the annotator, and draws
//! itself from the latest [`Snapshot`]. The protocol and the shortcuts every
//! shell shares are `osdlabel-shell-protocol`'s; this module adds the TUI's
//! panes, cursors, clicks and help screen. It never mutates annotation state on its
//! own guess: whatever a command does, the next snapshot says so. Everything
//! here compiles natively, so `cargo test` covers it without a browser; the
//! wasm glue that feeds it lives in `web.rs`.

use osdlabel_shell_protocol::{shortcut, tool_command, KeyOutcome, TOOLS};
pub use osdlabel_shell_protocol::{Command, Key, Snapshot};
use ratatui::{
    layout::{Constraint, Flex, Layout, Position, Rect},
    style::{Color, Modifier, Style, Stylize},
    text::{Line, Span},
    widgets::{Block, BorderType, Clear, List, ListItem, ListState, Paragraph, Tabs},
    Frame,
};

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum Pane {
    #[default]
    Tools,
    Images,
    Annotations,
}

impl Pane {
    fn index(self) -> usize {
        self as usize
    }
    fn next(self) -> Self {
        match self {
            Pane::Tools => Pane::Images,
            Pane::Images => Pane::Annotations,
            Pane::Annotations => Pane::Tools,
        }
    }
    fn prev(self) -> Self {
        self.next().next()
    }
}

/// Something a click on the TUI can hit.
#[derive(Clone, Copy, Debug)]
enum Hit {
    Tool(usize),
    Image(usize),
    Annotation(usize),
    Context(usize),
}

const HELP: &[(&str, &str)] = &[
    ("n v 1-6", "navigate, select, drawing tools"),
    ("Tab / Shift+Tab", "next / previous pane"),
    ("↑ ↓ (j k)  Enter", "move in the pane, activate"),
    ("[ ]", "previous / next annotation context"),
    ("x  Delete", "delete the selected annotation"),
    ("Esc", "clear selection, then navigate"),
    ("u  U", "undo / redo"),
    ("g  ← →", "grid layout, active cell"),
    ("r R  h H  i", "rotate, flip, invert"),
    ("+ -  > <  0", "exposure, contrast, reset view"),
    ("e  o", "export / import annotations.json"),
    ("?", "this help"),
];

#[derive(Default)]
pub struct App {
    snap: Snapshot,
    focus: Pane,
    cursor: [usize; 3],
    status: String,
    last_notice: u32,
    help: bool,
    hits: Vec<(Rect, Hit)>,
    viewer: Rect,
}

impl App {
    pub fn new() -> Self {
        App {
            status: "Ready. Press ? for help".into(),
            ..App::default()
        }
    }

    pub fn status(&self) -> &str {
        &self.status
    }

    pub fn set_status(&mut self, status: impl Into<String>) {
        self.status = status.into();
    }

    pub fn focus(&self) -> Pane {
        self.focus
    }

    /// The terminal cells the viewer should cover, as of the last render.
    /// Empty while the help screen is up, so the overlay does not hide it.
    pub fn viewer_area(&self) -> Rect {
        self.viewer
    }

    fn tool_enabled(&self, tool: Option<&str>) -> bool {
        osdlabel_shell_protocol::tool_enabled(&self.snap, tool)
    }

    /// Commands from the shared keymap; a refusal becomes the status line.
    fn outcome(&mut self, outcome: KeyOutcome) -> Option<Vec<Command>> {
        match outcome {
            KeyOutcome::Commands(commands) => Some(commands),
            KeyOutcome::Refused(reason) => {
                self.status = reason;
                Some(vec![])
            }
            KeyOutcome::Unhandled => None,
        }
    }

    fn tool(&mut self, index: usize) -> Vec<Command> {
        let outcome = tool_command(&self.snap, index);
        if matches!(outcome, KeyOutcome::Commands(_)) {
            self.cursor[Pane::Tools.index()] = index;
        }
        self.outcome(outcome).unwrap_or_default()
    }

    fn image(&mut self, index: usize) -> Vec<Command> {
        let Some(img) = self.snap.images.get(index) else {
            return vec![];
        };
        self.cursor[Pane::Images.index()] = index;
        vec![Command::Image { id: img.id.clone() }]
    }

    fn annotation(&mut self, index: usize) -> Vec<Command> {
        let Some(ann) = self.snap.annotations.get(index) else {
            return vec![];
        };
        self.cursor[Pane::Annotations.index()] = index;
        vec![Command::Select {
            id: Some(ann.id.clone()),
        }]
    }

    fn context(&self, index: usize) -> Vec<Command> {
        self.snap
            .contexts
            .get(index)
            .map(|c| vec![Command::Context { id: c.id.clone() }])
            .unwrap_or_default()
    }

    fn pane_len(&self, pane: Pane) -> usize {
        match pane {
            Pane::Tools => TOOLS.len(),
            Pane::Images => self.snap.images.len(),
            Pane::Annotations => self.snap.annotations.len(),
        }
    }

    fn move_cursor(&mut self, delta: isize) -> Vec<Command> {
        let len = self.pane_len(self.focus) as isize;
        if len == 0 {
            return vec![];
        }
        let c = &mut self.cursor[self.focus.index()];
        *c = (*c as isize + delta).rem_euclid(len) as usize;
        // Moving through the annotation list selects as it goes, so the canvas
        // highlights the row under the cursor.
        if self.focus == Pane::Annotations {
            let i = self.cursor[Pane::Annotations.index()];
            return self.annotation(i);
        }
        vec![]
    }

    fn activate_focused(&mut self) -> Vec<Command> {
        let i = self.cursor[self.focus.index()];
        match self.focus {
            Pane::Tools => self.tool(i),
            Pane::Images => self.image(i),
            Pane::Annotations => self.annotation(i),
        }
    }

    /// Handles a key. `None` means the shell has no use for it, so the browser
    /// keeps its default; `Some` carries the commands to send (maybe none).
    pub fn on_key(&mut self, key: Key) -> Option<Vec<Command>> {
        if self.help {
            // Any key closes the help screen; only `?` and Esc are swallowed.
            self.help = false;
            if matches!(key, Key::Esc | Key::Char('?')) {
                return Some(vec![]);
            }
        }
        match key {
            Key::Char('?') => {
                self.help = true;
                Some(vec![])
            }
            Key::Tab => {
                self.focus = self.focus.next();
                Some(vec![])
            }
            Key::BackTab => {
                self.focus = self.focus.prev();
                Some(vec![])
            }
            Key::Up | Key::Char('k') => Some(self.move_cursor(-1)),
            Key::Down | Key::Char('j') => Some(self.move_cursor(1)),
            Key::Enter => Some(self.activate_focused()),
            _ => {
                let outcome = shortcut(key, &self.snap);
                self.outcome(outcome)
            }
        }
    }

    /// Handles a left click on terminal cell (`col`, `row`).
    pub fn on_click(&mut self, col: u16, row: u16) -> Vec<Command> {
        if self.help {
            self.help = false;
            return vec![];
        }
        let pos = Position::new(col, row);
        let Some(hit) = self
            .hits
            .iter()
            .find(|(r, _)| r.contains(pos))
            .map(|(_, h)| *h)
        else {
            return vec![];
        };
        match hit {
            Hit::Tool(i) => {
                self.focus = Pane::Tools;
                self.tool(i)
            }
            Hit::Image(i) => {
                self.focus = Pane::Images;
                self.image(i)
            }
            Hit::Annotation(i) => {
                self.focus = Pane::Annotations;
                self.annotation(i)
            }
            Hit::Context(i) => self.context(i),
        }
    }

    pub fn on_snapshot(&mut self, snap: Snapshot) {
        // Follow what happened on the canvas: selection, image, tool.
        if let Some(sel) = &snap.selected_annotation_id {
            if let Some(i) = snap.annotations.iter().position(|a| &a.id == sel) {
                self.cursor[Pane::Annotations.index()] = i;
            }
        }
        if let Some(i) = snap
            .images
            .iter()
            .position(|img| Some(&img.id) == snap.active_image_id.as_ref())
        {
            self.cursor[Pane::Images.index()] = i;
        }
        let tool = snap.active_tool.as_deref();
        if let Some(i) = TOOLS.iter().position(|(_, t, _)| *t == tool) {
            self.cursor[Pane::Tools.index()] = i;
        }
        let a = &mut self.cursor[Pane::Annotations.index()];
        *a = (*a).min(snap.annotations.len().saturating_sub(1));
        if let Some(n) = &snap.notice {
            if n.seq != self.last_notice {
                self.last_notice = n.seq;
                self.status = n.text.clone();
            }
        }
        self.snap = snap;
    }

    // ── Rendering ───────────────────────────────────────────────────────────

    pub fn render(&mut self, f: &mut Frame) {
        self.hits.clear();
        let [header, body, footer] = Layout::vertical([
            Constraint::Length(3),
            Constraint::Min(5),
            Constraint::Length(2),
        ])
        .areas(f.area());
        let [sidebar, viewer] =
            Layout::horizontal([Constraint::Length(30), Constraint::Min(10)]).areas(body);
        let [tools, images, annotations] = Layout::vertical([
            Constraint::Length(TOOLS.len() as u16 + 2),
            Constraint::Length(self.snap.images.len() as u16 + 2),
            Constraint::Min(3),
        ])
        .areas(sidebar);

        self.render_header(f, header);
        self.render_tools(f, tools);
        self.render_images(f, images);
        self.render_annotations(f, annotations);
        self.render_viewer(f, viewer);
        self.render_footer(f, footer);
        if self.help {
            self.viewer = Rect::default();
            render_help(f, viewer);
        }
    }

    fn pane_block(&self, title: &str, pane: Pane) -> Block<'static> {
        let focused = self.focus == pane;
        Block::bordered()
            .border_type(if focused {
                BorderType::Thick
            } else {
                BorderType::Rounded
            })
            .border_style(if focused {
                Color::Yellow
            } else {
                Color::DarkGray
            })
            .title(format!(" {title} "))
    }

    fn render_header(&mut self, f: &mut Frame, area: Rect) {
        let selected = self
            .snap
            .contexts
            .iter()
            .position(|c| Some(&c.id) == self.snap.active_context_id.as_ref());
        let titles: Vec<String> = self.snap.contexts.iter().map(|c| c.label.clone()).collect();
        let block = Block::bordered()
            .border_type(BorderType::Rounded)
            .border_style(Color::DarkGray)
            .title(Line::from(vec![
                " osdlabel ".bold().fg(Color::Cyan),
                "× Ratzilla ".fg(Color::Magenta),
            ]))
            .title_bottom(
                Line::from(" [ ] context  ? help ")
                    .right_aligned()
                    .fg(Color::DarkGray),
            );
        let inner = block.inner(area);
        f.render_widget(
            Tabs::new(titles.clone())
                .block(block)
                .select(selected)
                .highlight_style(Style::new().fg(Color::Black).bg(Color::Cyan).bold())
                .divider("│"),
            area,
        );
        // Tabs lays out as: pad(1) title pad(1) divider ...
        let mut x = inner.x;
        for (i, t) in titles.iter().enumerate() {
            let w = t.chars().count() as u16 + 2;
            self.hits
                .push((Rect::new(x, inner.y, w, 1), Hit::Context(i)));
            x += w + 1;
        }
    }

    fn render_tools(&mut self, f: &mut Frame, area: Rect) {
        let block = self.pane_block("Tools", Pane::Tools);
        let width = block.inner(area).width as usize;
        let active = self.snap.active_tool.as_deref();
        let items: Vec<ListItem> = TOOLS
            .iter()
            .map(|(key, tool, label)| {
                let enabled = self.tool_enabled(*tool);
                let count = tool
                    .filter(|t| *t != "select")
                    .and_then(|t| self.snap.constraints.get(t))
                    .map(|s| match s.max {
                        Some(m) => format!("{}/{}", s.current, m),
                        None if s.enabled => format!("{}", s.current),
                        None => String::new(),
                    })
                    .unwrap_or_default();
                let mut style = Style::new();
                if !enabled {
                    style = style.fg(Color::DarkGray);
                }
                if *tool == active {
                    style = style.fg(Color::Black).bg(Color::Green).bold();
                }
                let left = format!(" {key}  {label}");
                let pad = width.saturating_sub(left.chars().count() + count.chars().count() + 3);
                ListItem::new(Line::from(vec![
                    Span::raw(left),
                    Span::raw(" ".repeat(pad)),
                    Span::raw(count).italic(),
                ]))
                .style(style)
            })
            .collect();
        self.list(f, area, block, items, Pane::Tools, Hit::Tool);
    }

    fn render_images(&mut self, f: &mut Frame, area: Rect) {
        let block = self.pane_block("Images", Pane::Images);
        let items: Vec<ListItem> = self
            .snap
            .images
            .iter()
            .map(|img| {
                let active = Some(&img.id) == self.snap.active_image_id.as_ref();
                let marker = if active { "▶" } else { " " };
                let item = ListItem::new(Line::from(vec![
                    Span::raw(format!(" {marker} {:<16}", img.label)),
                    Span::raw(format!("{:>3}", img.count)).fg(Color::Cyan),
                ]));
                if active {
                    item.style(Style::new().bold())
                } else {
                    item
                }
            })
            .collect();
        self.list(f, area, block, items, Pane::Images, Hit::Image);
    }

    fn render_annotations(&mut self, f: &mut Frame, area: Rect) {
        let title = format!("Annotations ({})", self.snap.annotations.len());
        let block = self.pane_block(&title, Pane::Annotations);
        let items: Vec<ListItem> = if self.snap.annotations.is_empty() {
            vec![ListItem::new(" (none yet)").fg(Color::DarkGray)]
        } else {
            self.snap
                .annotations
                .iter()
                .map(|a| {
                    let selected = Some(&a.id) == self.snap.selected_annotation_id.as_ref();
                    let item = ListItem::new(Line::from(vec![
                        Span::raw(if selected { " ● " } else { "   " }),
                        Span::raw(format!("{:<11}", a.tool)),
                        Span::raw(a.context.clone()).fg(Color::DarkGray),
                    ]));
                    if selected {
                        item.style(Style::new().fg(Color::Black).bg(Color::Yellow))
                    } else if !a.visible {
                        // Another context's annotation: not painted on the canvas.
                        item.style(Style::new().fg(Color::DarkGray))
                    } else {
                        item
                    }
                })
                .collect()
        };
        self.list(f, area, block, items, Pane::Annotations, Hit::Annotation);
    }

    fn list(
        &mut self,
        f: &mut Frame,
        area: Rect,
        block: Block<'static>,
        items: Vec<ListItem<'static>>,
        pane: Pane,
        hit: fn(usize) -> Hit,
    ) {
        let inner = block.inner(area);
        let mut state = ListState::default();
        if self.focus == pane && self.pane_len(pane) > 0 {
            state.select(Some(self.cursor[pane.index()]));
        }
        // `REVERSED` renders as a blank bar on Ratzilla's DOM backend.
        let list = List::new(items)
            .block(block)
            .highlight_symbol("›")
            .highlight_style(Style::new().add_modifier(Modifier::BOLD | Modifier::UNDERLINED));
        f.render_stateful_widget(list, area, &mut state);
        let offset = state.offset();
        let shown = self.pane_len(pane).saturating_sub(offset);
        for row in 0..inner.height.min(shown as u16) {
            let r = Rect::new(inner.x, inner.y + row, inner.width, 1);
            self.hits.push((r, hit(offset + row as usize)));
        }
    }

    fn render_viewer(&mut self, f: &mut Frame, area: Rect) {
        let label = self
            .snap
            .images
            .iter()
            .find(|i| Some(&i.id) == self.snap.active_image_id.as_ref())
            .map(|i| i.label.clone())
            .unwrap_or_else(|| "empty cell".into());
        let t = &self.snap.transform;
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
            flags.push(format!("exp {:+.1}", t.exposure));
        }
        if t.contrast != 0.0 {
            flags.push(format!("con {:+.1}", t.contrast));
        }
        let grid = self.snap.grid;
        let cells = grid.columns as usize * grid.rows as usize;
        let title = if cells > 1 {
            format!(
                " {label} · cell {}/{} ({}×{}) ",
                self.snap.active_cell + 1,
                cells,
                grid.columns,
                grid.rows
            )
        } else {
            format!(" {label} ")
        };
        let block = Block::bordered()
            .border_type(BorderType::Rounded)
            .border_style(Color::Cyan)
            .title(title)
            .title_bottom(Line::from(format!(" {} ", flags.join(" · "))).right_aligned());
        self.viewer = block.inner(area);
        f.render_widget(block, area);
    }

    fn render_footer(&mut self, f: &mut Frame, area: Rect) {
        let key = |k: &'static str| k.fg(Color::Yellow).bold();
        let dim = |on: bool, k: &'static str| {
            if on {
                key(k)
            } else {
                k.fg(Color::DarkGray)
            }
        };
        let help = Line::from(vec![
            key(" n/v/1-6"),
            " tool  ".into(),
            key("Tab"),
            " pane  ".into(),
            key("[ ]"),
            " context  ".into(),
            key("x"),
            " delete  ".into(),
            dim(self.snap.can_undo, "u"),
            "/".into(),
            dim(self.snap.can_redo, "U"),
            " undo/redo  ".into(),
            key("g"),
            " grid  ".into(),
            key("e/o"),
            " export/import  ".into(),
            key("?"),
            " help".into(),
        ]);
        let status = Line::from(format!(" {}", self.status)).fg(Color::Green);
        f.render_widget(Paragraph::new(vec![help, status]), area);
    }
}

fn render_help(f: &mut Frame, within: Rect) {
    let width = 58.min(within.width);
    let height = (HELP.len() as u16 + 2).min(within.height);
    let [area] = Layout::horizontal([Constraint::Length(width)])
        .flex(Flex::Center)
        .areas(within);
    let [area] = Layout::vertical([Constraint::Length(height)])
        .flex(Flex::Center)
        .areas(area);
    let lines: Vec<Line> = HELP
        .iter()
        .map(|(k, what)| {
            Line::from(vec![
                Span::raw(format!(" {k:>18}  ")).fg(Color::Yellow).bold(),
                Span::raw(*what),
            ])
        })
        .collect();
    f.render_widget(Clear, within);
    f.render_widget(
        Paragraph::new(lines).block(
            Block::bordered()
                .border_type(BorderType::Double)
                .border_style(Color::Yellow)
                .title(" Keys ")
                .title_bottom(Line::from(" any key closes ").right_aligned()),
        ),
        area,
    );
}

#[cfg(test)]
mod tests;
