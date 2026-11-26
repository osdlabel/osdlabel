//! The browser side: Ratzilla's DOM backend, the draw loop, and the bridge to
//! osdlabel (`src/bridge.tsx`). All logic lives in [`crate::shell`].

use std::{cell::RefCell, rc::Rc};

use ratzilla::{
    event::{KeyCode, MouseButton, MouseEventKind},
    ratatui::{backend::Backend, layout::Rect, Terminal, TerminalOptions, Viewport},
    DomBackend, WebEventHandler,
};
use wasm_bindgen::prelude::*;

use crate::shell::{App, Command, Key, Snapshot};

#[wasm_bindgen]
extern "C" {
    /// The handle `mountBridge()` returns (apps/ratzilla-poc/src/bridge.tsx).
    pub type Bridge;

    /// Applies a JSON command; returns a status line.
    #[wasm_bindgen(method)]
    fn dispatch(this: &Bridge, command: &str) -> String;

    #[wasm_bindgen(method)]
    fn subscribe(this: &Bridge, cb: &Closure<dyn FnMut(String)>);

    #[wasm_bindgen(method, js_name = onKey)]
    fn on_key(this: &Bridge, cb: &Closure<dyn FnMut(web_sys::KeyboardEvent)>);

    #[wasm_bindgen(method, js_name = setViewerRect)]
    fn set_viewer_rect(this: &Bridge, col: u16, row: u16, cols: u16, rows: u16);
}

/// Sends commands and shows the last one's result as the status line.
///
/// Never called while JS is mid-update: snapshots arrive on a microtask, so the
/// `RefCell` borrow held around this cannot be re-entered.
fn send(bridge: &Bridge, app: &mut App, commands: Vec<Command>) {
    for command in commands {
        match serde_json::to_string(&command) {
            Ok(json) => app.set_status(bridge.dispatch(&json)),
            Err(e) => app.set_status(format!("encode failed: {e}")),
        }
    }
}

fn key_of(event: &web_sys::KeyboardEvent) -> Option<Key> {
    Some(match KeyCode::from(event.clone()) {
        KeyCode::Char(c) => Key::Char(c),
        KeyCode::Tab if event.shift_key() => Key::BackTab,
        KeyCode::Tab => Key::Tab,
        KeyCode::Up => Key::Up,
        KeyCode::Down => Key::Down,
        KeyCode::Left => Key::Left,
        KeyCode::Right => Key::Right,
        KeyCode::Enter => Key::Enter,
        KeyCode::Esc => Key::Esc,
        KeyCode::Delete => Key::Delete,
        KeyCode::Backspace => Key::Backspace,
        _ => return None,
    })
}

/// Mounts the shell. `bridge` is the handle from `mountBridge()`.
#[wasm_bindgen]
pub fn start(bridge: Bridge) -> Result<(), JsValue> {
    console_error_panic_hook::set_once();
    let bridge = Rc::new(bridge);
    let app = Rc::new(RefCell::new(App::new()));

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
        let (app, bridge) = (app.clone(), bridge.clone());
        move |event: web_sys::KeyboardEvent| {
            if event.ctrl_key() || event.meta_key() || event.alt_key() {
                return;
            }
            let Some(key) = key_of(&event) else { return };
            let mut app = app.borrow_mut();
            if let Some(commands) = app.on_key(key) {
                event.prevent_default();
                send(&bridge, &mut app, commands);
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

    let needs_fit = Rc::new(RefCell::new(true));
    let refit = Closure::<dyn FnMut()>::new({
        let flag = needs_fit.clone();
        move || *flag.borrow_mut() = true
    });
    let window = web_sys::window().ok_or("no window")?;
    window.add_event_listener_with_callback("resize", refit.as_ref().unchecked_ref())?;
    // A web font that finishes loading changes the cell size without a resize.
    if let Some(Ok(ready)) = window.document().map(|d| d.fonts().ready()) {
        let flag = needs_fit.clone();
        let on_ready = Closure::<dyn FnMut(JsValue)>::new(move |_| *flag.borrow_mut() = true);
        let _ = ready.then(&on_ready);
        on_ready.forget();
    }
    refit.forget();

    Shell::run(Shell {
        terminal,
        app,
        bridge,
        needs_fit,
        sent_viewer: None,
    });
    Ok(())
}

struct Shell {
    terminal: Terminal<DomBackend>,
    app: Rc<RefCell<App>>,
    bridge: Rc<Bridge>,
    needs_fit: Rc<RefCell<bool>>,
    sent_viewer: Option<(Rect, Rect)>,
}

type FrameCallback = Closure<dyn FnMut()>;

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
        let (app, bridge) = (self.app.clone(), self.bridge.clone());
        self.terminal
            .backend_mut()
            .on_mouse_event(move |e| {
                if e.kind == MouseEventKind::SingleClick(MouseButton::Left) {
                    let mut app = app.borrow_mut();
                    let commands = app.on_click(e.col, e.row);
                    send(&bridge, &mut app, commands);
                }
            })
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

        let viewer = app.borrow().viewer_area();
        let area = self.terminal.get_frame().area();
        if self.sent_viewer != Some((viewer, area)) {
            self.sent_viewer = Some((viewer, area));
            self.bridge
                .set_viewer_rect(viewer.x, viewer.y, viewer.width, viewer.height);
        }
        Ok(())
    }

    fn run(shell: Shell) {
        let shell = RefCell::new(shell);
        let tick: Rc<RefCell<Option<FrameCallback>>> = Rc::new(RefCell::new(None));
        let next = tick.clone();
        *tick.borrow_mut() = Some(Closure::new(move || {
            if let Err(e) = shell.borrow_mut().frame() {
                web_sys::console::error_1(&e.into());
            }
            request_frame(next.borrow().as_ref().expect("frame callback"));
        }));
        request_frame(tick.borrow().as_ref().expect("frame callback"));
    }
}

fn request_frame(f: &FrameCallback) {
    if let Some(window) = web_sys::window() {
        let _ = window.request_animation_frame(f.as_ref().unchecked_ref());
    }
}
