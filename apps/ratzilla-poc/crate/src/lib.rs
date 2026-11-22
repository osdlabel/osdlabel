//! An osdlabel annotator shell written as a Ratatui TUI, run in the browser by
//! Ratzilla.
//!
//! The TUI owns every control: tools, annotation contexts, images, view
//! transforms, the annotation list, delete and export. osdlabel only paints the
//! image and its annotation canvas, into a `<div>` the JS bridge lays over the
//! terminal cells this shell leaves empty for it (`Viewer` below).
//!
//! The shell never mirrors osdlabel's state on its own: it sends commands
//! (`Bridge::dispatch`) and redraws from the snapshots the bridge pushes back.

use std::{cell::RefCell, rc::Rc};

use ratzilla::{
    event::{KeyCode, KeyEvent, MouseButton, MouseEvent, MouseEventKind},
    ratatui::{
        backend::Backend,
        layout::{Constraint, Layout, Rect},
        style::{Color, Modifier, Style, Stylize},
        text::{Line, Span},
        widgets::{Block, BorderType, List, ListItem, ListState, Paragraph, Tabs},
        Frame, Terminal, TerminalOptions, Viewport,
    },
    DomBackend, WebEventHandler,
};
use serde::Deserialize;
use serde_json::json;
use wasm_bindgen::prelude::*;

// ── The JS side ─────────────────────────────────────────────────────────────

#[wasm_bindgen]
extern "C" {
    /// The handle `mountBridge()` returns (apps/ratzilla-poc/src/bridge.tsx).
    pub type Bridge;

    #[wasm_bindgen(method)]
    fn dispatch(this: &Bridge, command: &str) -> String;

    #[wasm_bindgen(method)]
    fn subscribe(this: &Bridge, cb: &Closure<dyn FnMut(String)>);

    #[wasm_bindgen(method, js_name = onKey)]
    fn on_key(this: &Bridge, cb: &Closure<dyn FnMut(web_sys::KeyboardEvent)>);

    #[wasm_bindgen(method, js_name = setViewerRect)]
    fn set_viewer_rect(this: &Bridge, col: u16, row: u16, cols: u16, rows: u16);
}

// ── Snapshot (JS → Rust) ────────────────────────────────────────────────────

#[derive(Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    active_tool: Option<String>,
    active_context_id: Option<String>,
    contexts: Vec<Named>,
    images: Vec<ImageEntry>,
    active_image_id: Option<String>,
    selected_annotation_id: Option<String>,
    constraints: std::collections::HashMap<String, ToolStatus>,
    annotations: Vec<AnnotationEntry>,
    transform: Transform,
}

#[derive(Deserialize, Clone)]
struct Named {
    id: String,
    label: String,
}

#[derive(Deserialize, Clone)]
struct ImageEntry {
    id: String,
    label: String,
    count: usize,
}

#[derive(Deserialize, Clone, Copy)]
struct ToolStatus {
    enabled: bool,
    current: u32,
    max: Option<u32>,
}

#[derive(Deserialize, Clone)]
struct AnnotationEntry {
    id: String,
    tool: String,
    context: String,
    visible: bool,
}

#[derive(Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
struct Transform {
    rotation: i32,
    flipped_h: bool,
    flipped_v: bool,
    inverted: bool,
    exposure: f64,
    contrast: f64,
}

// ── Shell state ─────────────────────────────────────────────────────────────

/// (key, tool id or None for navigate, label)
const TOOLS: [(char, Option<&str>, &str); 8] = [
    ('n', None, "Navigate"),
    ('v', Some("select"), "Select"),
    ('1', Some("rectangle"), "Rectangle"),
    ('2', Some("circle"), "Circle"),
    ('3', Some("line"), "Line"),
    ('4', Some("point"), "Point"),
    ('5', Some("polyline"), "Polyline"),
    ('6', Some("freeHandPath"), "Freehand"),
];

#[derive(Clone, Copy, PartialEq, Eq)]
enum Pane {
    Tools,
    Images,
    Annotations,
}

impl Pane {
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

/// Something a mouse click on the TUI can hit.
#[derive(Clone)]
enum Hit {
    Tool(usize),
    Image(usize),
    Annotation(usize),
    Context(usize),
}

struct App {
    bridge: Rc<Bridge>,
    snap: Snapshot,
    focus: Pane,
    cursor: [usize; 3],
    status: String,
    hits: Vec<(Rect, Hit)>,
    viewer: Rect,
}

impl App {
    fn send(&mut self, command: serde_json::Value) {
        self.status = self.bridge.dispatch(&command.to_string());
    }

    fn tool_enabled(&self, tool: Option<&str>) -> bool {
        match tool {
            None | Some("select") => true,
            Some(t) => self.snap.constraints.get(t).is_some_and(|s| s.enabled),
        }
    }

    fn activate_tool(&mut self, index: usize) {
        let (_, tool, label) = TOOLS[index];
        if !self.tool_enabled(tool) {
            self.status = format!("{label} is not available in this context");
            return;
        }
        self.cursor[0] = index;
        self.send(json!({ "t": "tool", "tool": tool }));
    }

    fn activate_image(&mut self, index: usize) {
        if let Some(img) = self.snap.images.get(index) {
            let id = img.id.clone();
            self.cursor[1] = index;
            self.send(json!({ "t": "image", "id": id }));
        }
    }

    fn activate_annotation(&mut self, index: usize) {
        if let Some(ann) = self.snap.annotations.get(index) {
            let id = ann.id.clone();
            self.cursor[2] = index;
            self.send(json!({ "t": "select", "id": id }));
        }
    }

    fn activate_context(&mut self, index: usize) {
        if let Some(ctx) = self.snap.contexts.get(index) {
            let id = ctx.id.clone();
            self.send(json!({ "t": "context", "id": id }));
        }
    }

    fn cycle_context(&mut self, delta: isize) {
        let n = self.snap.contexts.len() as isize;
        if n == 0 {
            return;
        }
        let current = self
            .snap
            .contexts
            .iter()
            .position(|c| Some(&c.id) == self.snap.active_context_id.as_ref())
            .unwrap_or(0) as isize;
        self.activate_context(((current + delta).rem_euclid(n)) as usize);
    }

    fn pane_len(&self, pane: Pane) -> usize {
        match pane {
            Pane::Tools => TOOLS.len(),
            Pane::Images => self.snap.images.len(),
            Pane::Annotations => self.snap.annotations.len(),
        }
    }

    fn move_cursor(&mut self, delta: isize) {
        let len = self.pane_len(self.focus) as isize;
        if len == 0 {
            return;
        }
        let c = &mut self.cursor[self.focus as usize];
        *c = ((*c as isize + delta).rem_euclid(len)) as usize;
        // Moving through the annotation list selects as it goes, so the canvas
        // highlights the row under the cursor.
        if self.focus == Pane::Annotations {
            let i = self.cursor[2];
            self.activate_annotation(i);
        }
    }

    fn activate_focused(&mut self) {
        let i = self.cursor[self.focus as usize];
        match self.focus {
            Pane::Tools => self.activate_tool(i),
            Pane::Images => self.activate_image(i),
            Pane::Annotations => self.activate_annotation(i),
        }
    }

    fn view(&mut self, op: &str) {
        self.send(json!({ "t": "view", "op": op }));
    }

    /// Returns true when the key was used, so the browser default is suppressed.
    fn on_key(&mut self, key: KeyEvent) -> bool {
        match key.code {
            KeyCode::Tab if key.shift => self.focus = self.focus.prev(),
            KeyCode::Tab => self.focus = self.focus.next(),
            KeyCode::Up | KeyCode::Char('k') => self.move_cursor(-1),
            KeyCode::Down | KeyCode::Char('j') => self.move_cursor(1),
            KeyCode::Enter => self.activate_focused(),
            KeyCode::Esc => {
                if self.snap.selected_annotation_id.is_some() {
                    self.send(json!({ "t": "select", "id": null }));
                } else {
                    self.activate_tool(0);
                }
            }
            KeyCode::Delete | KeyCode::Backspace | KeyCode::Char('x') => {
                self.send(json!({ "t": "delete" }))
            }
            KeyCode::Char('[') => self.cycle_context(-1),
            KeyCode::Char(']') => self.cycle_context(1),
            KeyCode::Char('r') => self.view("rotateCW"),
            KeyCode::Char('R') => self.view("rotateCCW"),
            KeyCode::Char('h') => self.view("flipH"),
            KeyCode::Char('H') => self.view("flipV"),
            KeyCode::Char('i') => self.view("invert"),
            KeyCode::Char('+') => self.view("exposureUp"),
            KeyCode::Char('-') => self.view("exposureDown"),
            KeyCode::Char('>') => self.view("contrastUp"),
            KeyCode::Char('<') => self.view("contrastDown"),
            KeyCode::Char('0') => self.view("reset"),
            KeyCode::Char('e') => self.send(json!({ "t": "export" })),
            KeyCode::Char(c) => match TOOLS.iter().position(|(k, _, _)| *k == c) {
                Some(i) => self.activate_tool(i),
                None => return false,
            },
            _ => return false,
        }
        true
    }

    fn on_mouse(&mut self, event: MouseEvent) {
        if !matches!(event.kind, MouseEventKind::SingleClick(MouseButton::Left)) {
            return;
        }
        let pos = (event.col, event.row).into();
        let hit = self
            .hits
            .iter()
            .find(|(r, _)| r.contains(pos))
            .map(|(_, h)| h.clone());
        match hit {
            Some(Hit::Tool(i)) => {
                self.focus = Pane::Tools;
                self.activate_tool(i)
            }
            Some(Hit::Image(i)) => {
                self.focus = Pane::Images;
                self.activate_image(i)
            }
            Some(Hit::Annotation(i)) => {
                self.focus = Pane::Annotations;
                self.activate_annotation(i)
            }
            Some(Hit::Context(i)) => self.activate_context(i),
            None => {}
        }
    }

    fn on_snapshot(&mut self, snap: Snapshot) {
        // Follow selection made on the canvas.
        if let Some(sel) = &snap.selected_annotation_id {
            if let Some(i) = snap.annotations.iter().position(|a| &a.id == sel) {
                self.cursor[2] = i;
            }
        }
        if let Some(i) = snap
            .images
            .iter()
            .position(|img| Some(&img.id) == snap.active_image_id.as_ref())
        {
            self.cursor[1] = i;
        }
        let tool = snap.active_tool.as_deref();
        if let Some(i) = TOOLS.iter().position(|(_, t, _)| *t == tool) {
            self.cursor[0] = i;
        }
        self.cursor[2] = self.cursor[2].min(snap.annotations.len().saturating_sub(1));
        self.snap = snap;
    }

    // ── Rendering ───────────────────────────────────────────────────────────

    fn render(&mut self, f: &mut Frame) {
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
                Line::from(" [ ] context ")
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
        let inner = block.inner(area);
        let active = self.snap.active_tool.as_deref();
        let items: Vec<ListItem> = TOOLS
            .iter()
            .map(|(key, tool, label)| {
                let enabled = self.tool_enabled(*tool);
                let count = tool
                    .and_then(|t| self.snap.constraints.get(t))
                    .filter(|_| *tool != Some("select"))
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
                let width = inner.width as usize;
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
                let line = Line::from(vec![
                    Span::raw(format!(" {marker} {:<16}", img.label)),
                    Span::raw(format!("{:>3}", img.count)).fg(Color::Cyan),
                ]);
                let item = ListItem::new(line);
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
                    let line = Line::from(vec![
                        Span::raw(if selected { " ● " } else { "   " }),
                        Span::raw(format!("{:<11}", a.tool)),
                        Span::raw(a.context.clone()).fg(Color::DarkGray),
                    ]);
                    let item = ListItem::new(line);
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
        let len = items.len();
        let mut state = ListState::default();
        if self.focus == pane && self.pane_len(pane) > 0 {
            state.select(Some(self.cursor[pane as usize]));
        }
        let list = List::new(items)
            .block(block)
            .highlight_symbol("›")
            .highlight_style(Style::new().add_modifier(Modifier::BOLD | Modifier::UNDERLINED));
        f.render_stateful_widget(list, area, &mut state);
        let offset = state.offset();
        if self.pane_len(pane) > 0 {
            for row in 0..inner.height.min(len.saturating_sub(offset) as u16) {
                let r = Rect::new(inner.x, inner.y + row, inner.width, 1);
                self.hits.push((r, hit(offset + row as usize)));
            }
        }
    }

    fn render_viewer(&mut self, f: &mut Frame, area: Rect) {
        let label = self
            .snap
            .images
            .iter()
            .find(|i| Some(&i.id) == self.snap.active_image_id.as_ref())
            .map(|i| i.label.clone())
            .unwrap_or_else(|| "no image".into());
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
        let block = Block::bordered()
            .border_type(BorderType::Rounded)
            .border_style(Color::Cyan)
            .title(format!(" {label} "))
            .title_bottom(Line::from(format!(" {} ", flags.join(" · "))).right_aligned());
        self.viewer = block.inner(area);
        f.render_widget(block, area);
    }

    fn render_footer(&mut self, f: &mut Frame, area: Rect) {
        let key = |k: &'static str| k.fg(Color::Yellow).bold();
        let help = Line::from(vec![
            key(" n/v/1-6"),
            " tool  ".into(),
            key("Tab"),
            " pane  ".into(),
            key("↑↓ Enter"),
            " pick  ".into(),
            key("[ ]"),
            " context  ".into(),
            key("x"),
            " delete  ".into(),
            key("r/R h/H i +- <> 0"),
            " view  ".into(),
            key("e"),
            " export".into(),
        ]);
        let status = Line::from(format!(" {}", self.status)).fg(Color::Green);
        f.render_widget(Paragraph::new(vec![help, status]), area);
    }
}

// ── Entry point ─────────────────────────────────────────────────────────────

/// Mounts the shell. `bridge` is the handle from `mountBridge()`.
#[wasm_bindgen]
pub fn start(bridge: Bridge) -> Result<(), JsValue> {
    console_error_panic_hook::set_once();
    let bridge = Rc::new(bridge);
    let app = Rc::new(RefCell::new(App {
        bridge: bridge.clone(),
        snap: Snapshot::default(),
        focus: Pane::Tools,
        cursor: [0; 3],
        status: "Ready".into(),
        hits: Vec::new(),
        viewer: Rect::default(),
    }));

    // Snapshots: the bridge delivers them on a microtask, never while a
    // dispatch from here is still on the stack, so this borrow cannot clash.
    let on_snapshot = Closure::<dyn FnMut(String)>::new({
        let app = app.clone();
        move |json: String| match serde_json::from_str::<Snapshot>(&json) {
            Ok(snap) => app.borrow_mut().on_snapshot(snap),
            Err(e) => web_sys::console::error_1(&format!("bad snapshot: {e}").into()),
        }
    });
    bridge.subscribe(&on_snapshot);
    on_snapshot.forget();

    let on_key = Closure::<dyn FnMut(web_sys::KeyboardEvent)>::new({
        let app = app.clone();
        move |event: web_sys::KeyboardEvent| {
            if event.ctrl_key() || event.meta_key() || event.alt_key() {
                return;
            }
            if app.borrow_mut().on_key(KeyEvent::from(event.clone())) {
                event.prevent_default();
            }
        }
    });
    bridge.on_key(&on_key);
    on_key.forget();

    let backend = DomBackend::new_by_id("tui").map_err(|e| JsValue::from_str(&e.to_string()))?;
    // A fixed viewport, sized from the backend's own measurement of its grid
    // (see `Shell::fit`), not `Backend::size()`, which DomBackend 0.3 derives
    // from the window with a nominal 10×20 px cell.
    let terminal = Terminal::with_options(
        backend,
        TerminalOptions {
            viewport: Viewport::Fixed(Rect::default()),
        },
    )
    .map_err(|e| JsValue::from_str(&e.to_string()))?;

    let shell = Rc::new(RefCell::new(Shell {
        terminal,
        app,
        needs_fit: Rc::new(RefCell::new(true)),
        sent_viewer: None,
    }));

    let resize = Closure::<dyn FnMut()>::new({
        let flag = shell.borrow().needs_fit.clone();
        move || *flag.borrow_mut() = true
    });
    web_sys::window()
        .ok_or("no window")?
        .add_event_listener_with_callback("resize", resize.as_ref().unchecked_ref())?;
    resize.forget();

    Shell::run(shell);
    Ok(())
}

struct Shell {
    terminal: Terminal<DomBackend>,
    app: Rc<RefCell<App>>,
    needs_fit: Rc<RefCell<bool>>,
    sent_viewer: Option<(Rect, Rect)>,
}

impl Shell {
    /// Makes the terminal exactly as large as the grid DomBackend builds.
    ///
    /// DomBackend rebuilds its grid on the first draw after a resize. Drawing a
    /// zero-sized frame first lets it do that without being handed cells it no
    /// longer has; its re-measured grid size is then the viewport.
    fn fit(&mut self) -> Result<(), String> {
        let err = |e: std::io::Error| e.to_string();
        self.terminal.resize(Rect::default()).map_err(err)?;
        self.terminal.draw(|_| {}).map_err(err)?;
        let size = self
            .terminal
            .backend_mut()
            .window_size()
            .map_err(err)?
            .columns_rows;
        self.terminal
            .resize(Rect::new(0, 0, size.width, size.height))
            .map_err(err)?;

        // Mouse coordinates are computed from the grid size at registration.
        let app = self.app.clone();
        self.terminal
            .backend_mut()
            .on_mouse_event(move |e| app.borrow_mut().on_mouse(e))
            .map_err(|e| e.to_string())?;
        self.sent_viewer = None;
        Ok(())
    }

    fn frame(&mut self) -> Result<(), String> {
        if self.needs_fit.replace(false) {
            self.fit()?;
        }
        let app = self.app.clone();
        self.terminal
            .draw(|f| app.borrow_mut().render(f))
            .map_err(|e| e.to_string())?;

        let viewer = app.borrow().viewer;
        let area = self.terminal.get_frame().area();
        if self.sent_viewer != Some((viewer, area)) {
            self.sent_viewer = Some((viewer, area));
            let bridge = app.borrow().bridge.clone();
            bridge.set_viewer_rect(viewer.x, viewer.y, viewer.width, viewer.height);
        }
        Ok(())
    }

    fn run(shell: Rc<RefCell<Shell>>) {
        let tick: Rc<RefCell<Option<FrameCallback>>> = Rc::new(RefCell::new(None));
        let tick2 = tick.clone();
        *tick.borrow_mut() = Some(Closure::new(move || {
            if let Err(e) = shell.borrow_mut().frame() {
                web_sys::console::error_1(&e.into());
            }
            request_frame(tick2.borrow().as_ref().unwrap());
        }));
        request_frame(tick.borrow().as_ref().unwrap());
    }
}

type FrameCallback = Closure<dyn FnMut()>;

fn request_frame(f: &FrameCallback) {
    web_sys::window()
        .unwrap()
        .request_animation_frame(f.as_ref().unchecked_ref())
        .unwrap();
}
