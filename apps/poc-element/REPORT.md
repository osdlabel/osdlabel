# Proof of concept: one custom element for every framework, and a shared UI contract

Branch `claude/poc-element`, head `d573d2d8a3` at the time of the result. Part of the osdlabel roadmap study (branch `claude/osdlabel-roadmap-strategy-uut5ay`). Written by the orchestrating agent from the PoC agent's structured result, because PoC agents in this environment cannot write report files.

**Status:** Build, independent review and fix pass complete. Both blocking findings are fixed with mutation evidence. Timings are from a loaded 4-core machine; a quiet-machine rerun follows.

## Summary

This fix run addresses the independent review of the "element" PoC (branch claude/poc-element, now at d573d2d; 9 commits on top of 6c89556, all pushed). Both blocking findings were correct, and both are fixed, with mutation evidence.

1. The slot contract is now exhaustive in every renderer.

- Solid and React each declare `ANNOTATOR_SLOT_RENDERERS` (`satisfies { readonly [K in AnnotatorSlotName]: AnnotatorSlotRenderer<K> }`), and the stock layout renders every slot through a generic `<AnnotatorSlot name>`.
- The element declares `createElementSlots()` the same way and hands the whole table to `<Annotator components>`.
- Tests per renderer: an `@ts-expect-error` on a table missing a slot, a check that the table's keys equal `ANNOTATOR_SLOT_NAMES`, and, in the bindings, an override rendered for every slot name. The element's E2E checks for a named `<slot>` per name.
- The reviewer's mutation (adding a StatusBar slot) now fails tsc in all three renderers (TS2741/TS1360) and fails the runtime tests. Making the table keys optional again gives TS2578 in all three.

2. Part names now work as light-DOM styling hooks for the toolbar.

- The toolbar's stock styles moved from inline styles into one shared stylesheet, `OSDLABEL_STOCK_CSS`, wrapped in `@layer osdlabel`. It selects on class twins of the part names (`partClassName`).
- The sheet is built once per document as a constructed `CSSStyleSheet` and adopted into the document or the element's shadow root. Nothing is added to `document.head`.
- `[part~=]` and class overrides of background, padding and colour now work in Solid, React and the light-DOM element: 3/3, against 0/3 before. `::part()` in shadow DOM works before and after. The stock look is unchanged.
- Cost: about 24 µs to build the sheet and about 0.35 ms to adopt it, once per document. Shadow-DOM isolation is unchanged.
- The layer's cost in light DOM: an unlayered host reset now beats the stock styles too. Bootstrap 5.3 overrides 15 toolbar properties (buttons 58×23 → 68×32 px). An unlayered Tailwind preflight overrides 51 (transparent, unpadded buttons). Tailwind 4 as it ships (preflight in `@layer base`) overrides 1, the same as inline styles.
- An unlayered class-selector sheet, measured by emulation, keeps inline-level isolation (1 property under every host stylesheet). An ancestor-qualified host rule (specificity 0,2,0) still overrides it; a bare `[part~=]` rule loses the tie.
- Recommendation: the stylesheet is worth it; ship the unlayered variant, which drops the layer wrapper.

Cheap fixes, each with evidence:

- `decorationProviders` written after connect now take effect. The Solid provider exposes it through a getter, as React already did. In the host matrix, the vanilla host (assigned after append) and Angular went from 0 decorations to 1; all 5 hosts now pass.
- The element compares before it copies on the controlled echo. At 1k annotations, plain input: 7.8 → 0.54 ms. At 10k, behind a deep proxy: 337 → 17 ms.
- The updatedAt echo rule is documented on the property and pinned by an E2E test.
- The element's `:host` CSS is now an adopted sheet, so it survives a strict `style-src` CSP.
- React's toolbar commands now read the store, matching Solid (#217); the mirrored test fails on the old closure.
- The change to what `shouldSkipKeyboardShortcutPredicate` receives inside a shadow root is documented and tested in both bindings.

Restated claims:

- TTI cannot separate the element from the Solid binding: the deltas were −13% to +9% over 4 runs, so no difference is detectable at about ±15%. A mount microbenchmark puts the element's own mount overhead at 0.2–0.6 ms.
- Light DOM reached interactive before shadow DOM in 4 of 4 runs (5–20%). Mount cost differs by at most 0.5 ms, so mount cost does not explain the gap.
- H1b (solid-element vs hand-rolled) supports a preference for the hand-rolled element, not a refutation.

Test status:

- Unit tests: osdlabel 334, solid 170, react 231, element 16, poc-element 5, all pass.
- PoC E2E: 75/75.
- React dev E2E suite: 172 passed, 1 skipped.
- Solid dev E2E suite: 170 passed and 1 skipped. 2 tests failed under load average ~10; both passed 3/3 on rerun.

## Hypotheses and verdicts

### H1: confirmed

One framework-neutral custom element (<osdlabel-annotator>, built from the Solid binding) works from vanilla HTML, Vue 3, Svelte 5 and Angular (plus React 19), with property inputs (images, contexts, annotations, decorationProviders) and DOM CustomEvents, at a small bundle and startup cost.

hosts.spec.ts runs 28 tests, all passing. Hosts: vanilla, Vue 3.5.44, Svelte 5.57.2, Angular 22.2.3 (JIT, zoneless, CUSTOM_ELEMENTS_SCHEMA) and React 19.2 consuming the element. The specs cover:

- drawing updates the framework's own reactive state;
- selection fires selectedannotationchange;
- a host write to `annotations` raises 0 annotationschange events;
- the controlled round trip gives exactly [1,2] events and 2 Fabric objects.

New since the review: every host binds `decorationProviders` through its own syntax, and a new test draws a rectangle and expects one decoration.

- Before the Solid provider fix: vanilla (assigned after append) and Angular (binds after connect) rendered 0. Vue, Svelte and React 19, which set the property before connect, rendered 1.
- After the fix: 5/5.

A second new test pins the echo rule: a +200 px move written back with the same updatedAt is ignored; with updatedAt bumped it is applied.

Cost (review-fix run):

- Bundle: +1.9 KiB gzip over the Solid binding (191.9 vs 190.0 KiB).
- TTI: no difference detectable at this machine's resolution, about ±15%. The element-minus-Solid median delta across four runs was -2%, +9%, -13% and +8.6% (this run: 907 vs 835 ms at load average 9.1→7.8).
- The new mount microbenchmark (no image, so no OSD viewer or WebGL; 5 page loads × 40 mounts per variant) measures the element's own overhead directly: median mount 1.67 ms (element, shadow) vs 1.50 ms (Solid binding), and 3.01 vs 2.50 ms including style and layout. An earlier 3-page run gave 2.23 vs 1.63 ms. So the overhead is roughly 0.2–0.6 ms.

### H1b: partial

solid-element is at least as good a basis for the element as a hand-rolled customElements.define wrapper.

Restated after the review: the evidence supports a preference, not a refutation.

Ties:

- Wrapper size: 2.1 KiB gzip (solid-element) vs 2.5 KiB (hand-rolled, which now includes the slot table).
- Full bundle: 191.7 vs 191.9 KiB.
- TTI is noise.

Corrections to the original claim:

- component-register 0.8.8 also defers teardown. Its disconnectedCallback runs `await Promise.resolve(); if (this.isConnected) return;` (dist/component-register.js lines 147-153).
- 'Fewer features' reflects how the PoC scoped that variant, not a limit of solid-element.

The real differences, both verified:

- The element is typed as `[prop: string]: any`, so commands had to be Object.assign'ed on.
- Attribute values go through JSON.parse. `parseAttributeValue('')` returns undefined, so a bare `test-mode` attribute leaves testMode undefined (E2E records it).

The hand-rolled class stays the recommendation for its typing and its control over attributes.

### H2: partial

OpenSeadragon and Fabric work inside a shadow root: pointer routing, keyboard shortcuts and focus, fullscreen, decoration positioning, popovers, CSS isolation.

Unchanged from the build run:

- With the existing packages unchanged, 6/10 shadow-DOM lab checks pass. The failures are drag, the decoration that depends on it, a text field inside the root swallowing shortcuts, and the filmstrip focus hand-off.
- After 63 lines of fixes in 5 files plus one new 40-line file (composed:true on forwarded events, getEventOrigin, isFocusedInItsRoot), 10/10 pass. The reviewer reproduced both results.

New in this run:

- The element's :host CSS was a <style> element inside the shadow root, and a strict `style-src 'self'` CSP blocks <style> elements (csp-probe.mjs, Chromium 153: <style> and a parsed style attribute blocked; CSSOM inline styles and adopted constructed sheets applied). It is now one constructed sheet per document, adopted into each shadow root. The shadow root holds 0 <style> nodes and 2 adopted sheets (host and stock).
- The new CSP test passes for all 4 renderers: toolbar styles and :host display:block hold under the CSP.

CSS isolation, re-weighted as the reviewer asked:

- Light DOM: 127/127 elements change under Bootstrap or Tailwind, but inherited line-height (126) and font-family (114) dominate that count.
- The visible effect: toolbar bar 86→88 px, tool button 58×23 → 59×28 (Bootstrap) or 54×28 (Tailwind); pointer error 0.00 px everywhere.
- Today's bindings already carry this exposure in light DOM.
- The stronger case for shadow DOM is named slots plus selector isolation. Under a layered stock sheet, Bootstrap or an unlayered preflight reaches 15 or 51 toolbar properties in light DOM and 0 in shadow DOM.

Still untested in a shadow root: touch, vertex editing, wheel zoom, and the popover's isInTopLayer check inside a fullscreen shadow root.

### H3: confirmed

Design tokens (--osdlabel-\*), part attributes and a slot/override model, with the contract shared in osdlabel, can be added to BOTH bindings and the element so that the override contract cannot drift between renderers.

The review showed the original enforcement claim was false: AnnotatorComponents is an optional mapped type, so a slot added to the map compiled clean everywhere and rendered nowhere. It now holds, with evidence.

The tables:

- @osdlabel/solid and @osdlabel/react export ANNOTATOR_SLOT_RENDERERS ({ useProps, Stock } per slot) declared `satisfies AnnotatorSlotRendererTable`, a mapped type with required keys over AnnotatorSlotName. The stock layout renders each slot through `<AnnotatorSlot name>` (Solid uses createComponent so the generic stays typed with more than one slot).
- @osdlabel/element's createElementSlots() returns an ElementSlotTable, also with required keys. Each entry wraps the stock view in the named <slot>.

Tests:

- One @ts-expect-error per renderer, on a table missing Toolbar.
- A runtime check per renderer that the table's keys equal ANNOTATOR_SLOT_NAMES.
- Per binding: an override marker rendered for every slot name.
- E2E: the element's shadow root has a <slot> for every name.

Mutation evidence:

- StatusBar added to the shared map and ANNOTATOR_SLOT_NAMES, osdlabel rebuilt: tsc fails with TS2741/TS1360 in solid, react and element, and the runtime tests fail 2/2/1.
- Table keys made optional: TS2578 (unused @ts-expect-error) in all three test files.

Styling cannot drift either: the toolbar's styles are now one shared sheet in osdlabel, and both bindings' Toolbar.tsx have 0 inline style objects.

Style inventory after the change:

- Solid: 53 style objects / 345 declarations (was 59/362).
- React: 38/215 (was 44/232).
- Declaration strings found in only one binding: 26 Solid-only, 20 React-only.

What still drifts: the toolbar markup (ToolbarView, about 110 lines) is written twice, and 7 components remain inline-styled.

### H3b: partial

Part names are usable as light-DOM styling hooks ([part~=] / class selectors) in both bindings, not only through ::part() on the element.

Refuted for inline styles, confirmed for the toolbar once its styles moved to a stylesheet. The other 7 components are still inline-styled, so the hooks do not work there yet.

parts.spec.ts mounts the Solid binding, the React binding, the element in light DOM and the element in shadow DOM. An unlayered host stylesheet overrides background, padding and colour through `.host-override [part~="tool-button"]`, `[part~="tool-button-active"]`, `.osdlabel-tool-button`, or ::part().

At 803d92d (inline styles):

- solid, react and element-light fail with observed rgb(51, 51, 51) / 4px / rgb(255, 255, 255) / active rgb(33, 150, 243), i.e. unchanged.
- element-shadow passes through ::part(). 5/8 pass.

After 3eab134 (stylesheet): 8/8 pass, plus 9/9 variant tests:

- layered sheet + bare selector (0,1,0): the override wins;
- unlayered sheet + scoped (0,2,0): the override wins;
- unlayered sheet + bare: the stock look stays (the sheet is adopted after the page's own sheets and wins the tie).

The stock look without host CSS is unchanged in all 4 renderers, as is the unthemed theme-spec check (active rgb(33, 150, 243), radius 4px, font 13px).

### H4: partial

Shadow DOM costs startup time compared with light DOM.

TTI, same lab page, light DOM vs shadow DOM, medians across four runs:

- 461 vs 485 ms (-5%);
- 620 vs 668 ms (-7%);
- 713 vs 762 ms (-6%, the reviewer's run);
- 784 vs 979 ms (-20%, this run, load average 9.1→7.8).

Light DOM was faster in 4/4 runs, but the interquartile ranges overlap in 3 of the 4.

The mount microbenchmark (UI only, no image) finds no mount-level difference. Element-shadow vs element-light median mount was 1.67 vs 1.83 ms (2.23 vs 1.73 in the earlier 3-page run), and 3.01 vs 2.84 ms including style and layout. So shadow DOM's mount overhead is at most about 0.5–1.2 ms and cannot explain a 24–195 ms TTI gap.

The cause, in image load, OSD/WebGL or the probe, is not identified. Needs the quiet-machine rerun.

### H5: refuted

A CSS cascade layer (@layer osdlabel) is the right precedence for the stock stylesheet in light DOM.

The CSS bench (`--only css`; the lab page; 16 toolbar properties the stock UI sets, per toolbar element, compared with the same mode and no host CSS) counts how many of them host CSS overrode.

Inline baseline (results/css-inline-baseline.json, ff30155), lost properties under Bootstrap 5.3.8 / unlayered Tailwind 4.3.3 preflight / layered preflight:

- light DOM: 1 / 1 / 1, rect button 59×28 / 54×28 / 54×28 vs 58×23 base;
- shadow DOM: 1 / 0 / 0.

Layered sheet, light DOM:

- Bootstrap: 15 (border-radius ×7, font-size ×7, colour ×1); button 68×32, toolbar bar 92 px vs 86.
- Unlayered preflight: 51 (background ×7 → transparent, padding ×14, radius ×7, colour ×7, font-size ×7, border-style ×8, font-weight ×1); button 41×24.
- Tailwind's layered preflight: 1, because the later-declared osdlabel layer wins.

Unlayered class-selector sheet (emulated with ?stock=unlayered, the same rules adopted into the document without the layer): 1 / 1 / 1, buttons 59×28 / 54×28 / 54×28, identical to inline.

Shadow DOM is identical for both, since host CSS cannot reach the sheet.

The layer lets any host selector override, at the cost of losing to every unlayered element reset. The unlayered sheet keeps today's isolation and needs host overrides above (0,1,0), which is ordinary CSS practice. Recommend unlayered.

### H6: partial

The annotator works under a strict `style-src 'self'` Content Security Policy.

csp-probe.mjs (Chromium 153; CSP `default-src 'self'; script-src 'unsafe-inline'; style-src 'self'`) shows which mechanisms apply:

- <style> element: blocked;
- setAttribute('style'): blocked;
- CSSOM element.style: applied;
- constructed sheet adopted into the document: applied;
- constructed sheet adopted into a shadow root: applied.

parts.spec.ts loads each renderer with and without a strict CSP and diffs 10 computed properties on every annotator element:

- 0 toolbar elements restyled in all 4 renderers;
- 0 of 121 elements restyled overall.

Solid compiles static style objects into its templates' HTML `style` attributes (e.g. GridView `<div style=position:relative`). That raises 34 CSP violation reports per mount for solid, element-light and element-shadow. Chromium still applies those styles to the cloned elements. React raises 0.

Before this run the element's :host <style> would have been blocked; it is now an adopted sheet. Firefox and Safari are untested.

## Measurements

| Measurement                                                                                           | Value                                                                                                                                                                                                                                                                                                                                 | Unit                            | Conditions                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| bundle: solid-binding (everything bundled)                                                            | 686.2 raw / 190.0 gzip / 158.8 brotli (was 684.7 / 189.3 / 158.1 before the fixes)                                                                                                                                                                                                                                                    | KiB                             | results/review-fix.json, gitSha 2f30388; Vite 8.0.16 (Rolldown), target es2022, all emitted JS summed; gzip -9, brotli q11. +0.7 KiB gzip from the stock stylesheet module and slot table.                                                                                      |
| bundle: element (hand-rolled, everything bundled)                                                     | 692.1 / 191.9 / 160.2 (+1.9 gzip vs solid-binding)                                                                                                                                                                                                                                                                                    | KiB                             | same run                                                                                                                                                                                                                                                                        |
| bundle: element (solid-element variant)                                                               | 691.2 / 191.7 / 160.0 (+1.7 gzip)                                                                                                                                                                                                                                                                                                     | KiB                             | same run; that variant has no slots or annotations property                                                                                                                                                                                                                     |
| bundle: react-binding                                                                                 | 854.8 / 241.3 / 202.0 (+51.3 gzip vs solid-binding)                                                                                                                                                                                                                                                                                   | KiB                             | same run                                                                                                                                                                                                                                                                        |
| bundle: element wrapper alone                                                                         | 6.2 / 2.5 / 2.2 (solid-element wrapper 5.3 / 2.1 / 1.9)                                                                                                                                                                                                                                                                               | KiB                             | @osdlabel/\*, osdlabel, solid-js, fabric and openseadragon external                                                                                                                                                                                                             |
| bundle: osdlabel's own code                                                                           | Solid binding 122.6 / 34.2 / 30.3; React binding 123.4 / 35.2 / 31.3                                                                                                                                                                                                                                                                  | KiB                             | libraries external (immer bundled for React)                                                                                                                                                                                                                                    |
| bundle: host pages                                                                                    | vanilla 194.1, Vue 217.4, Svelte 206.0, React 19 (element) 251.2, Angular JIT 495.9                                                                                                                                                                                                                                                   | KiB gzip                        | single-entry builds of each host's main.ts; Angular is JIT (includes @angular/compiler)                                                                                                                                                                                         |
| TTI, review-fix run: median [p25-p75]                                                                 | solid binding 835 [794-875]; element shadow (vanilla) 907 [885-960]; lab shadow 979 [855-990]; lab light 784 [748-854]; solid-element 938 [866-975]; Vue 911 [851-943]; Svelte 941 [908-952]; Angular JIT 1220 [1101-1304]; React 19 element 940 [913-1009]                                                                           | ms since navigation start       | 7 reps after a warm-up pass, fresh context per sample, host order rotated. Chromium 153.0.8010.12 headless, SwiftShader WebGL (CPU-emulated, pessimistic). 4-core Xeon 2.8 GHz, load average 9.05 at start, 7.78 at end (other agents running). Do not compare across runs.     |
| TTI, review-fix run: CPU split, medians                                                               | element-ready mark 212-336 ms (Angular 649); script 502-654 ms (Angular 736); recalc style 3.1-3.6 ms; layout 15-24 ms                                                                                                                                                                                                                | ms                              | CDP Performance.getMetrics at interactive, same run                                                                                                                                                                                                                             |
| TTI: element minus Solid binding across runs                                                          | -2% (representative), +9% (earlier noisy run), -13% (reviewer), +8.6% (this run)                                                                                                                                                                                                                                                      | % of the Solid binding's median | four separate runs on the shared sandbox; no systematic difference; resolution about ±15%                                                                                                                                                                                       |
| TTI: lab light DOM vs shadow DOM across runs                                                          | 461 vs 485, 620 vs 668, 713 vs 762, 784 vs 979 (light faster in 4/4 runs, by 5-20%)                                                                                                                                                                                                                                                   | ms (medians)                    | same lab page with ?mode=light\|shadow; interquartile ranges overlap in 3 of 4 runs                                                                                                                                                                                             |
| UI mount microbenchmark: median [p25-p75]                                                             | Solid binding 1.50 [1.16-2.27]; React binding 2.20 [1.91-2.80]; element shadow 1.67 [1.29-2.67]; element light 1.83 [1.37-2.65]                                                                                                                                                                                                       | ms per synchronous mount        | mount-bench.html; no image assigned, so no OSD viewer or WebGL; 5 page loads × 40 timed mounts (after 5 warm-ups) per variant = 200 samples; React mounts with flushSync; same run as the TTI row; crossOriginIsolated=true                                                     |
| UI mount microbenchmark: mount + forced style/layout, median [p25-p75]                                | Solid 2.50 [2.05-3.53]; React 3.29 [2.85-3.91]; element shadow 3.01 [2.54-4.33]; element light 2.84 [2.30-4.03]                                                                                                                                                                                                                       | ms                              | same samples, timed to after container.offsetHeight                                                                                                                                                                                                                             |
| UI mount microbenchmark: first mount on a page, median                                                | Solid 17.3; React 28.0; element shadow 19.3; element light 18.2                                                                                                                                                                                                                                                                       | ms                              | first mount of each page load (includes JIT warm-up and the one-time sheet construction); 5 page loads                                                                                                                                                                          |
| UI mount microbenchmark: earlier quick run                                                            | mount medians Solid 1.63, React 2.03, element shadow 2.23, element light 1.73; with style/layout 2.75 / 3.00 / 4.07 / 2.82                                                                                                                                                                                                            | ms                              | 3 page loads × 40 reps, load average about 3; shows run-to-run spread of about ±0.5 ms                                                                                                                                                                                          |
| stock stylesheet: construct + parse                                                                   | median 24.4 (Solid page), 23.8 (React), 24.5 (element shadow), 28.0 (element light)                                                                                                                                                                                                                                                   | µs per sheet                    | new CSSStyleSheet() + replaceSync(OSDLABEL_STOCK_CSS, 1.2 KB, 8 rules), 20 batches of 50 per page, 5 pages                                                                                                                                                                      |
| stock stylesheet: adopt + toolbar style recalc                                                        | stock sheet 338-395 µs median vs empty sheet 105-125 µs                                                                                                                                                                                                                                                                               | µs                              | adopt a fresh copy into the mounted annotator's root and read getComputedStyle on all 7 tool buttons, 60 reps per page; in use this happens once per document                                                                                                                   |
| style nodes and adopted sheets                                                                        | light DOM (solid, react, element-light): 0 <style> nodes added to document.head, 1 adopted sheet in the document. Shadow DOM: 0 in the document, 2 adopted sheets in the shadow root (host and stock), 0 <style> nodes there (was 1 <style>, 0 adopted)                                                                               | count                           | parts.spec.ts 'stock look' annotations; CSS bench headStyleNodesAdded = 0 in every condition                                                                                                                                                                                    |
| parts lab: light-DOM override of inline-set properties, before                                        | solid, react, element-light fail (observed rgb(51, 51, 51) / 4px / rgb(255, 255, 255) / active rgb(33, 150, 243)); element-shadow passes via ::part(); 5/8 pass                                                                                                                                                                       | tests                           | parts.spec.ts at 803d92d (inline toolbar styles); host rules `.host-override [part~="tool-button"]{background-color:rgb(0,128,0);padding:20px}`, `[part~="tool-button-active"]{background-color:rgb(128,0,128)}`, `.osdlabel-tool-button{color:rgb(255,255,0)}`                 |
| parts lab: after the stylesheet move                                                                  | 8/8, plus 9/9 variants: layered sheet + bare (0,1,0) selector overrides; unlayered sheet + scoped (0,2,0) overrides; unlayered sheet + bare keeps the stock look                                                                                                                                                                      | tests                           | parts.spec.ts at HEAD, Chromium 153                                                                                                                                                                                                                                             |
| CSS isolation: toolbar stock properties lost to host CSS, inline baseline                             | shadow: none 0 / Bootstrap 1 / Tailwind 0 / Tailwind layered 0. Light: 0 / 1 / 1 / 1. Rect button 58×23 base; light 59×28 (Bootstrap), 54×28 (both Tailwind). Bar 86 → 88 px in light DOM                                                                                                                                             | (element, property) pairs       | results/css-inline-baseline.json, ff30155. 16 stock properties per toolbar element. The 1s are the toolbar container's inherited colour (Bootstrap) and border-top-style from `*{border:0 solid}` (Tailwind), neither set by the stock UI                                       |
| CSS isolation: toolbar stock properties lost, layered stock sheet                                     | shadow: 0 / 1 / 0 / 0 (unchanged). Light: none 0; Bootstrap 15 (radius 7, font-size 7, colour 1), button 68×32, bar 92; unlayered Tailwind preflight 51 (border-style 8, padding-top 7, padding-left 7, radius 7, background 7, colour 7, font-weight 1, font-size 7), button 41×24, bar 88; layered Tailwind 1, button 54×28, bar 88 | pairs                           | results/review-fix.json (identical numbers in a second run at 14:26)                                                                                                                                                                                                            |
| CSS isolation: toolbar stock properties lost, unlayered class sheet (emulated)                        | light: none 0 / Bootstrap 1 / Tailwind 1 / Tailwind layered 1; buttons 59×28 / 54×28 / 54×28; bars 88                                                                                                                                                                                                                                 | pairs                           | lab.html?stock=unlayered adopts OSDLABEL_STOCK_RULES without the layer into the document, outranking the layered copy; same run                                                                                                                                                 |
| CSS isolation: whole annotator subtree                                                                | shadow 42/128 elements differ under each host stylesheet, no selector-matched property; light 127/127 under each. Pointer error 0.00 px in all 12 conditions; image-space geometry delta 1.86 (shadow) and 5.08 (light) px                                                                                                            | elements / px                   | 20 properties per element, same run; unchanged from the build run                                                                                                                                                                                                               |
| strict CSP probe                                                                                      | <style> element blocked; setAttribute('style') blocked; CSSOM el.style applied; constructed sheet adopted into the document applied; into a shadow root applied                                                                                                                                                                       | applied y/n                     | scripts/csp-probe.mjs, Chromium 153.0.8010.12, CSP `default-src 'self'; script-src 'unsafe-inline'; style-src 'self'`                                                                                                                                                           |
| strict CSP on the annotator                                                                           | 0 toolbar elements restyled in all 4 renderers; 0/121 annotator elements restyled overall; CSP violation reports per mount: solid 34, element-light 34, element-shadow 34, react 0                                                                                                                                                    | elements / reports              | parts.spec.ts, `style-src 'self'` added by route interception; 10 computed properties compared with the same page without CSP; the page's own styles moved to a CSS file                                                                                                        |
| controlled echo in the annotations setter: copy then compare (before) vs compare only (after), median | n=100: 0.57 → 0.056 (plain), 2.70 → 0.095 (proxied). n=1k: 7.82 → 0.54 (plain), 28.2 → 1.89 (proxied). n=10k: 105.3 → 9.7 (plain), 336.8 → 16.9 (proxied)                                                                                                                                                                             | ms                              | bench --only echo; Node 22.22, element dist functions; annotations with 36-key Fabric Rect raw data; 'proxied' wraps the input in a Vue-like deep re-wrapping Proxy; 40 reps (15 at 10k); excludes getAllAnnotationsFlat(store), which both orders pay. Max values in the JSON. |
| slot-contract mutation: StatusBar added to AnnotatorSlotPropsMap and ANNOTATOR_SLOT_NAMES             | tsc fails in solid, react and element (TS1360 'does not satisfy', TS2741 'Property StatusBar is missing'); runtime tests fail 2/8 (solid), 2/8 (react), 1/2 (element)                                                                                                                                                                 | errors / tests                  | osdlabel rebuilt; tsc -p tsconfig.tests.json per package; reverted afterwards                                                                                                                                                                                                   |
| slot-contract reverse mutation: table keys made optional                                              | TS2578 (unused @ts-expect-error) in all three test files                                                                                                                                                                                                                                                                              | errors                          | same packages; reverted                                                                                                                                                                                                                                                         |
| decorationProviders host matrix                                                                       | before the provider fix: vanilla 0, Angular 0, Vue 1, Svelte 1, React 19 1 decorations (3/5 pass); after: 5/5                                                                                                                                                                                                                         | decorations per drawn rectangle | hosts.spec.ts 'decorationProviders bound by the host'; createMeasurementProvider({area:true}); vanilla assigns after append, Angular binds after connect                                                                                                                        |
| Solid provider decorationProviders mutation check                                                     | old copy-at-mount: effect saw [0] instead of [0, 1] (fails); getter: passes                                                                                                                                                                                                                                                           | test                            | packages/solid/tests/unit/state/annotator-context.test.ts; mirrored in React                                                                                                                                                                                                    |
| React toolbar commands stale-closure mutation check                                                   | old closure: line selected despite its limit (fails); store-reading handlers: passes; Solid passes before and after                                                                                                                                                                                                                   | test                            | annotator-components tests in both bindings: in one batch (act / batch), add 2 lines (maxCount 2), then onSelectTool('line')                                                                                                                                                    |
| PoC E2E                                                                                               | 75/75                                                                                                                                                                                                                                                                                                                                 | tests                           | hosts 28, shadow-dom, theme 6, parts 21; 2 workers; vite build + preview; Chromium 153                                                                                                                                                                                          |
| existing dev E2E suites                                                                               | Solid: 170 passed, 1 skipped, 2 failed under load (convert-circle; context-scoping global counting), both 15/15 on a 3× rerun. React: 172 passed, 1 skipped                                                                                                                                                                           | tests                           | full apps/dev suite against both dev apps via a temporary, uncommitted config adding executablePath; load average 6-10                                                                                                                                                          |
| unit tests                                                                                            | osdlabel 334, solid 170, react 231, element 16, poc-element 5, all pass; typecheck passes for osdlabel, solid, react, element, poc-element, dev, dev-react                                                                                                                                                                            | tests                           | vitest; turbo typecheck                                                                                                                                                                                                                                                         |
| style inventory after the stylesheet move (Solid / React)                                             | inline style objects 53/38; declarations 345/215; colour literals 49/32; px literals 117/75; className 8/5; part 11/9; Toolbar.tsx 0 inline styles in each. Declarations: 26 only in Solid, 20 only in React, 87 shared                                                                                                               | count                           | scripts/inventory-styles.mjs (regex), 11 component files per binding                                                                                                                                                                                                            |
| diff vs origin/claude/segmentation-brush-tool: existing packages                                      | 36 files: 21 modified (+582 -376) and 15 newly created (+1428). Source 27 files +1067 -376; tests 9 files +943                                                                                                                                                                                                                        | files / lines                   | git diff --numstat at d573d2d; no package.json or turbo.json change in any existing package                                                                                                                                                                                     |
| diff: new code                                                                                        | packages/element 16 files +1243; apps/poc-element 53 files +3916 code plus 3 results JSON files (+5370 lines); branch total 109 files +13075 -378 including pnpm-lock (+536)                                                                                                                                                          | lines                           | same diff                                                                                                                                                                                                                                                                       |
| diff: this fix run                                                                                    | 58 files, +5644 -254                                                                                                                                                                                                                                                                                                                  | lines                           | git diff --shortstat 6c89556 d573d2d, including about 3.7k lines of committed results JSON                                                                                                                                                                                      |

## Recommendation

Two tiers for frameworks, and one shared UI contract for customisation. The contract is now enforced in every renderer.

(a) Frameworks beyond React and Solid: publish @osdlabel/element as a new leaf package.

- It is the hand-rolled custom element over @osdlabel/solid's <Annotator>, open shadow DOM by default, light DOM opt-in.
- Vue, Svelte, Angular and React 19 bind it with their own syntax. Ship type entry points only; write no Vue, Svelte or Angular bindings.
- Keep the React and Solid bindings as the deep-integration tier (hooks, composition, React SSR).

The element's measured rules:

- Structured inputs are properties; scalars are attributes.
- Inputs are copied to plain data, but only after the echo check (10-20× cheaper on the controlled echo).
- Echo rule: a write whose (imageId, id, updatedAt) set equals the current one is ignored, so a host edit must bump updatedAt. It is documented and E2E-pinned.
- No event is dispatched synchronously from connectedCallback.
- Event names are lowercase and dash-free.
- Every structured property is live after mount (decorationProviders included, which Angular needs). The test-mode attribute is read at mount.
- All element and stock CSS is installed as adopted constructed sheets, so it survives a strict `style-src` CSP.

(b) Customisation without drift, from osdlabel/src/ui (no new graph edge):

1. Design tokens `--osdlabel-*` with the old values as var() fallbacks. 4 of the 19 are reserved: no component reads them yet.
2. Part names plus class twins (`osdlabel-<part>`). The stock styles live in one shared stylesheet, OSDLABEL_STOCK_RULES, selecting on the classes. adoptStockStyles() adopts one constructed sheet per document into the document or the shadow root the UI mounts in: 0 head nodes, about 24 µs to build and about 0.35 ms to adopt, once per document.
   - Then `::part()` (shadow) and `[part~=]` / class selectors (light DOM) override any stock property in both bindings and the element.
   - Ship the rules unlayered (specificity 0,1,0) rather than in `@layer osdlabel`. Measured: the unlayered sheet keeps today's inline-level isolation in light DOM (1 property lost under Bootstrap, unlayered preflight and layered preflight). The layer lost 15 under Bootstrap and 51 under an unlayered preflight.
   - Hosts override with any selector above (0,1,0), e.g. `.my-app [part~="tool-button"]`. In shadow DOM the two are identical.
   - The PoC code ships the layer (OSDLABEL_STOCK_CSS), as the review asked; switching means dropping the wrapper.
   - Migrate the other 7 components the same way, which also removes the template style attributes that Solid compiles and that raise 34 CSP reports per mount.
3. Typed override slots. Each slot has a headless view-model in osdlabel (deriveXModel + XSlotProps), and AnnotatorSlotPropsMap is the shared props map.
   - The host side (AnnotatorComponents) is optional.
   - The renderer side is an exhaustive table in each renderer (Solid and React ANNOTATOR_SLOT_RENDERERS, the element's createElementSlots), declared with `satisfies` over AnnotatorSlotName, rendered through <AnnotatorSlot name>, with @ts-expect-error and runtime tests in each. A slot added to the map fails tsc in all three renderers until each renders it (mutation-verified).
   - Commands re-derive state at call time in both bindings (#217).

Run the shared dev E2E suite against a shadow-DOM element harness as a third CI target, plus a strict-CSP variant.

### New packages

- @osdlabel/element: <osdlabel-annotator> custom element (properties, attributes, CustomEvents, named slots via the exhaustive createElementSlots() table, commands); depends on @osdlabel/solid, osdlabel, @osdlabel/annotation, @osdlabel/annotation-context, @osdlabel/viewer-api, @osdlabel/decoration and solid-js. solid-js is a regular dependency, externalized in the package's own build: correcting the earlier report, the standalone fully bundled ESM build for <script type=module> use is proposed but not built. Peers: fabric, openseadragon. Nothing depends on it (a clean leaf).

### Changes to existing packages

- @osdlabel/fabric-osd: forwarded synthetic pointer events are `composed: true` (+5 lines).
- osdlabel: shadow-dom.ts (getEventOrigin, isFocusedInItsRoot, +40). New ui/ module: theme tokens (19, 4 reserved); OSDLABEL_PARTS (now including brush-options, brush-label, brush-radius, brush-radius-value) and partClassName(); deriveToolbarModel / ToolbarSlotProps; AnnotatorSlotPropsMap / ANNOTATOR_SLOT_NAMES (comment restated); stock-styles.ts (OSDLABEL_STOCK_RULES / OSDLABEL_STOCK_CSS / OSDLABEL_STYLE_LAYER, stockStyleTarget, adoptStockStyles, +130). About +559 source lines created, +32 export lines. Still to do: popover-placement's isInTopLayer should test :fullscreen instead of ownerDocument.fullscreenElement (untested in a fullscreen shadow root).
- @osdlabel/solid and @osdlabel/react, mirrored:
- annotator-slots.tsx (ANNOTATOR_SLOT_RENDERERS, AnnotatorSlot; +55 / +50) and the Annotator layout rendering through it.
- Toolbar renders from the shared model with classes and parts only, adopting the stock sheet on mount (Solid onMount, React useLayoutEffect).
- StatusBar and Annotator read tokens and carry parts.
- useKeyboard classifies getEventOrigin(e); Filmstrip uses isFocusedInItsRoot.
- shouldSkipKeyboardShortcutPredicate is documented as receiving the origin inside shadow roots.
  Solid only: the provider exposes decorationProviders through a getter, and ViewerCell reads it lazily, matching React's existing behaviour. React only: useToolbarSlotProps commands re-derive the model from store.getSnapshot() / getConstraintStatus(), matching Solid's live memo. Mirrored unit tests for each. Still to do: move the 7 remaining components (Solid 53 style objects / 345 declarations, React 38 / 215) to the shared sheet with tokens and parts, and add view-models and slots for them.
- apps/dev and apps/dev-react: unchanged; both full suites pass (React 172, Solid 170 plus 2 load flakes that pass on rerun). Recommended: a shadow-DOM element harness page and a strict-CSP run so the shared specs cover both.

### API sketch

```ts
// osdlabel/src/ui (framework-neutral)
export const OSDLABEL_THEME_TOKENS: {
  readonly surface: '#1a1a1a';
  readonly accent: '#2196F3'; /* 19; surfaceRaised, border, danger, shadowPopover reserved */
};
export function themeVar(t: OsdlabelThemeToken): string; // 'var(--osdlabel-accent, #2196F3)'
export function themeToCustomProperties(theme: OsdlabelTheme): Record<string, string>;
export const OSDLABEL_PARTS: {
  root;
  toolbarBar;
  toolbar;
  toolButton;
  toolButtonActive;
  toolButtonDisabled;
  brushOptions;
  brushLabel;
  brushRadius;
  brushRadiusValue;
  statusBar;
};
export function toolButtonPart(s: { active: boolean; enabled: boolean }): string; // 'tool-button tool-button-active'
export function partClassName(part: string): string; // 'osdlabel-tool-button osdlabel-tool-button-active'
export const OSDLABEL_STYLE_LAYER = 'osdlabel';
export const OSDLABEL_STOCK_RULES: string; // unlayered class rules, values are themeVar()s (recommended default)
export const OSDLABEL_STOCK_CSS: string; // the same inside @layer osdlabel (what the PoC ships)
export type StockStyleTarget =
  | { kind: 'shadow-root'; root: ShadowRoot }
  | { kind: 'document'; root: Document; detached: boolean };
export function stockStyleTarget(node: Node): StockStyleTarget | null;
export function adoptStockStyles(node: Node): void; // one constructed sheet per document, adopted per root; <style> fallback without constructable sheets
export function deriveToolbarModel(input: ToolbarModelInput): ToolbarModel;
export interface ToolbarSlotProps {
  readonly model: ToolbarModel;
  onSelectTool(t: ToolbarTool): void;
  onBrushRadiusChange(r: number): void;
  onBrushErasingChange(e: boolean): void;
  onConvertToRect(): void;
}
export interface AnnotatorSlotPropsMap {
  readonly Toolbar: ToolbarSlotProps; /* next: StatusBar, Filmstrip, ViewControls, GridControls, CellPlaceholder */
}
export type AnnotatorSlotName = keyof AnnotatorSlotPropsMap;
export const ANNOTATOR_SLOT_NAMES: Readonly<Record<AnnotatorSlotName, string>>;
export function getEventOrigin(e: Event): EventTarget | null;
export function isFocusedInItsRoot(el: Element): boolean;

// @osdlabel/solid (React identical with ComponentType)
export type AnnotatorComponents = {
  readonly [K in AnnotatorSlotName]?: Component<AnnotatorSlotPropsMap[K]> | undefined;
}; // host side: optional
export interface AnnotatorSlotRenderer<K extends AnnotatorSlotName> {
  readonly useProps: () => AnnotatorSlotPropsMap[K];
  readonly Stock: Component<AnnotatorSlotPropsMap[K]>;
}
export type AnnotatorSlotRendererTable = {
  readonly [K in AnnotatorSlotName]: AnnotatorSlotRenderer<K>;
}; // renderer side: exhaustive
export const ANNOTATOR_SLOT_RENDERERS = {
  Toolbar: { useProps: useToolbarSlotProps, Stock: ToolbarView },
} as const satisfies AnnotatorSlotRendererTable;
export function AnnotatorSlot<K extends AnnotatorSlotName>(props: {
  name: K;
  override: Component<AnnotatorSlotPropsMap[K]> | undefined;
}): JSX.Element;
// <Annotator images={...} contexts={...} decorationProviders={live} components={{ Toolbar: MyToolbar }} />

// @osdlabel/element
export type ElementSlotTable = {
  readonly [K in AnnotatorSlotName]: Component<AnnotatorSlotPropsMap[K]>;
};
export function createElementSlots(host: {
  shadow: boolean;
  emit: Emit;
  onToolbarProps(p: ToolbarSlotProps | undefined): void;
}): ElementSlotTable;
export function defineOsdlabelAnnotator(options?: {
  tagName?: string;
  shadow?: 'open' | 'none';
}): OsdlabelAnnotatorElementConstructor;
export interface OsdlabelAnnotatorElement extends HTMLElement {
  images;
  contexts;
  displayedContextIds;
  decorationProviders;
  keyboardShortcuts; // all live after mount
  /** Echo rule: a write with the same (imageId, id, updatedAt) set is ignored; bump updatedAt to edit. Compared before the copy. */
  annotations: readonly OsdAnnotation[];
  readonly activeTool;
  readonly selectedAnnotationId;
  readonly toolbarModel: ToolbarModel | null;
  readonly renderRoot: ShadowRoot | HTMLElement;
  setActiveTool(t): void;
  selectTool(t: ToolbarTool): void;
  setBrushRadius(r): void;
  setBrushErasing(e): void;
  convertSelectedToRect(): void;
  selectAnnotation(id): void;
  assignImageToCell(cell, imageId): void;
}
// attributes: show-filmstrip, show-grid-controls, show-context-switcher, show-view-controls, show-fullscreen-control, show-fps (live), filmstrip-position (live), test-mode (read at mount)
// events: annotationschange, selectedannotationchange, activetoolchange, constraintchange, toolbarmodelchange, osdlabelready (microtask)
// slots: <slot name="toolbar"> with the stock toolbar as fallback (shadow mode); parts: ::part(root | toolbar-bar | toolbar | tool-button | tool-button-active | tool-button-disabled | brush-options | brush-label | brush-radius | brush-radius-value | status-bar)
// :host CSS and stock CSS: adopted constructed sheets (strict-CSP safe)
```

### Effort

8-10 engineer-weeks in total:

- Element production-ready: 2-3 weeks. Standalone bundled build, per-framework type entry points (or generated from a Custom Elements Manifest), a DOM-callback form of renderDomDecoration, reflected attributes, live test-mode or documented mount-time inputs, and a host matrix in CI including Angular with zone.js.
- Shadow-DOM and CSP hardening: 1 week. Land the PoC fixes, the :fullscreen popover check, a shadow-DOM element harness running the shared dev E2E suite, a strict-CSP CI variant, and a lint rule against document.activeElement and window-listener e.target.
- Stock styles to the shared stylesheet, with tokens and parts across the 7 remaining components in both bindings: 2-2.5 weeks. Solid has 53 style objects / 345 declarations, React 38 / 215. Includes deciding layered vs unlayered and React SSR handling. Done for the toolbar in the PoC.
- View-models and slots for StatusBar, Filmstrip, ViewControls, GridControls and CellPlaceholder: 2-3 weeks. Each is a model in osdlabel, an entry in three renderer tables (the compiler now forces all three), and mirrored tests.
- Docs (theming, parts, slots, element, CSP) and TypeDoc: 0.5-1 week.

### Risks

- Light-DOM precedence: a layered stock sheet loses to unlayered host resets. Measured in light DOM: Bootstrap 5.3 overrides 15 toolbar properties (buttons 58×23 → 68×32 px); an unlayered Tailwind preflight overrides 51 (transparent, unpadded buttons). The recommended unlayered sheet avoids this, but host overrides then need specificity above (0,1,0), and a bare `[part~=]` rule silently loses. Document both.
- React SSR: with styles in an adopted sheet installed by useLayoutEffect, server-rendered toolbar markup has classes but no styles until hydration (a possible flash of unstyled toolbar). Inline styles rendered on the server; this was not measured.
- adoptStockStyles targets the owner document for a subtree mounted while detached. A detached subtree later moved into a shadow root would miss the sheet (a prototype limitation; it needs a re-adopt on connect).
- Strict CSP: Solid compiles static style objects into its templates' HTML style attributes, which raises 34 CSP violation reports per mount (Chromium still applies those styles; Firefox and Safari untested). Report endpoints would be flooded until the remaining components move to the sheet.
- Shadow-DOM regressions from future code reading a retargeted event.target, document.activeElement or document.fullscreenElement, or dispatching non-composed synthetic events. None of these show up in light-DOM E2E. Mitigation: a shadow-DOM harness in CI and a lint rule.
- Stock markup is still written twice (ToolbarView in Solid and React, about 110 lines each). The view-model, the stylesheet and the slot tables remove logic, style and contract drift, not markup drift.
- Echo rule: a host edit that keeps updatedAt is dropped silently (documented and E2E-pinned). A content-aware comparison would cost more (compare-only is 9.7 ms at 10k plain).
- Host reactivity: the `annotations` getter and the annotationschange detail hand out live Solid store proxies; a host mutation of them does nothing, and their values change underneath the host. Snapshots would cost O(n) per event (about 8 ms at 1k by the copy benchmark).
- Angular: only JIT and zoneless were tested. A zone.js app would run change detection on every OSD rAF and pointer event unless the element runs outside the zone (unmeasured).
- Startup: light DOM reached interactive before shadow DOM in 4/4 TTI runs (5-20%), while mount cost does not differ by more than about 0.5 ms; the cause is unexplained.
- Custom elements do not server-render the OSD and Fabric canvases; the React binding stays the SSR path.

## Rejected alternatives

- **Hand-written Vue, Svelte and Angular bindings next to React and Solid**: Each would be another parallel hand-maintained renderer. The two existing bindings still differ in 26 Solid-only and 20 React-only style declarations, and the review found a React-only stale-closure bug (fixed here, #217 class). The element covers all three hosts for +1.9 KiB gzip and a 0.2-0.6 ms mount overhead.
- **Keep inline stock styles and offer only --osdlabel-\* tokens (or !important) as light-DOM restyling**: Measured: [part~=] and class rules cannot override an inline-set property (0/3 light-DOM renderers before the change). The stylesheet costs about 24 µs to build, about 0.35 ms to adopt once per document, adds 0 head nodes, and is CSP-safe as an adopted sheet.
- **Stock stylesheet in @layer osdlabel as the light-DOM default (what the PoC code ships)**: Any unlayered host rule overrides it, but so does every unlayered host reset: Bootstrap 5.3 overrides 15 toolbar properties and an unlayered Tailwind preflight 51, against 1 for inline or an unlayered class sheet. It is fine under Tailwind 4 as it ships (layered) and identical in shadow DOM. Recommend the unlayered class-selector sheet instead; switching drops one wrapper.
- **Inject the stock CSS as a <style> element in document.head or the shadow root**: A strict `style-src 'self'` CSP blocks <style> elements (probe), and it adds DOM nodes. Constructed sheets adopted via adoptedStyleSheets apply under the same CSP and add none. <style> is kept only as the fallback where constructable sheets are missing (jsdom).
- **solid-element (component-register) as the element base**: A preference, not a refutation. Size ties (2.1 vs 2.5 KiB gzip wrapper), and component-register also defers teardown on disconnect. It loses on typing (`[prop: string]: any`, commands Object.assign'ed) and attribute handling (JSON.parse; a bare `test-mode` becomes undefined).
- **Light DOM as the element's default**: Re-weighted per the review. Inherited properties dominate the 127/127 count, and the visible effect is small (toolbar bar 86→88 px), the same exposure today's bindings carry. The stronger case for shadow DOM is named slots (overrides with no script) and selector isolation: host resets reach 0 toolbar properties in shadow DOM vs 15-51 in light DOM under a layered sheet. Light DOM stays opt-in.
- **Collapse React's stock UI onto the element (@osdlabel/react <Annotator> wrapping <osdlabel-annotator>, keeping the React provider and hooks as the headless tier)**: Deferred, not refuted. It would remove the duplicated ToolbarView markup. It costs a second runtime (React 19 page with the element 251.2 vs 241.3 KiB gzip for the React binding), loses React-context composition inside the annotator subtree, and gives up SSR of the stock UI. Revisit if markup drift persists after the view-models, shared stylesheet and slot tables.
- **Compile the stock components to several frameworks from one source (e.g. Mitosis)**: Not evaluated. It adds a compiler toolchain whose output must still be tested per framework. With the shared view-models, the shared stylesheet and exhaustive slot tables, the remaining duplication is the markup (about 110 lines per binding for the toolbar), which does not obviously justify it.
- **Rewrite the UI as Lit or Stencil web components with generated framework wrappers (the Ionic / Shoelace model)**: It rewrites every component and abandons or duplicates the Solid binding. The element already gives a standards-based surface by compiling the existing Solid UI.
- **Headless only (TanStack / Zag style): ship view-models and let each host render everything**: Every host would rebuild the toolbar, filmstrip, grid and view controls before it could annotate anything. Adopted as the override layer beneath the stock UI, not as the only product.
- **An OHIF-style customisation service (string-keyed global registry)**: Runtime string lookup, untyped, global mutable state. The per-instance components map plus exhaustive renderer tables is typed on both sides, and a missing renderer is now a compile error in every renderer (mutation-verified).

## Architectural stress

Existing files changed: 36; existing lines changed: 2386; new lines: 5159.

Against origin/claude/segmentation-brush-tool at d573d2d, existing packages changed in 36 files, +2010 -376 (2386 lines touched).

By file kind:

- 21 pre-existing files modified, +582 -376;
- 15 files newly created inside existing packages, +1428;
- source 27 files +1067 -376; tests 9 files +943.

By purpose:

- H2 shadow-DOM fixes (unchanged): +63 -4 (fabric-osd +5; osdlabel shadow-dom.ts +40; useKeyboard and Filmstrip in each binding).
- UI contract: osdlabel/ui tokens, parts, toolbar model, slot map, plus the new stock-styles.ts +130 and partClassName.
- Slot tables: annotator-slots.tsx +55 Solid / +50 React; the Annotator layout renders through them.
- Toolbar rewrites onto the shared model and stylesheet: Solid +156 -187, React +168 -148.
- Solid decorationProviders getter (annotator-context +15 -2, ViewerCell +6 -4).
- React store-reading toolbar commands.
- Predicate docs.

No package.json, turbo.json or pnpm-workspace change in any existing package, so the dependency graph is unchanged. The stylesheet lives in osdlabel, which both bindings already import.

New code: packages/element 16 files +1243; apps/poc-element 53 files +3916. new_lines counts those two directories excluding 3 committed results JSON files (+5370 lines). The branch total is 109 files +13075 -378, including +536 pnpm-lock. This fix run alone (6c89556..d573d2d) is 58 files +5644 -254, about 3.7k of it results JSON.

## Reproduce

```sh
pnpm exec turbo run build --filter=@osdlabel/element --filter=@osdlabel/react && pnpm --filter @osdlabel/poc-element bench -- --only sizes,tti,css,mount,echo --reps 7 --mount-pages 5 --port 5475

The default `--only` is sizes,tti,css; add mount (UI mount microbenchmark plus stylesheet costs) and echo (controlled-echo setter, Node) as shown. It writes apps/poc-element/results/bench-<timestamp>.json and latest.json and prints tables. `--stock-variants none` measures a checkout without the stylesheet. Use `--chromium <path>` or POC_CHROMIUM for desktop Chrome.

Strict-CSP probe: `node apps/poc-element/scripts/csp-probe.mjs [--chromium <path>]`.

E2E: `POC_CHROMIUM=<path> pnpm --filter @osdlabel/poc-element test:e2e`, 75 specs including parts.spec.ts (light-DOM overrides, layer vs unlayered, strict CSP).
```

## Caveats

- All timings come from a shared 4-core sandbox. The review-fix run started at load average 9.05 and ended at 7.78, with other agents running. TTI medians moved up to 2x between runs, so compare hosts only within one run. The quiet-machine rerun should replace them.
- Tile drawing ran on SwiftShader (CPU-emulated WebGL), so TTI includes emulated GPU work. The mount microbenchmark deliberately excludes OSD and WebGL (no image assigned).
- The unlayered stock-sheet numbers come from an emulation: the same rules adopted into the document without the layer, which outranks the layered copy. That is equivalent for light DOM, but the shipped code is the layered variant.
- CSS isolation uses full Bootstrap 5.3.8 CSS and the Tailwind 4.3.3 preflight file, both unlayered as before, plus a new 'tailwind-layered' condition reproducing what `@import "tailwindcss"` emits (layer order statement, preflight in @layer base). Tailwind utilities and other host CSS were not tested.
- The toolbar stock-property count compares 16 properties per toolbar element. A count of 1 under inline styles or the unlayered sheet is a property the stock UI does not set (the container's inherited colour, or border-style from `*{border:0 solid}`).
- CSP results are Chromium 153 only. Whether Firefox and Safari apply Solid's template style attributes under a strict CSP is untested.
- The echo microbenchmark runs in Node on synthetic annotations with 36-key Fabric data, using a Vue-like Proxy, not Vue itself. It excludes the store read (getAllAnnotationsFlat) that both orders pay.
- Only the toolbar moved to the stylesheet. The other 7 components still use inline styles, so part and class hooks do not override their properties in light DOM yet.
- Two Solid dev E2E tests failed once under load average about 10 (convert-circle; context-scoping global counting) and passed 15/15 on a 3× rerun. Both dev suites ran through a temporary, uncommitted Playwright config that only sets executablePath and 2 workers.
- The style inventory is regex-based and approximate to within a few.
- Research items (AG Grid, tldraw, Zag, TanStack, Annotorious) remain second-hand, as in the build run; the reviewer did not verify them.

## Open questions

- Light-DOM default for the stock stylesheet: unlayered class selectors (measured to keep today's isolation; host overrides need specificity above 0,1,0) or @layer osdlabel (any host rule wins, so do unlayered resets)? Or offer the layered variant as an opt-in for Tailwind-4-style layered hosts?
- React SSR: should the server render a <style> or <link> for OSDLABEL_STOCK_RULES (needs a CSP nonce) to avoid an unstyled toolbar before hydration? Measure it.
- Should the element default to `attachShadow({ mode: 'open', delegatesFocus: true })` so that host el.focus() and Tab land inside? Untested.
- Angular with zone.js: does the element need to run its OSD/Fabric listeners outside the zone (runOutsideAngular) to avoid change detection per rAF and per pointer event? Untested; only zoneless JIT was measured.
- Should the `annotations` getter and the annotationschange detail hand out snapshots instead of live Solid store proxies (an O(n) copy per event, about 8 ms at 1k)?
- Should the echo rule become content-aware (e.g. a revision counter or a geometry hash) so a host edit that forgets updatedAt is not silently dropped?
- Generate the per-framework type shims from a Custom Elements Manifest instead of hand-writing them?
- What causes the consistent 5-20% light-vs-shadow TTI gap when mount cost differs by at most 0.5 ms (image load, OSD/WebGL inside a shadow root, the probe)? Quiet-machine rerun with the mount benchmark as a control.
- Which slot comes next (StatusBar is the obvious one), now that each one costs a model plus one entry in each of the three renderer tables?
- Keep the UI contract in osdlabel/src/ui (no graph change) or move it to a new leaf @osdlabel/ui-contract that osdlabel re-exports?

## How the review was addressed

- BLOCKING 1 (slot contract not enforced; 'cannot drift' false). Fixed in ff30155.
- Solid and React each declare ANNOTATOR_SLOT_RENDERERS `as const satisfies AnnotatorSlotRendererTable` (`{ readonly [K in AnnotatorSlotName]: { useProps; Stock } }`, required keys). The Annotator layout renders through a generic <AnnotatorSlot name> that reads the table. Solid uses createComponent so the generic stays typed once the map has two slots.
- The element declares createElementSlots(): ElementSlotTable with `satisfies` and hands the whole table to <Annotator components>.
- Tests per renderer: an @ts-expect-error on a table missing Toolbar (built by destructuring the real table) and a runtime check that the table's keys equal ANNOTATOR_SLOT_NAMES. In the bindings, a loop over every slot name asserting that an override marker renders. E2E (theme.spec) checks the element's shadow root has a named <slot> per name.
- Evidence: the reviewer's exact mutation (StatusBar added to AnnotatorSlotPropsMap and ANNOTATOR_SLOT_NAMES, osdlabel rebuilt) now fails tsc in solid, react and element with TS1360 + TS2741 ('Property StatusBar is missing'). The runtime tests fail 2 (solid), 2 (react) and 1 (element). Reverse mutation (table keys optional): TS2578 unused @ts-expect-error in all three.
- The osdlabel comment is restated: the host side is optional, the renderer side exhaustive.
- BLOCKING 2 (part names are not light-DOM hooks because the stock UI is inline-styled). Chose option (1) for the toolbar (3eab134, 6c3490f) and measured it.
- Test written first: parts.spec.ts (803d92d) with an unlayered host stylesheet overriding background, padding and colour via `[part~=]`, a class, or ::part(). At the inline-styled commit it failed in solid, react and element-light (observed rgb(51, 51, 51) / 4px / white / active blue unchanged); element-shadow passed via ::part(). This reproduces the review.
- The change: the toolbar's styles moved into OSDLABEL_STOCK_CSS (`@layer osdlabel`, selecting on class twins of the part names). It is adopted as one constructed sheet per document into the document (light DOM) or the shadow root (adoptedStyleSheets), from both bindings' ToolbarView.
- Result: 8/8 across all four renderers, stock look unchanged; theme.spec 6/6.
- Re-measured costs: 0 <style> nodes added to document.head (unchanged), 1 adopted sheet in the document, 2 in the shadow root (host + stock, now 0 <style> nodes there). Sheet construct about 24 µs; adopt + recalc about 0.34-0.40 ms vs 0.11 ms for an empty sheet, once per document. UI mount unchanged in magnitude (1.5-2.2 ms).
- Isolation, re-measured: shadow DOM unchanged. Light DOM with the layer: unlayered resets win, Bootstrap 15 toolbar properties (buttons 58×23 → 68×32), unlayered Tailwind preflight 51, layered Tailwind 4 1 (same as inline).
- Also measured, as an emulated alternative: an unlayered class-selector sheet keeps inline-level isolation (1 everywhere) and passes scoped overrides (0,2,0), but bare (0,1,0) overrides lose the tie (9/9 variant tests).
- Conclusion: worth it. Recommend the unlayered variant. The other 7 components remain inline-styled, so this is proven for the toolbar only.
- (non-blocking) decorationProviders after connect, in 9215e34.
- Fix: the Solid provider exposes decorationProviders as a getter and ViewerCell reads it lazily, matching React.
- Host matrix: every host binds providers; a new test expects 1 decoration. Before the fix vanilla and Angular got 0; after, 5/5.
- Mirrored provider tests in both bindings; Solid's fails with the old copy ([0] vs [0, 1]).
- test-mode is documented as read at mount.
- (non-blocking) Copy-then-compare order, in 9215e34. The setter now compares first. bench --only echo: n=1k 7.82 → 0.54 ms plain and 28.2 → 1.89 ms proxied; n=10k 105 → 9.7 ms plain and 337 → 16.9 ms proxied.
- (non-blocking) updatedAt echo rule. Documented on the property and the setter; E2E-pinned (a +200 px move with the same updatedAt is ignored, with a bumped one applied).
- (non-blocking) TTI claim restated as no difference detectable at about ±15% (deltas across 4 runs: -2%, +9%, -13%, +8.6%). Added the requested mount microbenchmark: element overhead 0.2-0.6 ms.
- (non-blocking) H4 is now 'partial'. Light DOM was faster in 4/4 TTI runs (5-20%), but the mount benchmark shows at most about 0.5 ms difference, so the gap is not mount cost.
- (non-blocking) CSS-isolation weighting restated: inherited properties dominate; the case for shadow DOM rests on slots plus selector isolation.
- (non-blocking) H1b is now 'partial' (a preference), with component-register's deferred teardown acknowledged from its source.
- (non-blocking) React stale closure fixed (002f3b1): the commands read the store. The mirrored test fails on the old code.
- (non-blocking) shouldSkipKeyboardShortcutPredicate contract change documented in both providers and pinned by mirrored tests (13630d2).
- (non-blocking) Unused tokens marked as reserved (2f30388).
- (non-blocking) Accounting corrected: 36 existing files = 21 modified + 15 created; solid-js is a regular dependency, externalized in the package build; the standalone bundle is not built.
- (non-blocking) Not addressed beyond recording them as risks or open questions: popover isInTopLayer in a fullscreen shadow root, touch/vertex/wheel in shadow DOM, Angular zone.js, live store proxies in the getter and events, missed alternatives (CEM, Mitosis, delegatesFocus, collapsing React's UI onto the element).

## Independent review

A second agent re-ran the benchmark and tried to break the conclusions.

### Blocking findings

- **H3's anti-drift guarantee is false. The report and the code comment in packages/osdlabel/src/ui/annotator-slots.ts say that adding a slot to AnnotatorSlotPropsMap 'is a type error in every renderer until each one supports it'. This compile-time check is the mechanism behind the claim that the override contract 'cannot drift' (H3 verdict, recommendation (b) layer 3, rejection of the OHIF alternative).**
  - Evidence: Mutation check: I added `readonly StatusBar: { readonly text: string }` to AnnotatorSlotPropsMap and `StatusBar: 'status-bar'` to ANNOTATOR_SLOT_NAMES, rebuilt osdlabel, then ran `tsc -p tsconfig.tests.json` in packages/solid, packages/react and packages/element. All three exited 0. AnnotatorComponents is an optional mapped type, and each renderer reads only `components?.Toolbar` (Solid Annotator.tsx ToolbarSlot, React Annotator.tsx, element `components={{ Toolbar: ToolbarSlot }}`). A new slot is therefore accepted by the types and silently ignored by every renderer. The only forced edit is ANNOTATOR_SLOT_NAMES, which sits in the same osdlabel file. I reverted the change afterwards.
  - Required fix: Make each renderer consume the map exhaustively: a per-binding and per-element slot-renderer table declared `satisfies { readonly [K in AnnotatorSlotName]: ... }`, with the layout rendering through that table. Add a type-level test (`@ts-expect-error` on a table missing a key) in each binding and in the element. Until then, restate the claim as 'the props contract is shared; renderer coverage is not enforced'.
- **The recommendation says part names work in the framework bindings too: 'part names ... for ::part() and [part~=] light-DOM selectors'. In light DOM a [part~=] rule cannot override any property the stock components set inline, and they set almost everything inline. Only the element's ::part() works. The parity claim for layer 2 between the element and the React/Solid bindings is therefore unsupported. theme.spec.ts tests only the element, and only outline-color and letter-spacing, which are not set inline.**
  - Evidence: Chromium 153.0.8010.12, one button with inline `background-color: var(--osdlabel-control,#333); padding: 4px 10px` and part=tool-button. Inside a shadow root, `x-host::part(tool-button){background-color:red;padding:20px}` wins: rgb(255,0,0) and 20px, because the outer context beats the inner inline style. In light DOM, `[part~="tool-button"]{background-color:lime;padding:30px}` loses: rgb(51,51,51) and 4px. Script: /tmp/claude-0/-home-user-osdlabel/d2340e79-db4e-595c-a199-55b42694fb93/scratchpad/partcheck/check.mjs. The same applies to the element in shadow:'none' mode.
  - Required fix: Add a light-DOM test in both bindings that overrides an inline-set property (background, padding) through [part~=]. Then choose between two options. (1) Move the stock styles out of inline styles into a low-precedence stylesheet (`@layer osdlabel`, adoptedStyleSheets in the shadow root, one shared sheet for light DOM); this means re-measuring the 'nothing added to document.head' and isolation results, because inline-only styling is the reason nothing is injected today. (2) State plainly that in the bindings only the --osdlabel-\* tokens, or !important, can restyle the stock UI.

### Non-blocking findings

- decorationProviders written after connect are silently ignored. The Solid provider reads props.decorationProviders once at mount (annotator-context.tsx `decorationProviders: props.decorationProviders ?? []`). Angular creates and connects the element before applying property bindings (the PoC's own finding (a)), so `[decorationProviders]` in Angular would never render anything. My probe on the built lab page: providers set before append gave 1 decoration text; set after append gave 0, while `el.decorationProviders.length` still read 1. testMode, fullscreenTarget and renderDomDecoration are also read once. Neither the H1 host tests nor the api_sketch mention this. Make these inputs reactive or remount on write, and add a decoration check to the host matrix (Angular especially).
- The element deep-copies input before checking for the controlled echo: `toPlainData(value)` runs before `isSameAnnotationSet`. Every round trip therefore pays a full copy, even a no-op. Node microbench of copy plus compare, plain objects with about 35-key fabric raw data: n=100 0.5 ms, n=1000 9.5 ms median (p90 22.6), n=10000 135 ms median (p90 259). Reading through Vue proxies wrapping Solid store proxies costs more. Fix: compare first and copy only on a real change.
- Echo suppression is keyed only on (imageId, id, updatedAt), so a host edit that does not bump updatedAt is dropped silently. I verified it: moving a rectangle's origin +200 px through `el.annotations` with the same updatedAt left origin.x unchanged (365.1); with updatedAt bumped it applied (565.1). Document this as part of the contract or use a content-aware comparison.
- TTI 'no measurable cost' needs restating as 'no difference detectable at this machine's resolution, roughly ±15%'. Element vs Solid binding medians were -2% (representative run), +9% (their noisier run) and -13% (my run). The representative run was selected from several. TTI is dominated by image load and SwiftShader WebGL work, so it cannot resolve the element's own mount overhead. A repeated mount microbenchmark (performance.now around render, many reps) would measure that directly.
- H4 marked 'untested' undersells a consistent signal. In all three runs, light DOM reached interactive faster than shadow DOM on the same lab page: 461 vs 485, 620 vs 668, and my run 713 vs 762 ms, about 5-7%. It is still within each run's IQR, but the direction never flips. It deserves a quiet-machine rerun and a cause, for example comparing with and without the slot fallback or HOST_CSS.
- The CSS-isolation headline (127/127 in light DOM vs 42/128 in shadow DOM) reproduces, but inherited properties dominate it: line-height changed on 126 elements and font-family on 114. The visible effect measured is a 2 px taller toolbar bar and a layout shift; pointer error is 0.00 px. Today's React and Solid bindings already run in light DOM with this same exposure. The stronger case for shadow DOM is named slots plus selector isolation, and the report should weight its argument that way.
- The H1b refutation is overstated. component-register 0.8.8 also defers teardown by a microtask (`await Promise.resolve(); if (this.isConnected) return;`), and the PoC's own comment says it handles properties set before upgrade. So 'upgrade and disconnect semantics not under our control' is weak. 'Fewer features' reflects how the PoC scoped that variant, not a limit of solid-element. What remains is real but small: `any`-indexed typing and JSON-parsed attributes (bare attribute → undefined, verified in the source).
- Shadow-DOM gaps found but untested: popover-placement's isInTopLayer compares against ownerDocument.fullscreenElement, which is the host, so a popover opened inside a fullscreen shadow root walks past clipping ancestors of the host. Also untested in a shadow root: touch, vertex editing and wheel/zoom. The React binding's useKeyboard and Filmstrip shadow fixes have unit tests only, because the element wraps only the Solid binding.
- getEventOrigin changes what the public `shouldSkipKeyboardShortcutPredicate` receives in light-DOM hosts that use third-party web components (Shoelace, Material Web). It now gets the inner composed target instead of the component host, so a host predicate using `closest()` stops at that component's shadow root. The built-in text-entry check gets better, but the change to the contract should be documented and tested.
- Angular was tested only in JIT and zoneless mode. Zone.js apps, still most existing Angular apps, would run change detection on every OSD rAF and pointer event unless the element runs outside the zone. AOT is also untested. Bundle size and TTI for Angular overstate costs (as caveated), and the zone.js performance risk is not mentioned.
- Of the 19 tokens, 4 are defined but used by no component in either binding (surfaceRaised, border, danger, shadowPopover). ViewControls, GridControls, Filmstrip, ContextSwitcher and the other remaining components still hardcode colours, so a themed host gets a half-themed UI today. The report does note the 7 components remaining.
- React's useToolbarSlotProps handlers close over the rendered `model` and `selected`, whereas Solid reads the live memo. Two commands issued in one handler can see stale state in React. This small parity difference is the class CLAUDE.md #217 warns about.
- The `annotations` getter and the annotationschange detail hand hosts live Solid store proxies. A host's mutation of them silently does nothing, and their values change underneath the host. Consider handing out snapshots.
- Accounting nits: existing_files_changed=27 includes 9 files newly created inside existing packages; 18 pre-existing files were modified, excluding pnpm-lock. new_packages says solid-js is a 'bundled dependency', but the PoC's element build externalizes solid-js, and the standalone bundle does not exist yet.

### Claims checked

| Claim                                                                                                                                                 | Verdict    | Note                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Element adds +1.9 KiB gzip over the Solid binding (191.2 vs 189.3 KiB)                                                                                | holds      | Reproduced exactly with the bench: 690.3/191.2/159.7 vs 684.7/189.3/158.1 KiB. Builds are deterministic.                                                                                                                                                            |
| Time to first interactive cell for the element is within noise of the Solid binding (497 vs 507 ms)                                                   | overstated | My run: element 666 [597-739] vs Solid 764 [712-861] ms at load average ~14. Across three runs the element-minus-Solid delta was -2%, +9% and -13%. There is no systematic cost, but the resolution is about ±15%, and TTI cannot isolate the element's mount cost. |
| PoC E2E: 47/47 pass                                                                                                                                   | holds      | 47 passed (1.1 min) on sandbox Chromium 153.                                                                                                                                                                                                                        |
| With existing packages unchanged, 6/10 shadow-DOM checks pass vs 10/10 light; the failures are drag, decoration, inner text field and filmstrip focus | holds      | Mutation check: reverting composed:true, getEventOrigin and isFocusedInItsRoot, then rebuilding, gave exactly those 4 shadow failures and 10/10 in light DOM.                                                                                                       |
| The H2 fixes are +63 -4 source lines across 5 existing files plus 1 new 40-line file                                                                  | holds      | Checked with git numstat: fabric-osd 5, shadow-dom.ts 40, osdlabel index 1, useKeyboard 5/1 in each binding, Filmstrip 3/1 (React) and 4/1 (Solid).                                                                                                                 |
| Architecture stress: existing packages 27 files +1203 -355; new code 5925 lines (element 1117, poc-element 4808); branch 83 files +7664 -357          | holds      | git diff numstat against merge base 3233d2c, which is the segmentation-brush tip, confirms the figures. The 27 files are 18 modified plus 9 newly created inside existing packages. No package.json or turbo.json change in any existing package.                   |
| Existing dev E2E suites still pass after the changes (172 each)                                                                                       | holds      | I ran only a targeted subset covering the changed components (toolbar-focus, keyboard, filmstrip, constraints, convert-circle, segmentation-brush): 56/56 on Solid and 56/56 on React. I did not run the full suites.                                               |
| Unit tests: osdlabel 325, solid 162, react 223, element 14 all pass                                                                                   | holds      | Reproduced exactly with vitest.                                                                                                                                                                                                                                     |
| Adding a slot to AnnotatorSlotPropsMap is a compile error in every renderer until each supports it                                                    | wrong      | With a StatusBar slot added, Solid, React and the element all typecheck clean, and nothing renders the new slot.                                                                                                                                                    |
| Part names give ::part() and [part~=] light-DOM styling hooks in both bindings and the element                                                        | wrong      | ::part() from outside the shadow root beats inline styles. [part~=] in light DOM loses to the inline styles the bindings use, verified in Chromium 153.                                                                                                             |
| CSS isolation: light DOM 127/127 elements changed vs shadow 42/128; no selector-matched property in shadow; pointer error 0.00 px                     | overstated | The numbers reproduce exactly, including bar height 86→88 and geometry deltas of 1.86/5.08 image px. The light-DOM count is dominated by inherited properties, the visible effect is small, and the current bindings already carry this exposure.                   |
| H1: works in vanilla, Vue 3.5, Svelte 5, Angular 22 and React 19 with property inputs (images, contexts, annotations) and CustomEvents                | holds      | Verified for the stated inputs by the passing host specs. It does not extend to decorationProviders in Angular, where a write after connect is silently ignored (probe: 0 decorations).                                                                             |
| H1b: solid-element refuted vs hand-rolled                                                                                                             | overstated | Size is a tie. component-register also defers teardown and upgrades pre-set props. The real differences are `any` typing and JSON-parsed attributes, which supports a preference rather than a refutation.                                                          |
| Controlled round trip neither echoes nor rebuilds                                                                                                     | holds      | Passes in all four framework hosts. Two caveats: the deep copy runs before the equality check (about 10 ms per round trip at 1k annotations, 135 ms at 10k), and edits that keep updatedAt are dropped.                                                             |
| SwiftShader timings correctly labelled as CPU-side, not GPU                                                                                           | holds      | The report caveats SwiftShader, and its CDP metrics are CPU-side. No GPU claim is made.                                                                                                                                                                             |
| H4: shadow DOM startup cost untested                                                                                                                  | holds      | Fair, but three runs, including mine (713 light vs 762 shadow ms), consistently show light DOM 5-7% faster.                                                                                                                                                         |
| Research: AG Grid --ag-\* variables, tldraw TLComponents, Zag data-part, TanStack headless, Annotorious vanilla core plus wrappers                    | unchecked  | Second-hand and caveated. It matches my understanding, but I did not verify it.                                                                                                                                                                                     |

### Reviewer's rerun

I ran `pnpm exec turbo run build --filter=@osdlabel/element --filter=@osdlabel/react` (cache hit) and then `pnpm --filter @osdlabel/poc-element bench -- --port 5491` once, on Chromium 153.0.8010.12 headless with SwiftShader. Load average was about 7 at start and 13.7-14.1 during TTI.

Sizes (KiB raw / gzip / brotli) were identical to the report:

- solid-binding 684.7/189.3/158.1; element 690.3/191.2/159.7 (+1.9 gzip); solid-element 689.6/191.0/159.3 (+1.7); react-binding 852.6/240.5/201.2 (+51.2).
- Wrapper alone 6.0/2.3/2.1 vs 5.3/2.1/1.9.
- Own code: Solid 33.6, React 34.5 gzip.
- Host pages (gzip): vanilla 192.1, Vue 215.4, Svelte 204.0, Angular JIT 493.9, React 19 249.1.

TTI, median [p25-p75] ms, 7 reps, cold context:

- Solid binding 764 [712-861]; element (shadow) 666 [597-739]; lab shadow 762 [759-798]; lab light 713 [623-786]; solid-element 847 [777-934].
- Vue 816 [791-883]; Svelte 816 [736-895]; Angular JIT 1160 [1107-1260]; React 19 element 789 [725-870].
- Element-ready medians: Solid 208, element 227, Angular 621. Script-time medians: 375-663 ms.
- The absolute values are about 50% higher than the representative run, and the host order differs (the element was faster than Solid here). Host-to-host differences are noise at this load.

CSS isolation was identical to the report:

- Shadow: 42/128 elements changed under both Bootstrap and Tailwind, with no selector-matched property.
- Light: 127/127, with box-sizing and vertical-align changed by selectors, plus border-top-style and padding under Tailwind. Toolbar bar 88 px vs 86 px base.
- Pointer error 0.00 px in all 6 conditions; geometry delta 1.86 (shadow) and 5.08 (light) image px.

Also run:

- PoC E2E: 47/47.
- Unit tests: osdlabel 325, solid 162, react 223, element 14.
- H2 mutation (fixes reverted): shadow 6/10 with exactly the 4 claimed failures, light 10/10.
- Dev E2E subset: 56/56 Solid, 56/56 React.
- Slot-map mutation: all renderers typecheck.
- Part-vs-inline cascade probe; late decorationProviders probe (1 vs 0 decorations); same-updatedAt edit probe (dropped); copy-cost microbench (9.5 ms at 1k, 135 ms at 10k).

The worktree was left clean at 6c89556.

### Alternatives the reviewer says were missed

- Collapse React's stock UI onto the single Solid-rendered UI. @osdlabel/react's <Annotator> would become a thin wrapper over <osdlabel-annotator> (React 19 binds custom elements natively, which the PoC verified), while the React provider and hooks stay as the headless tier. This is the direct fix for the stock-markup drift the question is about, which the report concedes remains (ToolbarView is written twice). Costs to weigh: a second runtime (React 19 page with the element is 249.1 vs 240.5 KiB gzip for the React binding), losing React-context composition inside the annotator subtree, and SSR.
- Ship the stock styles as a stylesheet in a cascade layer instead of inline styles: adoptedStyleSheets in the shadow root, and one shared sheet or importable CSS file for light DOM. This lets [part~=] and class overrides work in the bindings without !important. It trades against the current 'nothing injected into document.head' property and should be measured.
- Exhaustive slot-renderer tables (`satisfies { [K in AnnotatorSlotName]: ... }`) in each binding and the element, so that the drift guarantee the report claims actually holds.
- Compiling the stock components from one source to several frameworks (e.g. Mitosis) as a middle ground between hand-written bindings and the custom element. Worth a sentence in the rejected list.
- Generating framework type shims and wrappers from a Custom Elements Manifest (CEM analyzer plus wrapper generators) instead of hand-writing Vue, Svelte, React and Angular type entry points.
- `attachShadow({ mode: 'open', delegatesFocus: true })`, so that host-side `el.focus()` and Tab land inside the annotator.
- For Angular, testing with zone.js and documenting or applying a run-outside-the-zone pattern. Zoneless JIT was the only configuration measured.
