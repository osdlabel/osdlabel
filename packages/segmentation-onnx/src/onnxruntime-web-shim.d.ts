// `onnxruntime-web` is an OPTIONAL peer dependency: it is intentionally not
// installed in this workspace (it ships hundreds of MB of prebuilt WASM). This
// ambient declaration lets the package typecheck and build without it; the only
// consumer of the runtime is `ort-session.ts`, which casts the dynamic import to
// a narrow local interface. This file is not emitted to `dist`, so it never
// affects consumers (who install the real `onnxruntime-web` and get its types).
declare module 'onnxruntime-web';
