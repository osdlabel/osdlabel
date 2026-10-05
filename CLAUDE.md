# CLAUDE.md — Project Instructions for Claude Code

## Project Overview

This is `osdlabel`, a DZI image annotation library built with SolidJS, Fabric.js v7, OpenSeaDragon, and TypeScript. Read `image-annotator-spec.md` for the full specification. Read the task files in `tasks/` sequentially — each task builds on the previous one.

## Critical Rules

### TypeScript

- **Never use `any`.** Use `unknown` with type guards, or a specific type. If you find yourself reaching for `any`, stop and define a proper type.
- Always use `const` assertions for literal types: `as const`.
- Prefer `readonly` properties on interfaces. All annotation data types must be immutable. **Exception:** SolidJS store shape interfaces (`AnnotationState`, `UIState`, `ContextState`) omit `readonly` because SolidJS enforces immutability at runtime via store proxies, and `readonly` conflicts with SolidJS's `SetStoreFunction` path-based API.
- Use branded types for IDs (`AnnotationId`, `ImageId`, `AnnotationContextId`) — never pass raw strings where branded types are expected.
- Use discriminated unions (not type assertions) for geometry types. Always check `geometry.type` before accessing geometry-specific fields.
- **`exactOptionalPropertyTypes` is on.** When you're constructing an object literal for a destination type whose field is declared `field?: T | undefined` (note the explicit `| undefined`), you can include `{ field: undefined }` directly — assignment is allowed. When the field is declared `field?: T` (no `| undefined`), assigning `undefined` is a type error and you need the conditional-spread pattern: `...(value !== undefined ? { field: value } : {})`. The decoration / live-update code uses both patterns depending on the destination shape; check the target interface before picking one.
- Run `pnpm typecheck` after every file change. Fix all type errors before proceeding.

### SolidJS

- **Components run once.** Do not write SolidJS components as if they re-render like React. The JSX function body executes once to set up the view. Reactive updates happen through signals and effects.
- **Use `onMount` for imperative library initialization** (OSD viewer, Fabric canvas). Clean up with `onCleanup`. Never create OSD/Fabric instances inside `createMemo` or derived computations.
- **Use `createEffect` to synchronize imperative libraries with reactive state.** When the active tool signal changes, update the Fabric canvas interaction mode inside a `createEffect`. Do NOT re-render the component tree.
- **Do not destructure props.** In Solid, destructuring props breaks reactivity. Access props with `props.myProp` inside JSX or effects.
- **Use `createStore` with `produce` for nested state updates.** This is Solid's equivalent of Immer — it provides immutable-style update semantics with fine-grained tracking.

### React

- **`useRef` requires an initial value in React 19.** `useRef<T>()` with zero arguments is a type error. Use `useRef<T | undefined>(undefined)`.
- **Use `castDraft` from Immer** when spreading objects with `readonly` array fields (e.g., geometry) into draft state. Immer's `WritableDraft` is incompatible with `readonly` arrays.
- **Mount-only `useEffect` closures are stale.** Use `useRef` to hold mutable values that OSD event handlers need across re-renders (e.g., `overlayRef` to guard against duplicate `FabricOverlay` creation on each OSD `'open'` event).
- **Memo / effect deps must be as granular as Immer's structural sharing allows.** Depending on the whole `annotationState` busts every memo on every annotation mutation in any cell — Immer replaces the root reference. Depend on `annotationState.byImage[imageId]` instead: Immer keeps unchanged sub-trees referentially stable, so a draw in cell A leaves cell B's per-image dict reference intact and B's effects don't refire. Same principle applies to `contextState` sub-fields. (Solid is unaffected — store proxies track per-property access natively.)
- **Subscriptions that need fresh state without resubscribing read the store, or a ref.** When a `useEffect` registers an event handler that fires across many React renders, the handler closure must observe the current state; the `useEffect` itself only depends on the subscription-establishing inputs (e.g. `overlay`), so resubscription stays rare. Annotator state (annotations, UI, contexts, constraint status) lives in the provider's external store: read it with `store.getSnapshot()` / `store.getConstraintStatus()` from `useAnnotator()`, or through the action getters. Those are current even mid-batch, right after an action issued earlier in the same handler (#217); a ref refreshed on render is not. Refs stay for values derived during render (e.g. `ViewerCell`'s `visibleAnnotationsRef` for `enableLiveDecorationUpdates`): mirror each into a ref on every render (`ref.current = value`) and have the handler read `ref.current`.

### Fabric.js v7

- **Import from `'fabric'` directly.** v7 uses named exports: `import { Canvas, Rect, Circle } from 'fabric'`. There is no `fabric.` namespace.
- **Do NOT use `fabric.Canvas` in detached/offscreen mode.** The canvas must be attached to a visible DOM `<canvas>` element for event handling to work.
- **`viewportTransform` is a 6-element array** `[scaleX, skewY, skewX, scaleY, translateX, translateY]`. Use `canvas.setViewportTransform(matrix)` to update it. After setting it, call `canvas.requestRenderAll()`.
- **Fabric objects use image-space coordinates.** Store annotation geometry in image-space and use the overlay's `viewportTransform` to map to screen-space. Do not convert coordinates on each object — that's what the canvas transform does.
- **`canvas.getZoom()` assumes `viewportTransform[0]` is the zoom level**, which is only true for scale+translate matrices. With rotation, `vpt[0] = cos(θ)·scale` — zero at 90°, negative at 180°. This breaks object caching. Override with `Math.sqrt(vpt[0]² + vpt[1]²)`.
- **Set `skipOffscreen: false`** when the viewportTransform includes rotation. Fabric's offscreen culling doesn't account for rotation and incorrectly hides visible objects.
- **All Fabric API calls must go through the overlay interface** (`FabricOverlay`). Components should never import from `'fabric'` directly or access the Fabric canvas instance except through the overlay.
- **`obj.id` is reserved for annotation objects.** It's how `ViewerCell` discriminates annotation objects from companion-layer objects on the same canvas (the clear filter is `obj => obj.id`, registered via `initFabricModule`'s `FabricObject.customProperties`). Non-annotation Fabric objects (decoration lines, drawing previews, future overlay graphics) MUST NOT carry an `id`. Use `_readOnly: true` so `FabricOverlay.setMode` keeps them inert (`selectable: false, evented: false`) in both navigation and annotation modes; do not register `_readOnly` as a serialized custom property.
- **Fabric's `mouse:dblclick` never fires here, and `PointerEvent.detail` is always 0.** The Fabric canvas is `pointerEvents: 'none'` and every input is routed through an OSD `MouseTracker` on the container, so the browser's `dblclick` targets the container and the upper canvas only sees the synthetic pointer events `_forwardToFabric` dispatches. Testing `event.detail === 2` in `onPointerDown` compiles, type-checks, and can never be true (issue #168). Use `FabricOverlay.onDoubleClick(cb)`; tools receive it as the optional `AnnotationTool.onDoubleClick`. The gesture still delivers both `pointerdown`s first, so a tool that accumulates points on press must drop what they added — and not by counting, since a press landing on an existing annotation is suppressed. Since #176 the overlay identifies them exactly: every forwarded `pointerdown` carries a monotonic press sequence (`ToolOverlay.pressSeqOf(event)`), `onDoubleClick` receives the pair that formed the gesture, and a tool stamps each accumulated entry with the sequence that placed it. `pressSeqOf` is keyed on the _synthetic_ event and populated only for presses, so anything else returns `undefined` — which means "not a tracked press, never drop it", not a stale number. Detection deliberately avoids both the MouseTracker's own `dblClickHandler` and the container's native `dblclick` — the latter does fire, but carries no correlation to the presses that produced it — and touch reaches it as of #175 (before that the forwarded press was double-counted, so `releaseHandler` — which detection runs from — never fired for touch). See the "Double clicks" section of `apps/docs/src/content/docs/guides/osd-fabric-integration.md` for the derivation.
- **`ActiveSelection` (multi-drag) limitation.** When the user drags a multi-select, Fabric fires `object:moving` with `target` set to the `ActiveSelection` group (which has no `id`). The group's children's `left`/`top` are reported relative to the group, not the canvas — so `getGeometryFromFabricObject` is exact for matrix-based shapes (line, polyline, polygon, all of which use `calcTransformMatrix`) but approximate for `left`/`top`-based ones (rectangle, circle, point). Live updates accept this caveat; the commit on mouse-up via `object:modified` is always correct because Fabric dissolves the `ActiveSelection` before firing it. Detect group targets via duck-typed `getObjects()` rather than coupling to Fabric's `type`-string casing.

### OpenSeaDragon

- **OSD `viewportTransform` is NOT the same as Fabric's.** OSD uses its own coordinate system where image width maps to 0–1 in viewport coordinates. Use `viewer.viewport.viewportToImageCoordinates()` and `viewer.viewport.imageToViewerElementCoordinates()` for conversions.
- **Subscribe to `'animation'` event for smooth overlay sync**, not `'animation-finish'`. The `animation` event fires on every frame during pan/zoom animations.
- **Toggle mouse navigation** with `viewer.setMouseNavEnabled(boolean)`. Use this to switch between navigation mode (OSD handles input) and annotation mode (Fabric handles input).
- **Each OSD viewer must have a unique DOM container.** Never try to attach two OSD viewers to the same element.
- **`imageToViewerElementCoordinates` does NOT account for flip.** Flip is applied only in OSD's drawer rendering pipeline (`context.scale(-1,1)`). The Fabric viewportTransform must compose flip separately — see `computeViewportTransform`. **The `FabricOverlay.imageToScreen` / `screenToImage` methods (and the pure exported helpers `imageToScreenFlipAware` / `screenToImageFlipAware`) compose the same horizontal mirror around `x = W/2`.** Always use those for image↔screen conversions consumed as absolute positions (e.g. the `DecorationLayer`'s text positioning) — calling OSD's raw `imageToViewerElementCoordinates` directly will drift relative to painted Fabric objects whenever exactly one of `flippedH`/`flippedV` is active (when both flips are on, `applyViewTransform` collapses to `isFlipped = false` and there is no drift). Callers that only need screen-space _distances_ between two image points (e.g. polyline-tool's close-to-first-point check) are invariant under the mirror and can use either path.
- **`viewport.setRotation(degrees)` uses spring animation by default.** Pass `immediately=true` to snap; otherwise `sync()` computes a matrix for an intermediate rotation angle.
- **For dev/testing, use OSD's `type: 'image'` tile source** with local images. This avoids needing a DZI tile server during development. The library should also support DZI for production. The DZI path still needs dev coverage, so `apps/dev/sample-data/` also vendors a small Deep Zoom pyramid (`tiled.dzi` + `tiled_files/`, 800×600, 25 tiles, 12 KB) that OSD opens as a real tile source with no server beyond Vite. **Every image either dev app offers must be local** — `apps/dev/tests/e2e/offline.spec.ts` fails if loading the app and cycling the filmstrip issues any request off the dev server's origin (issue #144). `apps/docs` is the deliberate exception and keeps its remote DZIs. Assets are synthetic and no generator is committed; see `apps/dev/sample-data/README.md`.

### Architecture

The project is split into ten packages with clear dependency boundaries:

- **`@osdlabel/annotation`** (`packages/annotation/`) — Pure annotation data model. Zero dependencies. Types are split into dedicated modules: `annotation.ts` (`BaseAnnotation`, `Annotation<E>`, `AnnotationStyle`, `AnnotationId`), `annotation-tool.ts` (`ToolType`), `geometry.ts` (geometry discriminated unions), `raw-annotation.ts` (generic `RawAnnotationData<TFormat, TData>`), `util.ts` (`createAnnotationId`, `toolTypeToGeometryType`), `id.ts`, `constants.ts`.
- **`@osdlabel/viewer-api`** (`packages/viewer-api/`) — Viewer state types and utilities. Contains: `ImageId` branded type, `createImageId`, `ImageIdFields` extension interface, `ImageSource`, `PixelSpacing`, `AnnotationState<E>`, `getAllAnnotationsFlat`, `CellTransform`, `DEFAULT_CELL_TRANSFORM`, `UIState`, `KeyboardShortcutMap`. Depends on `@osdlabel/annotation`.
- **`@osdlabel/geometry`** (`packages/geometry/`) — Pure geometry math and geometry-type conversions. Zero framework deps. Contains the geometry math utilities (`area`, `perimeter`, `length`, `radius`, `distance`, `centroid`, `midpoint`, `boundingBox` in `geometry-math.ts`) and conversions (`circleToBoundingRectangle` in `geometry-conversion.ts`). Depends only on `@osdlabel/annotation`. (`@osdlabel/decoration` re-exports the math, so the public `osdlabel` / `@osdlabel/decoration` surface is unchanged.)
- **`@osdlabel/annotation-context`** (`packages/annotation-context/`) — Annotation context, constraints, and scoping. Contains: `AnnotationContextId` branded type, `AnnotationContext`, `ToolConstraint`, `ConstraintStatus`, `ContextState`, `ContextFields` extension interface, context scoping functions (`isContextScopedToImage`, `getCountableImageIds`). Depends on `@osdlabel/annotation` and `@osdlabel/viewer-api` (for `ImageId`).
- **`@osdlabel/decoration`** (`packages/decoration/`) — Declarative annotation decorations. Zero framework deps. Contains: `Decoration` discriminated union (`TextDecoration` — supports `zIndex`; `LineDecoration`), `DecorationProvider` contract + `composeProviders`, `DecorationContext` (annotations + pixelSpacing + mandatory `selectedAnnotationId`), `Measurement` + unit conversion (`toPhysicalLength`, `toPhysicalArea`, `formatMeasurement`), built-in providers (`createMeasurementProvider`, `createLabelProvider`, `createDistanceProvider`), and the `withSelectionEmphasis` opt-in style-elevation wrapper. **Geometry math now lives in `@osdlabel/geometry`** and is re-exported here for backward compatibility. Depends on `@osdlabel/annotation`, `@osdlabel/geometry`, and `@osdlabel/viewer-api` (for `PixelSpacing`).
- **`@osdlabel/validation`** (`packages/validation/`) — Valibot schema implementations (Standard Schema compatible). Contains: `GeometrySchema`, `PointSchema`, `ToolTypeSchema` (in `tool.ts`), `BaseAnnotationSchema`, `OsdFieldsSchema`, `OsdAnnotationSchema` (in `annotation.ts`), `FabricRawAnnotationDataSchema` (in `fabric-data.ts`). Depends on `@osdlabel/annotation` and `valibot`.
- **`@osdlabel/fabric-annotations`** (`packages/fabric-annotations/`) — Fabric.js annotation tools and utilities, SolidJS-agnostic. Contains: all annotation tools (`BaseTool`, `ShapeTool`, `RectangleTool`, etc.), `ToolOverlay` interface, `FabricRawAnnotationData` (extends `RawAnnotationData<'fabric'>`), `FabricFields` extension interface, Fabric object serialization utilities (`serializeFabricObject`, `deserializeFabricObject`, `createFabricObjectFromRawData`, `getGeometryFromFabricObject`, `getFabricOptions`), `initFabricModule`. Depends on `@osdlabel/annotation`, `@osdlabel/annotation-context`, `@osdlabel/viewer-api` (for `KeyboardShortcutMap`), and `fabric`.
- **`@osdlabel/fabric-osd`** (`packages/fabric-osd/`) — Fabric.js + OpenSeaDragon overlay bridge & decoration renderer, SolidJS-agnostic. Contains: `FabricOverlay` (canvas overlay + viewport transform; exposes `onSync` and `overlayElement` for companion layers; flip-aware `imageToScreen` / `screenToImage`), pure helpers `computeViewportTransform`, `imageToScreenFlipAware`, `screenToImageFlipAware`, and `DecorationLayer` (renders text decorations as DOM elements positioned via `imageToScreen` and connector-line decorations as non-interactive Fabric objects). Depends on `@osdlabel/annotation`, `@osdlabel/viewer-api` (for `CellTransform`), `@osdlabel/decoration`, `@osdlabel/fabric-annotations`, `fabric`, and `openseadragon`.
- **`osdlabel`** (`packages/osdlabel/`) — Framework-agnostic shared logic. Contains: `OsdAnnotation` composed type alias (`Annotation<ImageIdFields & ContextFields & FabricFields>`), `serialize`/`deserialize`/`SerializationError`/`DeserializeResult` (serialization lives here, not in annotation), pure action types and reducer functions (`applyAnnotationAction`, `applyUIAction`, `applyContextAction`), initial state factories, constraint computation (`computeConstraintStatus`), keyboard mapping (`mapKeyEventToActions`, `DEFAULT_KEYBOARD_SHORTCUTS`), annotation-context cycling (`getCycledContextId`, `getSelectableContexts`), tool factory (`createAnnotationTool`), and `enableLiveDecorationUpdates` (the rAF-throttled Fabric-drag listener that overlays live geometry on state-derived annotations and re-runs decoration providers). No framework dependencies.
- **`@osdlabel/solid`** (`packages/solid/`) — SolidJS annotator UI. Contains: reactive state stores (using `createStore` + `produce`), hooks (`useAnnotationTool`, `useKeyboard`, `useConstraints`), and components (`Annotator`, `ViewerCell`, `GridView`, `Toolbar`, etc.). Depends on `osdlabel` + `solid-js`.
- **`@osdlabel/react`** (`packages/react/`) — React annotator UI. Contains: Immer-based reducers applied by a small external store that the provider reads through `useSyncExternalStore` and hands down through React Context, hooks (`useAnnotationTool`, `useKeyboard`, `useConstraints`), and components (`Annotator`, `ViewerCell`, `GridView`, `Toolbar`, etc.). Depends on `osdlabel` + `react` + `immer`.

The `Annotation` type is generic: `type Annotation<E extends object = Record<never, never>> = BaseAnnotation & E`. Extension interfaces (`ImageIdFields`, `ContextFields`, `FabricFields`) add fields via intersection. The composed type `OsdAnnotation = Annotation<OsdFields>` (where `OsdFields = ImageIdFields & ContextFields & FabricFields`) is used throughout `osdlabel`.

`RawAnnotationData` is a generic interface: `RawAnnotationData<TFormat extends string, TData extends Record<string, unknown> = Record<string, unknown>>`. The Fabric-specific concrete type is `FabricRawAnnotationData extends RawAnnotationData<'fabric'>` (defined in `@osdlabel/fabric-annotations`). Never reference the old monomorphic form.

Key architectural rules:

- **`@osdlabel/annotation` has zero dependencies.** No imports from `solid-js`, `fabric`, `openseadragon`, or any other package. No serialization logic. Pure data model only.
- **`@osdlabel/viewer-api` only depends on `@osdlabel/annotation`.** No framework deps. Owns `AnnotationState` and `getAllAnnotationsFlat` — not annotation.
- **`@osdlabel/annotation-context` depends on `@osdlabel/annotation` and `@osdlabel/viewer-api`.** No framework deps. The `viewer-api` dependency is for `ImageId`, used in `AnnotationContext.imageIds`.
- **`@osdlabel/validation` depends only on `@osdlabel/annotation` and `valibot`.** No framework deps. All validation is Valibot-based. There are no manual type-guard validators anywhere — not in `@osdlabel/annotation`, not in `@osdlabel/annotation-context`, not in `osdlabel`.
- **`@osdlabel/fabric-annotations` is SolidJS-agnostic and OSD-agnostic.** No imports from `solid-js` or `openseadragon`. Tools depend on the `ToolOverlay` interface, not `FabricOverlay` directly.
- **`@osdlabel/fabric-osd` is SolidJS-agnostic.** No imports from `solid-js`. Pure overlay bridge between Fabric.js and OpenSeaDragon.
- **Serialization (`serialize`/`deserialize`) lives in `osdlabel`, not in `@osdlabel/annotation`.** The annotation package has no serialization concerns. `serialize` calls `getAllAnnotationsFlat`; `deserialize` validates with Valibot and groups by imageId inline.
- **`osdlabel` is framework-agnostic.** No imports from `solid-js`, `react`, or any UI framework. Pure business logic, types, serialization, and draft-mutating reducer functions that work with both SolidJS `produce()` and Immer `produce()`.
- **`@osdlabel/solid` has no React imports. `@osdlabel/react` has no SolidJS imports.** Each framework package wraps the pure reducers from `osdlabel` with its own state management primitives.
- **State mutations go through named action functions.** Never modify the store directly from components. Pure reducers live in `packages/osdlabel/src/actions.ts`; framework-specific action dispatchers live in `@osdlabel/solid` and `@osdlabel/react`.
- **One active cell at a time.** Only one grid cell can be in annotation mode at a time. All other cells display existing annotations in read-only mode.
- **Constraint enforcement is reactive.** In SolidJS, use `createMemo`; in React, use `useMemo`. Both derive whether each tool is enabled/disabled from the current annotation counts and the active context's limits. The toolbar reads this derived state. Do not imperatively enable/disable tools.
- **Decorations are derived, never serialized.** Text labels, computed measurements (area/perimeter/length/radius), and connector lines are produced by pure `DecorationProvider` functions over current annotation state + `PixelSpacing`. The result is fed to `DecorationLayer.setDecorations` in a reactive effect (SolidJS `createEffect` / React `useEffect`). Providers must produce stable `Decoration.id` values so the renderer can diff in place. Do not embed computed measurements in `serialize()` output — recompute them at render time.
- **Hybrid decoration rendering: DOM text + Fabric lines.** Text decorations render as absolutely-positioned `<div>` elements inside a host layer that `DecorationLayer` appends to `FabricOverlay.overlayElement`; positions are recomputed on the `FabricOverlay.onSync` callback and use `transform: translate3d(...)` (with `will-change: transform`) for GPU compositing. Connector / measurement lines render as non-interactive Fabric `Line` objects on the overlay's canvas (carrying `_readOnly: true` and no `id`) — they follow pan/zoom/rotate/flip via the existing `viewportTransform` at zero per-frame cost.
- **`DecorationContext.selectedAnnotationId` is mandatory and is `AnnotationId | null`.** Providers always receive a definite value (one branch, not two). The framework integrations (`ViewerCell`) source it from `UIState.selectedAnnotationId`; the live-update helper accepts an optional `getSelectedAnnotationId?` callback and normalizes `undefined` to `null` at the boundary. Compose selection emphasis declaratively via `withSelectionEmphasis(provider, { selectedTextStyle, selectedLineStyle })` — opt-in z-index / style elevation for decorations whose `relatedAnnotationIds` include the selected id. This is the chosen path for "make the selected annotation's labels readable on top" instead of expensive layout-forcing collision avoidance.
- **Live decoration updates during Fabric drag.** State updates only fire on `object:modified`; for smooth label-follows-shape behavior during `object:moving` / `object:scaling` / `object:rotating`, use `enableLiveDecorationUpdates` from `osdlabel`. It overlays the live Fabric geometry (via `getGeometryFromFabricObject`) on top of state-derived annotations, re-runs providers, and emits to `DecorationLayer.setDecorations`. **Throttle to one recompute per `requestAnimationFrame`** to bound cost at 60fps regardless of how often Fabric fires; **fast-exit at the event handler when `getProviders().length === 0`** so the rAF queue stays empty when no decorations are configured. `object:modified` is intentionally NOT handled by the live-update helper — the framework's reactive effect already re-runs providers from committed state.
- **Identity-preserving transforms over annotation/decoration lists.** Reactive layers downstream (memos, the `DecorationLayer` diff) compare by reference, so transforms that only modify a subset of items must keep unchanged items' identity. Use the `findIndex` + `[...arr]` + index-mutate pattern, allocating the spine copy lazily on the first actual change: `applyLiveOverride` (overrides one annotation's geometry) and `withSelectionEmphasis` (elevates decorations related to the selected annotation) both follow it. Returning a fully reallocated `.map(...)` array forces every downstream memo to bust on every drag frame.
- **`turbo.json` sets `"agentGuidance": false`.** With turbo 2.11.5+, any turbo command run by a detected AI agent otherwise writes a managed block into `AGENTS.md`, leaving an uncommitted, Prettier-failing change behind. `AGENTS.md` stays a pointer to this file. Turbo before 2.11.5 rejects the key as unknown, so a checkout that pulls this without re-running `pnpm install` fails every turbo task until it does.
- **All packages use lockstep versioning.** Run `pnpm run check-versions` to validate. CI enforces this.
- **Lint rules are chosen, not inherited wholesale** (`eslint.config.js` at the root, flat config). Formatting is Prettier's — no stylistic rules here. `no-undef` is off for TS: it has no view of the DOM lib and produced 459 false positives (`PointerEvent`, `document`, `HTMLElement`), and `tsc` is the authority on undefined names. `no-unused-vars`' `varsIgnorePattern` exempts `Brand$` for the branded-id idiom, whose `declare const` is used only in a type position. `no-unassigned-vars` is off for the whole Solid block (`packages/solid`, `apps/dev`, `apps/docs`) because Solid's `ref={el}` binding assigns through the JSX transform, invisibly to ESLint; forcing it on across all three yields exactly one finding, and it is the legitimate idiom. React gets `exhaustive-deps` + `rules-of-hooks` only — v7's compiler-era rules (`refs`, `immutability`) contradict the ref patterns prescribed above. `solid/reactivity` is a warning, not an error: it catches a real mistake class but is noisy, and CI does not fail on warnings.
- **A package-scoped turbo task override REPLACES the base task definition — it does not merge.** `"@osdlabel/docs#build"` must restate `dependsOn`, `outputs` and every base input, not just its additions; omitting them yields `outputs: []` and `dependsOn: []`. Verified on turbo 2.9.16, and again on 2.11.7, with `turbo build --dry=json`; assert your edit actually applied before trusting the result. On 2.11 `turbo run` no longer uses the daemon and `--no-daemon` only prints a deprecation warning; on older turbo the daemon cached `turbo.json`, which is why earlier notes pass it.

### Testing

- Run `pnpm test` (Vitest) after implementing any core logic. Tests run across all packages.
- Run `pnpm test:e2e` (Playwright) after implementing any UI interaction. For parallel worktree runs, set `PORT` to avoid port conflicts (default: 5173), e.g. `PORT=5180 pnpm test:e2e`. The React suite listens one above `PORT` (default 5174; `REACT_PORT` overrides), so the two suites never share a port, and a second worktree needs a `PORT` at least 2 away from the first. `pnpm test:e2e` runs the two suites at once. CI instead runs them as two steps, Solid then React, because two Playwright suites at once on a 4-core runner is a load-flake risk; the React step runs even if the Solid one fails. If you see load flakes locally, run one suite at a time with `pnpm exec turbo run test:e2e --filter=@osdlabel/dev` (or `@osdlabel/dev-react`). Turbo runs tasks in strict env mode, so `PORT` and `REACT_PORT` reach the suites only because `test:e2e` lists them in `passThroughEnv`; a new variable a task reads needs the same.
- **The E2E suite must run with no network access.** Every fixture it needs is committed under `apps/dev/sample-data/`; `offline.spec.ts` enforces it. Note that E2E exercises each package's built `dist/`, not `src/` — `apps/dev`'s Vite alias only redirects `osdlabel`, so a local mutation check against any other package must rebuild first (`apps/dev-react` has no alias at all, so for the React suite rebuild `osdlabel` too) (CI is unaffected: `test:e2e` has `dependsOn: ["^build"]`).
- **E2E specs run against both bindings.** See "Binding parity" below.
- Write tests for the module you just built before moving to the next task.
- **For canvas E2E tests:** Use Playwright's `page.mouse.move()`, `page.mouse.down()`, `page.mouse.up()` for precise drawing simulation. Use `page.screenshot()` with `expect(screenshot).toMatchSnapshot()` for visual regression.
- **Test trees ARE type-checked, under the same strict flags as `src`.** Each of the 12 `packages/*` has a `tsconfig.tests.json` (`extends ./tsconfig.json`, `include: ["src/**/*", "tests/**/*"]`, `noEmit`, and `rootDir: "."` — the `rootDir` override is mandatory, since `--noEmit` does _not_ suppress TS6059) and its `typecheck` script is `tsc -p tsconfig.tests.json`. `tsconfig.json` / `tsconfig.build.json` stay tests-free so TypeDoc and the publish build are unaffected. `apps/dev` needs no such file — its `tsconfig.json` already includes `tests/**/*`, so the Playwright specs are type-checked by its plain `tsc --noEmit`. `turbo.json`'s `typecheck.inputs` includes `tests/**`; without it Turbo replays a cached green for test-only edits, and the same applies to `test` (`vitest.config.*`) and `build` (`vite.config.*`, `astro.config.*`, `*.html` — each dev app has extra pages: `annotator.html`, `grid-controls.html` and `viewer-cell.html` — `scripts/**`, `public/**`) — when adding a task input, hash every file the task actually reads.
- **`@ts-expect-error` is a real assertion now.** If one becomes unnecessary, `tsc` reports `TS2578 Unused '@ts-expect-error' directive` — investigate it, never suppress it. Keep passing branded ids through the convention `const annId = (s: string): AnnotationId => s as AnnotationId;` (see `packages/decoration/tests/unit/test-helpers.ts`).
- **`Annotation`'s default extension is `Record<never, never>`, never `Record<string, never>`.** The latter is an index signature mapping every key to `never`, so bare `Annotation` could be read but not built from a literal, and `Omit<Annotation, …>` collapsed to `{ [k: string]: never }` (#165; pinned by `packages/annotation/tests/unit/annotation.test.ts`). Use `Record<never, never>` for every new `E extends object = …` default. Fixtures now build bare `Annotation` directly. `E` is still not reliably inferrable (it only ever appears inside an intersection or in return position), so pass it explicitly whenever a callback reads extension fields: `createDistanceProvider<MyFields>(…)`.
- **Route `DecorationContext` construction through a helper.** `packages/decoration/tests/unit/test-helpers.ts` exports `ann()` and `ctx()`; using them means a new required field on `DecorationContext` breaks one call site instead of every test.
- **Under `noUncheckedIndexedAccess`, satisfy the compiler with `!`, never with `?.`.** `decorations[0]!`, `mock.calls[0]![0]` — `!` erases, so the emitted JS is unchanged. An optional chain does not erase, and against a negative matcher it makes the assertion pass in the very world it exists to rule out: `expect(bucket?.[id]).toBeUndefined()` also passes when `bucket` itself wrongly vanished. (`?.` against a _concrete_ expected value is harmless, since `undefined` still fails the comparison.)
- **Where the value's absence is the regression you care about, assert it separately first.** `expect(x).toBeDefined()` does not narrow — you still need `x!` after it — but it turns a `TypeError` thrown from the middle of the test body into a named assertion failure. An existing `expect(fn).toHaveBeenCalled()` before a `fn.mock.calls[0]![0]` serves the same purpose. This is worth doing at the point a test first reaches into a structure; it is not worth repeating on every subsequent dereference of the same value.
- **Node's test env (no `jsdom`) lacks `requestAnimationFrame`.** When unit-testing helpers that schedule via rAF (e.g. `enableLiveDecorationUpdates`), assign onto `globalThis` directly in `beforeEach` instead of `vi.spyOn(globalThis, 'requestAnimationFrame')` (which throws if the property is undefined): `(globalThis as unknown as { requestAnimationFrame: ... }).requestAnimationFrame = (cb) => { queue.push(cb); return queue.length; };`. Flush manually by iterating the queue.
- **Per-frame DOM-write idempotence in the rendering loop.** `DecorationLayer`'s `applyTextStyle` guards `textContent` / `className` / `style.zIndex` writes with `!=` checks before assigning, because same-value writes can still invalidate text layout / style-recompute in some engines. New per-frame DOM writes added to the layer should follow the same `if (el.foo !== nextFoo) el.foo = nextFoo;` pattern.

#### Binding parity (Solid ↔ React)

`@osdlabel/solid` and `@osdlabel/react` are parallel hand-maintained implementations of the same behaviour, and they have diverged before in ways only review caught (#152). Tests are what keep them honest, so **every behaviour tested in one binding is tested in the other.**

- **A change to one binding lands with the matching change to the other**, in the same PR, with tests that run against both. If a change genuinely applies to one binding only, say so in the PR and in a comment where the asymmetry lives.
- **Unit tests mirror each other file for file.** `packages/react/tests/unit` follows `packages/solid/tests/unit`'s layout (`state/`, `hooks/`, `constraints/`, `components/`), and a test added on one side gets its counterpart on the other. Port intent, not text. Where the bindings differ mechanically, test the difference. React reads state through store getters, derives constraint status with a memoised selector, and wires everything through effect dependency lists, so its suite asserts things Solid's needn't, such as a long-lived handler seeing refreshed refs. The deliberate exceptions are the timing test in Solid's `benchmark.test.ts` (it times the shared reducer, so React's `benchmark.test.ts` keeps only the `changeCounter` tests), `viewer-cell-live-decorations.test.tsx` (React only, since it tests the ref mirroring), and `state/annotator-store.test.ts` (React only: Solid has no store layer between its actions and its state). Solid's `hooks/useAnnotationTool.config.test.ts` holds what React's `useAnnotationTool.test.tsx` covers for the provider config: an equal value does not rebuild the tool, and a changed one does. It needs the real provider, and Solid's main hook test mocks the provider module. A Solid test that calls a hook from a provider's `children` getter must wrap the call in `untrack`, as a component body is. Solid evaluates `children` in a tracking scope, so otherwise a stale read re-mounts the subtree and passes for the wrong reason. A behaviour one binding cannot yet match is an `it.todo` naming its issue, as #217 was.
- **Every E2E spec runs against both dev apps.** Specs live only in `apps/dev/tests/e2e`. `apps/dev-react` has none of its own: its `playwright.config.ts` points `testDir` there and runs all of them against the React dev server. A spec that cannot apply to React goes in that config's `testIgnore`, with the reason beside it; today there is none. Write new specs against both from the start, and run both suites before pushing.
- **The two dev apps are kept equivalent.** That means the same pages (`index.html`, `annotator.html`, `grid-controls.html`, `viewer-cell.html`), the same images, contexts and decoration providers, the same test ids, and the same `window` hooks (`__osdTest`, `__popoverPlacement`, `__viewerCell`, the hidden `annotations-json` readout). Adding any of these to one app means adding it to the other. Neither app calls `initFabricModule()`, because `auto-init-fabric.spec.ts` asserts the library registers it unaided. A `window` hook must exist as soon as `page.goto` resolves in both apps. Solid's first render is synchronous, but React's commits asynchronously, possibly after the load event, so the React app installs its hooks at module load, not in an effect, and mirrors state into them. Code both apps need goes in a framework-neutral module under `apps/dev/src` that the React page imports, as `viewer-cell-harness.ts` does; `apps/dev-react/turbo.json` then adds that file to its `build` and `typecheck` inputs with `$TURBO_EXTENDS$`. A new cross-app import needs the same.
- **Specs import `test` and `expect` from `./helpers/fixtures.js`, never from `@playwright/test`.** Lint enforces it. Type imports such as `Page` still come from `@playwright/test`. The fixture's `test` checks, after every test, that every page in the test's browser context declares on `<html data-framework>` the binding its config names in `metadata.framework`. It fails if the config sets none, so a run cannot pass by testing the other app (a server left running on that port, say). A page that does not answer within 5s fails the check, so a crash cannot hang teardown. Every dev-app HTML page must carry `data-framework`.
- **Harness writes commit one at a time in both.** A Solid store write runs effects synchronously; the React `viewer-cell.html` page wraps each harness write in `flushSync` to match. A new React test hook that drives state needs the same, or a spec can pass on React by batching what Solid applies one write at a time.
- **Mutation-check React through its own build.** E2E runs each package's `dist/`, and `apps/dev-react` has no Vite alias, so rebuild `@osdlabel/react` (and `osdlabel` if you touched it) before trusting a React run. Unit tests import `packages/react/src` directly, so they need no rebuild of `@osdlabel/react`, though the packages it depends on must be built.

React unit-test mechanics:

- **Rendering** goes through `react-dom/client`'s `createRoot` and React's `act` (`tests/unit/mount.ts`), with no `@testing-library`. `tests/setup.ts` sets `globalThis.IS_REACT_ACT_ENVIRONMENT = true`, without which `act` warns. `jsdom` is an explicit devDependency through the catalog: Solid reaches it only because `fabric` lists it as optional and pnpm hoists it. `.tsx` tests need no Vite plugin; the tsconfig's `jsx: react-jsx` is enough.
- **Prefer the real provider** (`renderAnnotator` in `tests/unit/render-annotator.tsx`) to a mocked context, because the wiring is what differs from Solid. Dependent actions can share one `h.run()`, which is one batch: the action getters read the store, so each sees the writes before it (#217). Inside a run, `h.current` is still the last commit, while `h.current.store.getSnapshot()` is the latest write.
- **A mocked context** (`tests/unit/hooks/mock-annotator.ts`, typed as `ReturnType<typeof useAnnotator>`) re-renders nothing, so re-render the component under test yourself after changing it. React's context carries values, not accessors: `constraintStatus` and `activeImageId` are plain values.
- **To test an effect's dependency list,** re-render with an equal-valued but new object and assert nothing was rebuilt or re-subscribed, then re-render with a changed value and assert it was. Count `on(...)` registrations, not live listeners: a re-subscription that cleans up after itself leaves the live count unchanged.
- **To test a ref read by a long-lived handler** (e.g. `enableLiveDecorationUpdates`), change the input and reset what the probe recorded. Then run one drag frame through a hand-flushed rAF queue (`vi.stubGlobal('requestAnimationFrame', …)`), so the state-driven effect's own provider call cannot mask a stale ref.

#### Performance benchmarks

- **The `DecorationLayer` hot path has a real-browser harness at `apps/bench/` (`@osdlabel/bench`).** It drives an OSD viewer + `FabricOverlay` + `DecorationLayer` in headless Chromium and times `_reposition` / `setDecorations` per call across a scenario × phase matrix. jsdom cannot see CSSOM reserialization or forced layout, which is why it exists.
- **Compare a branch against a baseline with `pnpm bench:compare -- --base origin/main`.** It builds the base ref in a throwaway `git worktree`, runs both builds interleaved, and writes `summary.md` / `comparison.json` / `verdicts.json`; `--fail-on-regression` exits 1 on any (scenario, phase, metric) outside the noise band, where the metrics are `_reposition` in every phase and `setDecorations` in the live phase.
- **The gate is paired and calibrated (#198).** Each cell is judged on the per-rep `log(head / base)`, order-balanced (the runner flips which build goes first every rep and reopens every page each rep), against k=3 standard errors of its SD, floored at ±5%. Use R=7: at R=5 identical code still flagged something in roughly one run in ten. A change to the estimator, `GATE_K` or the runner's ordering needs re-calibrating with `pnpm --filter @osdlabel/bench bench:calibrate` on an A/A run and an injected-slowdown run, as `apps/bench/README.md` ("Noise and the gate") describes.
- **It measures each checkout's built `dist/`, not `src/`** — the turbo `bench` / `bench:compare` tasks depend on `^build`, so run them through the root scripts rather than invoking the package's scripts directly.
- **Results are gitignored** (`apps/bench/results/`, `apps/bench/.worktrees/`) — never commit a run. See `apps/bench/README.md` for every flag and for how to add a scenario, a phase, or a different hot path.

### File Conventions

- One exported entity per file where practical. Exceptions: closely related types can share a file.
- File names use kebab-case: `rectangle-tool.ts`, `annotation-store.ts`.
- Test files mirror source structure: `packages/annotation/src/types.ts` → `packages/annotation/tests/unit/types.test.ts`.
- All imports use explicit file extensions: `import { Foo } from './foo.js'` (required for ESM).
- Cross-package imports use the package name: `import type { Annotation } from '@osdlabel/annotation'`.

### Monorepo Structure

This is a pnpm workspace monorepo with Turborepo for task orchestration:

- `packages/annotation/` — `@osdlabel/annotation` (annotation data model)
- `packages/viewer-api/` — `@osdlabel/viewer-api` (viewer state types; also owns `PixelSpacing`)
- `packages/geometry/` — `@osdlabel/geometry` (pure geometry math + conversions)
- `packages/annotation-context/` — `@osdlabel/annotation-context` (context, constraints, scoping)
- `packages/decoration/` — `@osdlabel/decoration` (declarative decorations, built-in providers; re-exports geometry math)
- `packages/validation/` — `@osdlabel/validation` (Valibot schemas, Standard Schema compatible)
- `packages/fabric-annotations/` — `@osdlabel/fabric-annotations` (Fabric.js annotation tools & utilities)
- `packages/fabric-osd/` — `@osdlabel/fabric-osd` (Fabric.js + OSD overlay bridge; also owns `DecorationLayer`)
- `packages/osdlabel/` — `osdlabel` (framework-agnostic shared logic)
- `packages/solid/` — `@osdlabel/solid` (SolidJS annotator UI)
- `packages/react/` — `@osdlabel/react` (React annotator UI)
- `apps/dev/` — the SolidJS development app (`@osdlabel/dev`); source in `src/`, E2E tests in `tests/e2e/`
- `apps/dev-react/` — the React development app (`@osdlabel/dev-react`); source in `src/`
- `apps/docs/` — the documentation site (`@osdlabel/docs`); Astro + Starlight, deployed to GitHub Pages

### Library Entrypoints & Granularity

The library is split across multiple npm packages:

1. **`@osdlabel/annotation`** — Pure data model. `import { type Annotation, type BaseAnnotation, type RawAnnotationData, createAnnotationId } from '@osdlabel/annotation'`
2. **`@osdlabel/viewer-api`** — Viewer state types and utilities. `import { type ImageId, type ImageIdFields, type ImageSource, type AnnotationState, type UIState, type CellTransform, type KeyboardShortcutMap, createImageId, DEFAULT_CELL_TRANSFORM, getAllAnnotationsFlat } from '@osdlabel/viewer-api'`
3. **`@osdlabel/annotation-context`** — Context & constraints. `import { type AnnotationContext, isContextScopedToImage, getCountableImageIds } from '@osdlabel/annotation-context'`
4. **`@osdlabel/decoration`** — Declarative annotation decorations (text labels, computed measurements, connector lines) and built-in providers. Zero framework deps. Re-exports the geometry math from `@osdlabel/geometry` (`area`, `perimeter`, … plus `circleToBoundingRectangle`) for backward compatibility. `import { createMeasurementProvider, createLabelProvider, type DecorationProvider, area, perimeter } from '@osdlabel/decoration'`
5. **`@osdlabel/validation`** — Validation schemas. `import { BaseAnnotationSchema, OsdAnnotationSchema, OsdFieldsSchema, GeometrySchema, ToolTypeSchema, FabricRawAnnotationDataSchema } from '@osdlabel/validation'`
6. **`@osdlabel/fabric-annotations`** — Fabric annotation tools & utilities. `import { initFabricModule, RectangleTool, type ToolOverlay, type FabricFields, type FabricRawAnnotationData } from '@osdlabel/fabric-annotations'`
7. **`@osdlabel/fabric-osd`** — OSD overlay bridge & decoration renderer. `import { FabricOverlay, computeViewportTransform, DecorationLayer } from '@osdlabel/fabric-osd'`
8. **`osdlabel`** — Framework-agnostic shared logic. Types, serialization, pure reducers, constraints, keyboard mapping, tool factory. Also re-exports the decoration API.
   - Main barrel: `import { serialize, deserialize, type OsdAnnotation, applyAnnotationAction, computeConstraintStatus, createMeasurementProvider, type DecorationProvider } from 'osdlabel'`
9. **`@osdlabel/solid`** — SolidJS UI. Re-exports everything from `osdlabel` plus SolidJS-specific state/hooks/components.
   - Main barrel: `import { Annotator, useAnnotator, Toolbar } from '@osdlabel/solid'`
   - Sub-path barrels: `@osdlabel/solid/components`, `@osdlabel/solid/state`, `@osdlabel/solid/hooks`
10. **`@osdlabel/react`** — React UI. Re-exports everything from `osdlabel` plus React-specific state/hooks/components.
    - Main barrel: `import { Annotator, useAnnotator, Toolbar } from '@osdlabel/react'`
    - Sub-path barrels: `@osdlabel/react/components`, `@osdlabel/react/state`, `@osdlabel/react/hooks`

The `@osdlabel/solid` package is built using **Vite in library mode** with `vite-plugin-solid`. The `osdlabel`, `@osdlabel/react`, and all other packages are built with plain `tsc`.

### Build Commands

Run from the workspace root — Turbo fans out to the correct packages:

```bash
pnpm dev            # Start Vite dev server (apps/dev) with HMR into library source
pnpm build          # Build all packages (annotation → viewer-api → geometry → annotation-context, decoration → validation → fabric-annotations → fabric-osd → osdlabel)
pnpm typecheck      # Type-check all packages (src AND test trees)
pnpm test           # Run Vitest unit tests across all packages
pnpm test:e2e       # Run Playwright E2E tests: every spec in apps/dev/tests/e2e, against the Solid app, then the React app
pnpm lint           # Run ESLint across all packages (CI runs this)
pnpm format         # Run Prettier across the workspace
pnpm check-versions # Validate lockstep package versions
pnpm docs:dev       # Start docs dev server (apps/docs)
pnpm docs:build     # Build docs site (generates LLM page first, then Astro build)
```

Per-package commands (run from within the package directory):

```bash
# packages/annotation/
pnpm build        # tsc -p tsconfig.build.json
pnpm typecheck    # tsc -p tsconfig.tests.json (src + tests)
pnpm test         # vitest run

# packages/viewer-api/
pnpm build        # tsc -p tsconfig.build.json
pnpm typecheck    # tsc -p tsconfig.tests.json (src + tests)
pnpm test         # vitest run

# packages/annotation-context/
pnpm build        # tsc -p tsconfig.build.json
pnpm typecheck    # tsc -p tsconfig.tests.json (src + tests)
pnpm test         # vitest run

# packages/geometry/
pnpm build        # tsc -p tsconfig.build.json
pnpm typecheck    # tsc -p tsconfig.tests.json (src + tests)
pnpm test         # vitest run

# packages/decoration/
pnpm build        # tsc -p tsconfig.build.json
pnpm typecheck    # tsc -p tsconfig.tests.json (src + tests)
pnpm test         # vitest run

# packages/validation/
pnpm build        # tsc -p tsconfig.build.json
pnpm typecheck    # tsc -p tsconfig.tests.json (src + tests)
pnpm test         # vitest run

# packages/fabric-annotations/
pnpm build        # tsc -p tsconfig.build.json
pnpm typecheck    # tsc -p tsconfig.tests.json (src + tests)
pnpm test         # vitest run

# packages/fabric-osd/
pnpm build        # tsc -p tsconfig.build.json
pnpm typecheck    # tsc -p tsconfig.tests.json (src + tests)
pnpm test         # vitest run

# packages/osd-helper/
pnpm build        # tsc -p tsconfig.build.json
pnpm typecheck    # tsc -p tsconfig.tests.json (src + tests)
pnpm test         # vitest run

# packages/osdlabel/
pnpm build        # tsc -p tsconfig.build.json
pnpm typecheck    # tsc -p tsconfig.tests.json (src + tests)
pnpm test         # vitest run

# packages/solid/
pnpm build        # vite build + tsc --emitDeclarationOnly
pnpm typecheck    # tsc -p tsconfig.tests.json (src + tests)
pnpm test         # vitest run
pnpm test:watch   # vitest (watch mode)

# packages/react/
pnpm build        # tsc -p tsconfig.build.json
pnpm typecheck    # tsc -p tsconfig.tests.json (src + tests)
pnpm test         # vitest run

# apps/dev/
pnpm dev          # vite (SolidJS, port 5173)
pnpm test:e2e     # playwright test

# apps/dev-react/
pnpm dev          # vite (React, port 5174)
pnpm test:e2e     # playwright test (every spec in apps/dev/tests/e2e, against React)

# apps/docs/
pnpm dev          # astro dev
pnpm build        # generates LLM page + astro build
```

### Documentation Site (Astro/Starlight)

- **Content collections use Starlight's loaders in `src/content.config.ts`.** `docs` uses `docsLoader()`. Since Astro 7 / Starlight 0.42 (#234), no `legacy: { collections: true }` flag is needed; it was added for a build-time resolution problem the content layer no longer has. Starlight also reads an `i18n` collection (overrides of its UI strings) on every build, and Astro warns about a missing or empty collection, so `src/content/i18n/en.json` holds an empty object: no overrides, but the collection exists. Do not delete it to tidy up. The 404 page is `src/pages/404.astro` (a `StarlightPage` splash, matching Starlight's default) with `disable404Route: true`: Starlight's own route probes the docs collection for a `404` entry, which logs "Entry docs → 404 was not found" on every build, and a `404.md` entry instead collides with the docs catch-all route.
- **Astro 7 detaches `astro dev` and `astro preview` when it detects an AI agent.** The command returns at once and the server keeps running in the background, so a later start on another port can silently reuse the old server, with the old `--outDir`. Check with `pnpm --filter @osdlabel/docs exec astro preview status` (or `dev status`), and stop with `… preview stop` / `dev stop` before starting another; `astro dev logs` shows the output. To run in the foreground, set `ASTRO_DEV_BACKGROUND` (for `dev`) or `ASTRO_PREVIEW_BACKGROUND` (for `preview`) to any non-empty value; the server still writes its lock file, so `status` / `stop` track it and a second start on the same project is refused. `--ignore-lock` runs it in the foreground untracked. Agent detection also switches both commands' output to JSON lines.
- **Branded ID types in docs examples:** Use `createAnnotationContextId()` factory functions instead of `as AnnotationContextId` casts — keeps examples consistent with the library's public API.
- **Adding new docs pages:** Create `.md` in `apps/docs/src/content/docs/` and add a sidebar entry in `apps/docs/astro.config.mjs`. Use `.md` for reference/prose, `.mdx` for guides needing interactive components.
- **The API reference's TypeDoc options live in `apps/docs/typedoc.config.mjs`,** shared by the starlight-typedoc plugin and `pnpm --filter @osdlabel/docs check:typedoc`. That check runs first in the docs build with `--treatWarningsAsErrors`, because the plugin never runs TypeDoc's link validation and shows only some of its warnings: broken `{@link}`s otherwise ship as plain text. Like the build, it needs the packages built first (their types resolve through `exports` to `dist/`), so run it after `pnpm build`. It also fails on TypeDoc's own warnings, such as an unsupported TypeScript version after a `typescript` bump; that means updating `typedoc`, not loosening the check. The shared file holds core TypeDoc options only (the check does not load typedoc-plugin-markdown), and per-package options such as `excludeInternal` go under `packageOptions`, since `packages` mode does not pass root options down. Link across packages with a declaration reference and a label, `{@link @osdlabel/annotation!Point | Point}`; TypeDoc cannot resolve `import("…")` links, and a mid-sentence `@see` ends the sentence there. A non-exported type that a public signature uses gets `@inline` (as `AnnotatorContextValue` and `DomDecorationsCallback` do) so the reference documents its shape without adding an export; a symbol only its type matters for (the ID brands, `LooseData`) goes in `intentionallyNotExported` in its own package's `typedoc.json`, since `packages` mode checks each package with its own options. A new package needs a `typedoc.json` and an entry in `typedoc.config.mjs`'s `entryPoints`.
- **Each symbol has one API page, in the package that declares it.** `packages` mode converts each package on its own, so `osdlabel` (which re-exports most lower packages), `@osdlabel/decoration` (the geometry math) and `@osdlabel/solid` / `@osdlabel/react` (all of `osdlabel`) each used to get a full copy of every re-export: 549 of 875 pages, each a duplicate search result whose "Defined in" pointed at a `dist/*.d.ts`. `apps/docs/scripts/typedoc-plugin-reexports.mjs` skips a module-level export another workspace package declares, and adds it to the re-exporting module as a reference to the declaring package's reflection. Type references and `{@link}`s by short name still resolve, to the declaring package's page. The reference is in none of the module's groups, and must stay out of them: the sidebar is built from groups, and Starlight highlights the first sidebar entry that links to the current page, so a grouped reference in an earlier package claims the declaring package's pages (102 of 300 did). It wraps `Context#shouldIgnore`, because TypeDoc's `excludeExternals` skips a symbol everywhere: an interface that extends one from another package (`FabricRawAnnotationData`) would lose its inherited members. If a TypeDoc upgrade stops that wrapper from applying, the plugin's own check warns about every copy, and `check:typedoc` fails. A hand-written link into the reference must target the declaring package's page (`/osdlabel/api/reference/osdlabel/geometry/functions/distance/`, not `…/osdlabel/functions/distance/`). Page slugs are lowercase.
- **GFM tables must render on `.md` and `.mdx` pages alike.** Under Astro 6, `@astrojs/mdx` v5 fell back to an undefined `markdown.gfm`, so every `.mdx` page rendered tables as literal pipe text until `astro.config.mjs` set `mdx({ optimize: true, gfm: true })` (#180/#181). Astro 7's default markdown processor (Sätteri) and `@astrojs/mdx` v8 render GFM on both, so that override was removed in #234 and Starlight adds its own `mdx()` again. `scripts/check-rendered-tables.js` runs after `astro build` and fails the build if any page ships an unrendered table (a GFM delimiter row in prose, outside code); detection lives in `scripts/lib/find-unrendered-table-rows.js` and is unit-tested with `node --test` (`apps/docs/tests/`).
- **LLM page:** Generated at build time by `scripts/generate-llm-page.js`. Also produces `public/llms.txt` for the llms.txt convention. Do not hand-edit `llm.md` or `llms.txt` — they are overwritten on each docs build. Both are in `.prettierignore`: the generator's output is the committed state, so `pnpm format` must not touch them. When a PR changes a guide, commit the regenerated `llm.md` with it rather than reverting it as noise — that is how a stale page shipped during #180 (#181).
- **`deploy-docs.yml` runs and deploys must not cancel each other across refs.** The workflow's concurrency group is per ref (`${{ github.workflow }}-${{ github.ref }}`), cancelling only a PR's own older run, and the `deploy` job has its own `pages` group with `cancel-in-progress: false`. A single global group with cancellation let one PR's docs build cancel another's, and would have let a PR's build cancel a deploy from `main`, leaving the site stale (#231). `deploy` runs only for `refs/heads/main`. Its `paths` filter must cover everything the docs build reads — every package's `src`, `typedoc.json`, `package.json`, `tsconfig*.json` and `vite.config.*`, plus the workspace's build config — so a public-API change in any package redeploys. Keep it in step with the `build` inputs in `turbo.json`: `@osdlabel/docs#build`'s and, through `^build`, every package's. Keep the `push` and `pull_request` lists identical.

### Incremental Verification

After completing each task file, verify the acceptance criteria listed at the bottom of that task before proceeding to the next one. If a verification step fails, fix it before moving on — do not accumulate technical debt across tasks.

## Dependency Versions (pinned)

```
solid-js@^1.9.13
fabric@7.4.0
openseadragon@5.0.1
typescript@^5.9.3
vite@^8.0.16
vitest@^4.1.8
@playwright/test@^1.60.0
vite-plugin-solid@^2.11.12
pnpm@12.9.1   (packageManager; CI's pnpm/action-setup reads it)
turbo@^2.11.7
```

## Quick Reference: Coordinate Systems

```
Image-space (pixels):     (0,0) top-left of full-res image, measured in pixels
OSD Viewport-space:       (0,0) top-left, image width = 1.0, y is aspect-ratio-dependent
Screen-space (CSS px):    (0,0) top-left of browser viewport
Fabric canvas-space:      Same as screen-space, but transformed by viewportTransform
```

The overlay's job is to compute the Fabric `viewportTransform` matrix that maps
image-space → screen-space, so that Fabric objects stored in image-space render
at the correct screen position at the current OSD zoom/pan.
