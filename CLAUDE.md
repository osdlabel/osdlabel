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
- **Subscriptions that need fresh state without resubscribing use refs.** When a `useEffect` registers an event handler that fires across many React renders (e.g. `enableLiveDecorationUpdates`), the handler closure must observe the current reactive state. Mirror each reactive value into a ref on every render (`ref.current = value`) and have the handler read `ref.current`; the `useEffect` itself only depends on the subscription-establishing inputs (e.g. `overlay`), so resubscription stays rare.

### Fabric.js v7

- **Import from `'fabric'` directly.** v7 uses named exports: `import { Canvas, Rect, Circle } from 'fabric'`. There is no `fabric.` namespace.
- **Do NOT use `fabric.Canvas` in detached/offscreen mode.** The canvas must be attached to a visible DOM `<canvas>` element for event handling to work.
- **`viewportTransform` is a 6-element array** `[scaleX, skewY, skewX, scaleY, translateX, translateY]`. Use `canvas.setViewportTransform(matrix)` to update it. After setting it, call `canvas.requestRenderAll()`.
- **Fabric objects use image-space coordinates.** Store annotation geometry in image-space and use the overlay's `viewportTransform` to map to screen-space. Do not convert coordinates on each object — that's what the canvas transform does.
- **`canvas.getZoom()` assumes `viewportTransform[0]` is the zoom level**, which is only true for scale+translate matrices. With rotation, `vpt[0] = cos(θ)·scale` — zero at 90°, negative at 180°. This breaks object caching. Override with `Math.sqrt(vpt[0]² + vpt[1]²)`.
- **Set `skipOffscreen: false`** when the viewportTransform includes rotation. Fabric's offscreen culling doesn't account for rotation and incorrectly hides visible objects.
- **All Fabric API calls must go through the overlay interface** (`FabricOverlay`). Components should never import from `'fabric'` directly or access the Fabric canvas instance except through the overlay.
- **`obj.id` is reserved for annotation objects.** It's how `ViewerCell` discriminates annotation objects from companion-layer objects on the same canvas (the clear filter is `obj => obj.id`, registered via `initFabricModule`'s `FabricObject.customProperties`). Non-annotation Fabric objects (decoration lines, drawing previews, future overlay graphics) MUST NOT carry an `id`. Use `_readOnly: true` so `FabricOverlay.setMode` keeps them inert (`selectable: false, evented: false`) in both navigation and annotation modes; do not register `_readOnly` as a serialized custom property.
- **`ActiveSelection` (multi-drag) limitation.** When the user drags a multi-select, Fabric fires `object:moving` with `target` set to the `ActiveSelection` group (which has no `id`). The group's children's `left`/`top` are reported relative to the group, not the canvas — so `getGeometryFromFabricObject` is exact for matrix-based shapes (line, polyline, polygon, all of which use `calcTransformMatrix`) but approximate for `left`/`top`-based ones (rectangle, circle, point). Live updates accept this caveat; the commit on mouse-up via `object:modified` is always correct because Fabric dissolves the `ActiveSelection` before firing it. Detect group targets via duck-typed `getObjects()` rather than coupling to Fabric's `type`-string casing.

### OpenSeaDragon

- **OSD `viewportTransform` is NOT the same as Fabric's.** OSD uses its own coordinate system where image width maps to 0–1 in viewport coordinates. Use `viewer.viewport.viewportToImageCoordinates()` and `viewer.viewport.imageToViewerElementCoordinates()` for conversions.
- **Subscribe to `'animation'` event for smooth overlay sync**, not `'animation-finish'`. The `animation` event fires on every frame during pan/zoom animations.
- **Toggle mouse navigation** with `viewer.setMouseNavEnabled(boolean)`. Use this to switch between navigation mode (OSD handles input) and annotation mode (Fabric handles input).
- **Each OSD viewer must have a unique DOM container.** Never try to attach two OSD viewers to the same element.
- **`imageToViewerElementCoordinates` does NOT account for flip.** Flip is applied only in OSD's drawer rendering pipeline (`context.scale(-1,1)`). The Fabric viewportTransform must compose flip separately — see `computeViewportTransform`. **The `FabricOverlay.imageToScreen` / `screenToImage` methods (and the pure exported helpers `imageToScreenFlipAware` / `screenToImageFlipAware`) compose the same horizontal mirror around `x = W/2`.** Always use those for image↔screen conversions consumed as absolute positions (e.g. the `DecorationLayer`'s text positioning) — calling OSD's raw `imageToViewerElementCoordinates` directly will drift relative to painted Fabric objects whenever exactly one of `flippedH`/`flippedV` is active (when both flips are on, `applyViewTransform` collapses to `isFlipped = false` and there is no drift). Callers that only need screen-space _distances_ between two image points (e.g. polyline-tool's close-to-first-point check) are invariant under the mirror and can use either path.
- **`viewport.setRotation(degrees)` uses spring animation by default.** Pass `immediately=true` to snap; otherwise `sync()` computes a matrix for an intermediate rotation angle.
- **For dev/testing, use OSD's `type: 'image'` tile source** with local images. This avoids needing a DZI tile server during development. The library should also support DZI for production.

### Architecture

The project is split into eight packages with clear dependency boundaries:

- **`@osdlabel/annotation`** (`packages/annotation/`) — Pure annotation data model. Zero dependencies. Types are split into dedicated modules: `annotation.ts` (`BaseAnnotation`, `Annotation<E>`, `AnnotationStyle`, `AnnotationId`), `annotation-tool.ts` (`ToolType`), `geometry.ts` (geometry discriminated unions), `raw-annotation.ts` (generic `RawAnnotationData<TFormat, TData>`), `util.ts` (`createAnnotationId`, `toolTypeToGeometryType`), `id.ts`, `constants.ts`.
- **`@osdlabel/viewer-api`** (`packages/viewer-api/`) — Viewer state types and utilities. Contains: `ImageId` branded type, `createImageId`, `ImageIdFields` extension interface, `ImageSource`, `PixelSpacing`, `AnnotationState<E>`, `getAllAnnotationsFlat`, `CellTransform`, `DEFAULT_CELL_TRANSFORM`, `UIState`, `KeyboardShortcutMap`. Depends on `@osdlabel/annotation`.
- **`@osdlabel/annotation-context`** (`packages/annotation-context/`) — Annotation context, constraints, and scoping. Contains: `AnnotationContextId` branded type, `AnnotationContext`, `ToolConstraint`, `ConstraintStatus`, `ContextState`, `ContextFields` extension interface, context scoping functions (`isContextScopedToImage`, `getCountableImageIds`). Depends on `@osdlabel/annotation` and `@osdlabel/viewer-api` (for `ImageId`).
- **`@osdlabel/decoration`** (`packages/decoration/`) — Declarative annotation decorations and geometry math. Zero framework deps. Contains: `Decoration` discriminated union (`TextDecoration` — supports `zIndex`; `LineDecoration`), `DecorationProvider` contract + `composeProviders`, `DecorationContext` (annotations + pixelSpacing + mandatory `selectedAnnotationId`), geometry math utilities (`area`, `perimeter`, `length`, `radius`, `distance`, `centroid`, `midpoint`, `boundingBox`), `Measurement` + unit conversion (`toPhysicalLength`, `toPhysicalArea`, `formatMeasurement`), built-in providers (`createMeasurementProvider`, `createLabelProvider`, `createDistanceProvider`), and the `withSelectionEmphasis` opt-in style-elevation wrapper. Depends on `@osdlabel/annotation` and `@osdlabel/viewer-api` (for `PixelSpacing`).
- **`@osdlabel/validation`** (`packages/validation/`) — Valibot schema implementations (Standard Schema compatible). Contains: `GeometrySchema`, `PointSchema`, `ToolTypeSchema` (in `tool.ts`), `BaseAnnotationSchema`, `OsdFieldsSchema`, `OsdAnnotationSchema` (in `annotation.ts`), `FabricRawAnnotationDataSchema` (in `fabric-data.ts`). Depends on `@osdlabel/annotation` and `valibot`.
- **`@osdlabel/fabric-annotations`** (`packages/fabric-annotations/`) — Fabric.js annotation tools and utilities, SolidJS-agnostic. Contains: all annotation tools (`BaseTool`, `ShapeTool`, `RectangleTool`, etc.), `ToolOverlay` interface, `FabricRawAnnotationData` (extends `RawAnnotationData<'fabric'>`), `FabricFields` extension interface, Fabric object serialization utilities (`serializeFabricObject`, `deserializeFabricObject`, `createFabricObjectFromRawData`, `getGeometryFromFabricObject`, `getFabricOptions`), `initFabricModule`. Depends on `@osdlabel/annotation`, `@osdlabel/annotation-context`, `@osdlabel/viewer-api` (for `KeyboardShortcutMap`), and `fabric`.
- **`@osdlabel/fabric-osd`** (`packages/fabric-osd/`) — Fabric.js + OpenSeaDragon overlay bridge & decoration renderer, SolidJS-agnostic. Contains: `FabricOverlay` (canvas overlay + viewport transform; exposes `onSync` and `overlayElement` for companion layers; flip-aware `imageToScreen` / `screenToImage`), pure helpers `computeViewportTransform`, `imageToScreenFlipAware`, `screenToImageFlipAware`, and `DecorationLayer` (renders text decorations as DOM elements positioned via `imageToScreen` and connector-line decorations as non-interactive Fabric objects). Depends on `@osdlabel/annotation`, `@osdlabel/viewer-api` (for `CellTransform`), `@osdlabel/decoration`, `@osdlabel/fabric-annotations`, `@osdlabel/validation`, `fabric`, and `openseadragon`.
- **`osdlabel`** (`packages/osdlabel/`) — Framework-agnostic shared logic. Contains: `OsdAnnotation` composed type alias (`Annotation<ImageIdFields & ContextFields & FabricFields>`), `serialize`/`deserialize`/`SerializationError`/`DeserializeResult` (serialization lives here, not in annotation), pure action types and reducer functions (`applyAnnotationAction`, `applyUIAction`, `applyContextAction`), initial state factories, constraint computation (`computeConstraintStatus`), keyboard mapping (`mapKeyEventToActions`, `DEFAULT_KEYBOARD_SHORTCUTS`), tool factory (`createAnnotationTool`, `buildToolCallbacks`), and `enableLiveDecorationUpdates` (the rAF-throttled Fabric-drag listener that overlays live geometry on state-derived annotations and re-runs decoration providers). No framework dependencies.
- **`@osdlabel/solid`** (`packages/solid/`) — SolidJS annotator UI. Contains: reactive state stores (using `createStore` + `produce`), hooks (`useAnnotationTool`, `useKeyboard`, `useConstraints`), and components (`Annotator`, `ViewerCell`, `GridView`, `Toolbar`, etc.). Depends on `osdlabel` + `solid-js`.
- **`@osdlabel/react`** (`packages/react/`) — React annotator UI. Contains: Immer-based reducers, React Context + `useReducer` state management, hooks (`useAnnotationTool`, `useKeyboard`, `useConstraints`), and components (`Annotator`, `ViewerCell`, `GridView`, `Toolbar`, etc.). Depends on `osdlabel` + `react` + `immer`.

The `Annotation` type is generic: `type Annotation<E extends object = Record<string, never>> = BaseAnnotation & E`. Extension interfaces (`ImageIdFields`, `ContextFields`, `FabricFields`) add fields via intersection. The composed type `OsdAnnotation = Annotation<OsdFields>` (where `OsdFields = ImageIdFields & ContextFields & FabricFields`) is used throughout `osdlabel`.

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
- **All packages use lockstep versioning.** Run `pnpm run check-versions` to validate. CI enforces this.

### Testing

- Run `pnpm test` (Vitest) after implementing any core logic. Tests run across all packages.
- Run `pnpm test:e2e` (Playwright) after implementing any UI interaction. For parallel worktree runs, use `PORT=5174 pnpm test:e2e` to avoid port conflicts (default: 5173).
- Write tests for the module you just built before moving to the next task.
- **For canvas E2E tests:** Use Playwright's `page.mouse.move()`, `page.mouse.down()`, `page.mouse.up()` for precise drawing simulation. Use `page.screenshot()` with `expect(screenshot).toMatchSnapshot()` for visual regression.
- **Test files are excluded from `tsc --noEmit`** (each package's `tsconfig.json` excludes `tests/`), so Vitest's esbuild transpile is the only thing that touches them — strict-types violations in tests don't surface in CI. Treat the test files as if they WERE strict-checked: pass branded ids through the convention `const annId = (s: string): AnnotationId => s as AnnotationId;` (see `built-in-providers.test.ts`, `live-decoration-updates.test.ts`) rather than letting raw strings flow into `relatedAnnotationIds`, `id`, etc.
- **Node's test env (no `jsdom`) lacks `requestAnimationFrame`.** When unit-testing helpers that schedule via rAF (e.g. `enableLiveDecorationUpdates`), assign onto `globalThis` directly in `beforeEach` instead of `vi.spyOn(globalThis, 'requestAnimationFrame')` (which throws if the property is undefined): `(globalThis as unknown as { requestAnimationFrame: ... }).requestAnimationFrame = (cb) => { queue.push(cb); return queue.length; };`. Flush manually by iterating the queue.
- **Per-frame DOM-write idempotence in the rendering loop.** `DecorationLayer`'s `applyTextStyle` guards `textContent` / `className` / `style.zIndex` writes with `!=` checks before assigning, because same-value writes can still invalidate text layout / style-recompute in some engines. New per-frame DOM writes added to the layer should follow the same `if (el.foo !== nextFoo) el.foo = nextFoo;` pattern.

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
- `packages/annotation-context/` — `@osdlabel/annotation-context` (context, constraints, scoping)
- `packages/decoration/` — `@osdlabel/decoration` (declarative decorations, geometry math, built-in providers)
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
4. **`@osdlabel/decoration`** — Declarative annotation decorations (text labels, computed measurements, connector lines), geometry math, and built-in providers. Zero framework deps. `import { createMeasurementProvider, createLabelProvider, type DecorationProvider, area, perimeter } from '@osdlabel/decoration'`
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
pnpm build          # Build all packages (annotation → viewer-api → annotation-context, decoration → validation → fabric-annotations → fabric-osd → osdlabel)
pnpm typecheck      # Type-check all packages
pnpm test           # Run Vitest unit tests across all packages
pnpm test:e2e       # Run Playwright E2E tests in apps/dev/
pnpm lint           # Run ESLint across all packages
pnpm format         # Run Prettier across the workspace
pnpm check-versions # Validate lockstep package versions
pnpm docs:dev       # Start docs dev server (apps/docs)
pnpm docs:build     # Build docs site (generates LLM page first, then Astro build)
```

Per-package commands (run from within the package directory):

```bash
# packages/annotation/
pnpm build        # tsc -p tsconfig.build.json
pnpm typecheck    # tsc --noEmit
pnpm test         # vitest run

# packages/viewer-api/
pnpm build        # tsc -p tsconfig.build.json
pnpm typecheck    # tsc --noEmit
pnpm test         # vitest run

# packages/annotation-context/
pnpm build        # tsc -p tsconfig.build.json
pnpm typecheck    # tsc --noEmit
pnpm test         # vitest run

# packages/decoration/
pnpm build        # tsc -p tsconfig.build.json
pnpm typecheck    # tsc --noEmit
pnpm test         # vitest run

# packages/validation/
pnpm build        # tsc -p tsconfig.build.json
pnpm typecheck    # tsc --noEmit
pnpm test         # vitest run

# packages/fabric-annotations/
pnpm build        # tsc -p tsconfig.build.json
pnpm typecheck    # tsc --noEmit
pnpm test         # vitest run

# packages/fabric-osd/
pnpm build        # tsc -p tsconfig.build.json
pnpm typecheck    # tsc --noEmit
pnpm test         # vitest run

# packages/osdlabel/
pnpm build        # tsc -p tsconfig.build.json
pnpm typecheck    # tsc --noEmit
pnpm test         # vitest run

# packages/solid/
pnpm build        # vite build + tsc --emitDeclarationOnly
pnpm typecheck    # tsc --noEmit
pnpm test         # vitest run
pnpm test:watch   # vitest (watch mode)

# packages/react/
pnpm build        # tsc -p tsconfig.build.json
pnpm typecheck    # tsc --noEmit
pnpm test         # vitest run

# apps/dev/
pnpm dev          # vite (SolidJS, port 5173)
pnpm test:e2e     # playwright test

# apps/dev-react/
pnpm dev          # vite (React, port 5174)

# apps/docs/
pnpm dev          # astro dev
pnpm build        # generates LLM page + astro build
```

### Documentation Site (Astro/Starlight)

- **Use `legacy: { collections: true }` in `astro.config.mjs`.** The `docsLoader()` content layer API has issues with build-time content resolution in this monorepo setup. Legacy collections with `src/content/config.ts` (no loader, schema only) work reliably.
- **Branded ID types in docs examples:** Use `createAnnotationContextId()` factory functions instead of `as AnnotationContextId` casts — keeps examples consistent with the library's public API.
- **Adding new docs pages:** Create `.md` in `apps/docs/src/content/docs/` and add a sidebar entry in `apps/docs/astro.config.mjs`. Use `.md` for reference/prose, `.mdx` for guides needing interactive components.
- **LLM page:** Generated at build time by `scripts/generate-llm-page.js`. Also produces `public/llms.txt` for the llms.txt convention. Do not hand-edit `llm.md` or `llms.txt` — they are overwritten on each docs build.

### Incremental Verification

After completing each task file, verify the acceptance criteria listed at the bottom of that task before proceeding to the next one. If a verification step fails, fix it before moving on — do not accumulate technical debt across tasks.

## Dependency Versions (pinned)

```
solid-js@1.9.11
fabric@7.1.0
openseadragon@5.0.1
typescript@5.7.3
vite@6.1.0
vitest@3.0.5
@playwright/test@1.50.1
vite-plugin-solid@2.11.0
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
