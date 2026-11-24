//! The entry point and the bridge bindings.

use leptos::prelude::*;
use wasm_bindgen::{prelude::*, JsCast};

use crate::app::App;

#[wasm_bindgen]
extern "C" {
    /// What `src/main.ts` passes in: mounts osdlabel into an element.
    pub type Host;

    /// Mounts osdlabel into `el` and returns the bridge to drive it.
    #[wasm_bindgen(method)]
    pub fn mount(this: &Host, el: &web_sys::HtmlElement) -> Bridge;

    /// The handle `mountBridge()` returns (apps/shell-bridge/src/bridge.tsx).
    pub type Bridge;

    /// Applies a JSON command; returns a status line.
    #[wasm_bindgen(method)]
    pub fn dispatch(this: &Bridge, command: &str) -> String;

    #[wasm_bindgen(method)]
    pub fn subscribe(this: &Bridge, cb: &Closure<dyn FnMut(String)>);

    #[wasm_bindgen(method, js_name = onKey)]
    pub fn on_key(this: &Bridge, cb: &Closure<dyn FnMut(web_sys::KeyboardEvent)>);
}

/// Mounts the app into `#app`. `host` mounts osdlabel once the app has
/// rendered the element it goes in.
#[wasm_bindgen]
pub fn start(host: Host) -> Result<(), JsValue> {
    console_error_panic_hook::set_once();
    let root = document()
        .get_element_by_id("app")
        .ok_or("#app missing")?
        .dyn_into::<web_sys::HtmlElement>()?;
    leptos::mount::mount_to(root, move || {
        let host = StoredValue::new_local(host);
        view! { <App host /> }
    })
    .forget();
    Ok(())
}
