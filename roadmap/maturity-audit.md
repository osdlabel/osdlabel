# Maturity and polish audit: osdlabel at e0eba8f

**Method.** Read-only. I worked by reading the code and running a few small Node probes: importing OSD and Fabric under Node, checking valibot's error message, checking V8's spread limit, computing WCAG contrast ratios, and scanning every package's exports for TSDoc with the TS compiler API. Nothing was built and `dist/` is absent, so bundle sizes come from the npm registry (0.21.0). The working tree was left clean. One probe file landed in `packages/validation` by mistake and was deleted straight away; `git status` is empty. I did not re-report the known roadmap items. Where something adds evidence to one, it is marked "new evidence". Related open issues: #229 (host-owned store), #46 (data model), #76 item 4 (sub-path exports).

---

## 1. Annotation workflow features

**Already good**

- Visibility per context (`displayedContextIds`).
- Contexts are effectively locked when not active: their objects are `_readOnly` and do not receive events (`solid/src/components/ViewerCell.tsx:169-176`).
- Vertex editing.
- Multi-select at the canvas level works: marquee and shift-click, with multi-move and multi-delete (`fabric-overlay.ts:556`, `base-tool.ts:146-160`).
- `maxCount` limits can be scoped.

### 1.1 No undo/redo, and deletes cannot be reversed

- **Evidence**
  - `AnnotationAction` has only ADD, UPDATE, DELETE and LOAD (`packages/osdlabel/src/actions.ts:16-36`).
  - Grepping `undo|redo|history` in `packages/*/src` finds nothing.
  - Delete and Backspace delete the selection at once (`keyboard.ts:172-184`, `base-tool.ts:120-125`). `deleteAlt` is bound to `'Backspace'` (`keyboard.ts:22`).
- **Why it matters**
  - It is the first thing a dataset team asks for.
  - One stray Backspace loses work.
  - Peers have it (from memory): Annotorious 3 `undo()`/`redo()`/`canUndo()`, CVAT and Label Studio Ctrl+Z.
- **Fix**
  - Add `createHistory()` in `osdlabel` that records the inverse of each action in the shared action layer:
    - ADD and DELETE invert each other;
    - UPDATE records the prior fields;
    - LOAD records the prior `byImage`.
  - One entry per `object:modified`, which already fires once per gesture.
  - A `transaction()` API for batched changes.
  - Expose `undo`/`redo`/`canUndo` in both bindings.
  - The canvas rebuilds from state, so the visual side needs no extra work.
  - Ctrl+Z needs fix 2.4 first.
- **Size:** M

### 1.2 Selection is lost after every edit and only flows one way (canvas to state)

- **Evidence**
  - Every committed edit reruns the clear-and-rebuild effect (Solid `ViewerCell.tsx:138-152`; React `ViewerCell.tsx:140-146`).
  - Fabric's `_onObjectRemoved` fires `selection:cleared` when it removes the active object (`fabric src/canvas/SelectableCanvas.ts:356-366`). `SelectTool` turns that into `setSelectedAnnotation(null)` (`select-tool.ts:98-101`). So moving a shape deselects it.
  - `actions.setSelectedAnnotation(id)` never reaches the canvas. The only `setActiveObject` call in the repo is in `poly-vertex-editor.ts:236`.
  - A multi-selection is reported to state as no selection (`select-tool.ts:93-95`; `selectedAnnotationId: AnnotationId | null` at `viewer-api/src/types.ts:67`).
- **Why it matters**
  - It blocks move-then-resize, arrow-key nudging, and every host side-panel list (click a row, highlight the shape).
  - Selection emphasis and the "Convert to Rect" button disappear after each move.
  - This is new evidence on the known clear-and-rebuild item, but it can be fixed without rewriting the renderer.
- **Fix**
  - After `canvas.add`, re-apply `setActiveObject` for the id held in state. Capture the id before the clear and swallow the transient `selection:cleared`.
  - Add an effect that pushes programmatic selection from state to the canvas.
  - Later, add `selectedAnnotationIds`, keeping `selectedAnnotationId` as a derived value. This is breaking, because `DecorationContext` changes.
- **Size:** S for restore plus two-way sync; M for multi-select in state.

### 1.3 Hit-testing uses bounding boxes, and drawing tools ignore presses on any hit

- **Evidence**
  - Fabric's `containsPoint` is `isPointInPolygon(point, this.getCoords())`, i.e. the object's oriented bounding box (`fabric src/shapes/Object/ObjectGeometry.ts:284-286`). Line, Polyline and Circle do not override it.
  - The repo never sets `perPixelTargetFind` or `targetFindTolerance`.
  - Drawing tools drop the press when `opt.target.id` is set (`solid/src/hooks/useAnnotationTool.ts:190-196`; React is the same).
  - Objects are re-added in `Object.values` order, and there is no z-order control.
- **Why it matters**
  - Within one context you cannot place a point inside a region polygon, or anywhere inside the bounding box of a diagonal line or freehand stroke.
  - A large shape drawn later permanently blocks selection of smaller ones under it.
  - CVAT has per-object z-order (+/-) (from memory).
- **Fix**
  - Exact `containsPoint` per geometry using `@osdlabel/geometry`: distance to segment with a tolerance in screen pixels, and point-in-polygon.
  - Draw smaller areas on top by default.
  - Add bring-forward and send-back actions.
- **Size:** M

### 1.4 No duplicate, copy/paste, keyboard nudge, snapping, or per-annotation lock/hide

- **Evidence**
  - Grepping clipboard, paste, duplicate, snap, Arrow, lock and hidden in `packages/*/src` finds nothing.
  - `BaseAnnotation` has no lock or visibility field (`annotation/src/annotation.ts:5-12`).
  - CVAT has L (lock), H (hide) and Ctrl+C/V (from memory).
- **Fix**
  - Hide and lock as UI state that is not serialized (`hiddenAnnotationIds`, `lockedAnnotationIds`), applied in the ViewerCell filter and through `_readOnly`. **S**
  - Nudge with arrows (Shift for 10 px) through `updateAnnotation`, once 1.2 is fixed. **S**
  - Duplicate and paste through `createAnnotationFromGeometry` (`create-annotation.ts:63`) plus a per-geometry translate helper. The helper is another switch over the closed union, which the registry will later absorb. **M**

### 1.5 No place in the data model for attributes, classes, review state, comments or authorship (new evidence for the envelope / #46 item)

- **Evidence**
  - `BaseAnnotation` has only `id`, `geometry`, `toolType`, `label?`, `createdAt` and `updatedAt`.
  - `BaseAnnotationSchema` accepts `metadata` (`validation/src/schemas/annotation.ts:16`), which the type does not declare: the schema and the type have drifted.
  - Style lives only inside `rawAnnotationData`.
  - `updateAnnotation` accepts a `geometry`-only patch, but the canvas renders only from `rawAnnotationData` (`fabric-utils.ts:74-87`). A host that patches geometry sees the measurements change while the shape stays put.
  - Changing a shape's class or colour means rebuilding the Fabric payload.
  - Constraints have only `maxCount`. There is no minimum and no "image complete" status (`constraints.ts:41-58`).
- **Fix**
  - Long term, inside #46: an `attributes` bag with a schema per context, a review state, and `createdBy`. **L**
  - Now, independently (**S**):
    - reconcile `metadata` between the schema and the type;
    - add `updateAnnotationGeometry()` that regenerates the raw data;
    - add `minCount` and a `satisfied` flag to `ConstraintStatus`.

---

## 2. Host-integration API

**Already good**

- Each annotation that fails to render is isolated and reported through `onAnnotationRenderError` (#209).
- `loadAnnotations` and `createAnnotationFromGeometry` support importing at runtime.
- React exposes a store reader with `subscribe` and `getSnapshot` (`react/src/state/annotator-store.ts:33-41`).
- All 12 packages are ESM-only with `sideEffects: false`.
- No library code has side effects at import time: `initFabricModule` runs in the overlay constructor (`fabric-overlay.ts:297`).
- Published sizes are modest. Unpacked, including `.d.ts`, maps and changelogs: `osdlabel` 199 KB, `@osdlabel/solid` 103 KB, `@osdlabel/react` 198 KB. The peers dominate: Fabric 7.4 is 92 KB gzipped and OSD 5.0.1 is 66 KB gzipped.

### 2.1 Change events are coarse

- **Evidence**
  - Both providers call `onAnnotationsChange(getAllAnnotationsFlat(state))` on every `changeCounter` bump (Solid `annotator-context.tsx:231-243`; React `annotator-context.tsx:301-309`).
  - That includes the host's own `LOAD_ANNOTATIONS` (`actions.ts:144-148`), so a load echoes straight back.
  - The event says nothing about whether the user or the API made the change, and there is no veto.
  - There are no selection, tool or active-cell callbacks.
- **Why it matters**
  - A host syncing to a backend has to diff the full array, which costs O(N) per edit, and it saves back what it just loaded.
  - Annotorious emits create, update, delete and selectionChanged events (from memory).
- **Fix**
  - `onAnnotationEvent({ type, annotation, previous, source })`, emitted from the shared action layer.
  - `onSelectionChange` and `onActiveImageChange`.
  - An optional `onBeforeAnnotationChange` hook that can veto or transform a change.
- **Size:** S for events; M for the veto.

### 2.2 Whether a prop is live depends on the prop and on the binding

- **Evidence**
  - Solid reads `fullscreenTarget`, `testMode`, `decorationProviders`, `defaultPixelSpacing` and `renderDomDecoration` once, into a plain object (`solid/src/state/annotator-context.tsx:266,279-282`). Its ViewerCell then destructures them once (`ViewerCell.tsx:32-41`). This is the same class of bug as #219.
  - React re-reads these props (`react/src/state/annotator-context.tsx:333`, ViewerCell deps at `:212`).
  - React has a test that swaps providers (`react/tests/unit/components/viewer-cell-live-decorations.test.tsx:209`); Solid has no counterpart.
  - `contexts` and `initialAnnotations` are read only at mount in both bindings (Solid `Annotator.tsx:170-176`, React `Annotator.tsx:53-59`), while `images` and `displayedContextIds` stay live. The prop docs don't say which is which.
- **Why it matters**
  - A "show measurements" toggle works in React and silently does nothing in Solid.
  - Contexts fetched after mount need a remount.
  - This feeds into #229.
- **Fix**
  - Read those props through getters or memos in Solid, and add a parity test.
  - Document per prop whether it is read once or live, or rename the mount-only ones (e.g. `initialContexts`).
- **Size:** S

### 2.3 The `osdlabel` core cannot be imported under Node or SSR

- **Evidence**
  - `osdlabel/src/index.ts:93-113` re-exports `@osdlabel/fabric-osd`, which value-imports `openseadragon` (`fabric-overlay.ts:1`).
  - Under Node, `import('openseadragon')` throws `document is not defined`. Fabric imports fine.
  - Both bindings do `export * from 'osdlabel'`, so they inherit this.
  - So `serialize`, `deserialize`, the reducers and the decoration providers are all unusable server-side.
  - The docs give the wrong error, `window is not defined` (`react-and-ssr.mdx:100`).
  - The docs' Next.js recipe calls `dynamic(…, { ssr: false })` from a Server Component (`react-and-ssr.mdx:129-132`). Next 15 rejects that (from memory).
  - The Solid package ships only DOM-compiled output, with no `solid` export condition.
- **Fix**
  - A DOM-free entry: either `osdlabel/core`, or move the overlay re-exports to `osdlabel/overlay`.
  - A Node import smoke test in CI.
  - Correct the Next.js recipe.
- **Size:** S–M. Moving the barrel breaks anyone importing the overlay from it.

### 2.4 Shortcuts ignore modifier keys and listen on the whole window

- **Evidence**
  - `mapKeyEventToActions(key, shiftKey, …)` takes no Ctrl, Meta or Alt (`keyboard.ts:108-111`). The hooks pass only `e.key` and `e.shiftKey` (Solid `useKeyboard.ts:49-52`).
  - The hooks listen on `window` (Solid `:72`, React `:87`).
  - Consequences:
    - Ctrl/Cmd+C switches to the circle tool;
    - Ctrl/Cmd+V switches to the select tool;
    - Ctrl+D switches to the polyline tool;
    - Cmd+Backspace deletes the selection.
  - The host predicate receives only the target element, not the event (`annotator-context.tsx:138`), so a host cannot filter on modifiers.
  - Two annotators on one page both react to every key.
  - Tooltips hard-code the default bindings, e.g. "Rotate CCW (Shift+L)" (`ViewControls.tsx:49, 84, 121, 157, 195, 232, 290, 335, 386, 547`). They are wrong once a host remaps shortcuts.
- **Fix**
  - A binding syntax with modifiers (`'Mod+z'`), where an unmodified binding never fires while Ctrl, Meta or Alt is held.
  - Scope listening to the annotator root, or make it a `keyboardScope` option.
  - Pass the event to the host predicate.
  - Build tooltip text from the merged shortcut map.
- **Size:** S

### 2.5 Error reporting is weak

- **Evidence**
  - `deserialize` is all-or-nothing and keeps only valibot's message (`serialization-configured.ts:29-36`). Probe: for an array whose third item lacks `createdAt`, the message is `Invalid key: Expected "createdAt" but received undefined`. The issue path `2.createdAt`, which says which record, is discarded.
  - No test covers the rejection path.
  - `addAnnotation` returns `void`. It:
    - drops an out-of-scope annotation with only a `console.warn` (`actions.ts:87-98`);
    - does not enforce `maxCount`;
    - accepts an unknown `contextId`;
    - silently overwrites an existing id and resets its `createdAt` (`actions.ts:109-121`).
  - Nothing listens for `open-failed`. The only signal of a failed image is OSD's unstyled message.
- **Fix**
  - Return issues with their paths, and add `{ onInvalid: 'skip' }` returning the rejected records.
  - Have `addAnnotation` return a result union.
  - Add `onImageError` and a styled error state in the cell.
- **Size:** S

### 2.6 The public API is large and has no tiers

- **Evidence**
  - The `osdlabel` barrel exports about 161 names, including binding internals (`processToolAddAnnotation`, `settleAnnotationObjects`, `preventButtonFocusSteal`, `CELL_ASSIGNMENT_*`; `index.ts:150-272`).
  - Every package has `"./*"` in its exports map, so every file is importable.
  - There are no `@internal` tags, no API report and no `@deprecated` anywhere.
  - Breaking changes have shipped in minor releases with no deprecation step (`osdlabel/CHANGELOG.md:403, 562, 583, 587`).
- **Fix**
  - Tag internals `@internal` or move them to an internal entry.
  - Drop `./*`.
  - Add an api-extractor report check in CI.
  - Publish a short stability and deprecation policy.
- **Size:** M

---

## 3. Accessibility and internationalisation

**Already good**

- The filmstrip is genuinely accessible: list roles, real buttons, state included in the accessible name, a 24 px target, focus restored after clearing (#189, #205).
- ViewControls uses `aria-pressed` and `aria-live`.
- `shouldSkipKeyboardShortcut` handles focused controls carefully.
- Measurement text can already be localised through the `formatLine` hook.

### 3.1 The toolbar and grid controls lack basic semantics

- **Evidence**
  - **Toolbar**
    - No `role="toolbar"`.
    - The active tool is shown only by colour and bold, with no `aria-pressed` (`Toolbar.tsx:57-157`) — unlike ViewControls.
    - The 4 toolbar buttons and the grid trigger have no `type="button"` in either binding, so inside a host `<form>`, clicking a tool submits the form.
  - **GridControls**
    - The trigger has no `aria-expanded`.
    - The grid size cells are clickable `div`s (`GridControls.tsx:161-174`).
    - The popover closes only on mouseleave (`:85`), so it cannot be used from the keyboard.
  - **ContextSwitcher:** the `<select>` has no accessible name (`ContextSwitcher.tsx:17-29`).
  - **GridView:** "Assign an image" is a clickable `div` (`GridView.tsx:61-80`).
  - **StatusBar:** no `role="status"`, so changes are not announced.
  - **Contrast** (computed):
    - active tool, white on #2196F3: 3.12:1 (`Toolbar.tsx:65`);
    - empty-cell text, #777 on #1a1a1a: 3.89:1.
    - Both are below the 4.5:1 AA minimum.
- **Fix**
  - Add the roles, `aria-pressed`, and `aria-keyshortcuts` built from the shortcut map.
  - Add `type="button"`.
  - Make the grid popover keyboard-operable.
  - Label the select.
  - Add a live region.
  - Darken the two colours. This overlaps the styling-tokens item, but changing the defaults is a one-liner.
  - Add axe checks to E2E.
- **Size:** S–M

### 3.2 The viewer cells work only with a mouse

- **Evidence**
  - The overlay blocks every OSD `canvas-key` event (`fabric-overlay.ts:287-289, 365`), which disables OSD's arrow-key pan and +/- zoom.
  - `showNavigationControl` is false (`osd-helper/src/viewer-options.ts:34`), and there are no zoom buttons.
  - Cells have no role or label. The active cell is shown only by a border (`ViewerCell.tsx:254`).
  - No tool can be used without a pointer.
- **Fix**
  - Block only the keys that shortcuts are bound to, instead of all of them.
  - Add zoom in, zoom out and home buttons.
  - Give each cell `role="group"` and a label.
  - Keyboard point placement is a separate, larger step.
- **Size:** M for pan, zoom and labels; L for keyboard drawing.

### 3.3 UI strings are hard-coded English

- **Evidence**
  - A regex scan finds 41 literal strings in each binding's components: ViewControls 22, Toolbar 9 (including `TOOL_LABELS` at `Toolbar.tsx:6-13`), StatusBar 6, and others.
  - 8 more in `osdlabel/src/cell-assignment.ts:109-133`.
  - StatusBar shows "FreeHandPath" (`StatusBar.tsx:21-25`) where the toolbar says "Free Draw".
  - Measurements are formatted with `toFixed` (`measurement.ts:161`), not locale-aware.
  - Layout uses only physical left/right CSS, so right-to-left layouts are not handled.
- **Fix**
  - A shared, typed `messages` prop.
  - A locale option for `formatMeasurement`.
  - CSS logical properties.
  - Design it together with the styling slots.
- **Size:** M

---

## 4. Robustness

**Already good**

- Teardown is thorough, and tested in both bindings (`fabric-overlay.ts:599-613` plus the viewer-cell teardown tests).
- Async rebuilds are cancelled correctly (#160, #190).
- There is a device-pixel-ratio observer.
- Touch input was fixed and is covered by E2E (#175).
- The only window-level listener is `keydown`, and it is removed on cleanup.

### 4.1 Zoom is capped at 40× fit-width, so whole-slide images never reach native resolution

- **Evidence**
  - `maxZoomLevel: 40` is set at `osd-helper/src/viewer-options.ts:38`.
  - When `maxZoomLevel` is set, OSD's `getMaxZoom` ignores `maxZoomPixelRatio` (`openseadragon.js:22746-22754`).
  - So a 100k px slide in a 1000 px cell bottoms out at 2.5 image pixels per screen pixel. In 500 px cells it is 5.
  - Nothing tests this value and nothing records why it was chosen; it came from `references/openseadragon-api.md:15`.
- **Fix:** Use `maxZoomPixelRatio` (around 2–4) instead, and add a test.
- **Size:** S

### 4.2 OpenSeadragon viewer options cannot be overridden

- **Evidence**
  - Both ViewerCells pass `{ ...DEFAULT_VIEWER_OPTIONS, element }` (Solid `:51-54`, React `:59-62`).
  - So a host cannot:
    - turn on the navigator minimap;
    - raise `tileRetryMax`, which defaults to 0 (`openseadragon.js:1425`), or the timeout;
    - set viewer-level `ajaxHeaders`;
    - tune gestures.
  - This overlaps the known drawer-policy item.
- **Fix:** A `viewerOptions` prop merged over the defaults, with `element` reserved.
- **Size:** S

### 4.3 Very large per-image annotation sets throw `RangeError`

- **Evidence**
  - `result.push(...Object.values(annMap))` (`viewer-api/src/utils.ts:14`) sits behind both `serialize` and every `onAnnotationsChange`.
  - `canvas.add(...)` and `canvas.remove(...)` also spread (Solid `ViewerCell.tsx:152, 182`; React `:146, 169`).
  - On Node 22, spreading 150,000 elements throws `Maximum call stack size exceeded`. 100,000 is fine.
  - Detecting individual cells or nuclei on one whole-slide image easily passes 100k annotations.
- **Fix:** Use loops or chunked calls, and add a 200k-item test.
- **Size:** S

### 4.4 Filmstrip thumbnails all load at once

- **Evidence**
  - The `<img>` tags have no `loading` or `decoding` attribute and no `onerror` (`Filmstrip.tsx:120-129`, both bindings).
- **Fix:** Add `loading="lazy" decoding="async"` and fall back to the name placeholder on error. This is independent of virtualizing the list.
- **Size:** S

---

## 5. Developer experience and release hygiene

**Already good**

- Changesets in a fixed lockstep group, published with provenance.
- Changelogs are detailed and flag breaking changes.
- TypeDoc runs with warnings as errors.
- Binding-parity discipline: about 146 Playwright tests run against both apps.
- E2E runs offline.
- There is a calibrated benchmark gate.

### 5.1 TSDoc is missing on the most-used exports

- **Evidence:** 82 of 280 exports that packages declare themselves have no doc comment:
  - Solid: 21 of 25, including `Annotator`, `AnnotatorProvider`, `useAnnotator`, `Toolbar` and `ViewerCell`;
  - React: 22 of 26;
  - fabric-annotations: 12 of 35 (all the tool classes);
  - osdlabel: 11 of 75 (reducers and action unions).
- **Fix:** Write the docs, and add a lint rule that requires them on exports.
- **Size:** S

### 5.2 Broken documentation links

- **Evidence**
  - `/osdlabel/api/components/` and `/osdlabel/api/types/#keyboardshortcutmap` are linked from `guides/annotation-contexts.mdx:182` and `guides/keyboard-shortcuts.mdx:37, 96`, and repeated in `llm.md`.
  - No such pages exist; the reference lives under `api/reference/`.
  - No validator checks internal links.
- **Fix:** Fix the links and add `starlight-links-validator`.
- **Size:** S

### 5.3 Test and browser coverage

- **Evidence**
  - Neither Playwright config defines `projects`, so only Chromium is tested. Yet the code has Safari-specific paths (`osdlabel/src/fullscreen.ts:4-60`).
  - No coverage is measured anywhere.
  - No screenshot tests and no axe checks.
  - Neither binding has unit tests for Toolbar, GridView, GridControls, ViewControls, StatusBar or ContextSwitcher (E2E covers most of their behaviour).
- **Fix**
  - Firefox and WebKit projects running a tagged smoke subset.
  - Report `vitest --coverage`.
  - A few canvas screenshot tests.
- **Size:** S–M

---

## Ranked top 10 for a maturity-and-polish track

| #   | Item                                                                                                                                                                             | Size     | Independent of registry, envelope, OSD 6 and styling contract?                             |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------ |
| 1   | Undo/redo with transactions (1.1)                                                                                                                                                | M        | Yes                                                                                        |
| 2   | Shortcut correctness: modifiers, root scoping, event passed to the host predicate, tooltips from the map (2.4)                                                                   | S        | Yes                                                                                        |
| 3   | Host event API (2.1) plus live-prop parity and a stated live-vs-mount contract (2.2)                                                                                             | S–M      | Yes; complements #229                                                                      |
| 4   | Whole-slide readiness: fix the zoom cap, `viewerOptions` passthrough, `onImageError` (4.1, 4.2, 2.5)                                                                             | S        | Yes; touches the same files as OSD 6 and the drawer policy, so land it before or with them |
| 5   | Selection: survives edits, syncs both ways (S); then multi-select in state (M) (1.2)                                                                                             | S/M      | Yes                                                                                        |
| 6   | Exact hit-testing and z-order (1.3)                                                                                                                                              | M        | Yes; define the per-type hit-test hook now so the registry can adopt it                    |
| 7   | Accessibility pass on the chrome, keyboard pan/zoom, axe in CI (3.1, 3.2)                                                                                                        | M        | Yes; the colour fixes overlap the tokens                                                   |
| 8   | Error reporting and large-data robustness: deserialize diagnostics and lenient mode, `addAnnotation` result, spread `RangeError` (2.5, 4.3)                                      | S        | Yes; the envelope should reuse the diagnostics shape                                       |
| 9   | i18n `messages` prop and locale-aware measurements (3.3)                                                                                                                         | M        | Yes, but design it together with the styling slots                                         |
| 10  | Release and developer hygiene: SSR-safe core entry, `@internal` tiers with an API report and stability policy, TSDoc, link validator, Firefox/WebKit smoke tests (2.3, 2.6, 5.x) | S–M each | Yes                                                                                        |

**Depend on the bigger roadmap work**

- Attributes, classes, review status, comments and `createdBy` (1.5): envelope / #46.
- Copy/paste across geometry types (1.4): the translate helper is another switch over the closed union, which the registry absorbs.
- A serialized z-order field: envelope.
