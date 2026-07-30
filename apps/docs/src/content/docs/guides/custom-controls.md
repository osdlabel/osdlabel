---
title: Custom Drag Controls
description: Drive viewer functions with mouse drag using the customControl overlay mode
---

Some viewer functions are easier to operate by **dragging** than by clicking discrete buttons — adjusting exposure is the obvious example. osdlabel supports this through a dedicated overlay interaction mode, `customControl`, which forwards raw pointer events to a handler you supply instead of letting OpenSeadragon or the Fabric annotation layer consume them.

## The three overlay modes

`FabricOverlay` routes pointer input through an OSD `MouseTracker`. Its mode selects who owns the mouse:

| Mode            | OSD navigation | Fabric annotation | Pointer events go to                   |
| --------------- | -------------- | ----------------- | -------------------------------------- |
| `navigation`    | ✅ enabled     | display-only      | OSD (pan / zoom)                       |
| `annotation`    | disabled\*     | ✅ active         | Fabric (select / move / draw)          |
| `customControl` | disabled       | inert             | your registered `CustomControlHandler` |

\* In `annotation` mode, `Ctrl`/`Cmd`+drag still passes through to OSD for panning.

In `customControl` mode every pointer event is captured and handed to your handler; OSD does not pan and Fabric objects are non-interactive. `Ctrl`/`Cmd`+scroll still zooms the image, so users don't lose zoom while a control is engaged.

## The handler contract

```ts
import type { CustomControlHandler, CustomControlEvent } from 'osdlabel';

interface CustomControlEvent {
  readonly originalEvent: PointerEvent; // raw DOM event (has buttons, modifiers…)
  readonly screenPoint: Point; // CSS px relative to the viewer element
  readonly imagePoint: Point; // image-space, flip-aware
}

interface CustomControlHandler {
  onPointerDown?(event: CustomControlEvent): void;
  onPointerMove?(event: CustomControlEvent): void;
  onPointerUp?(event: CustomControlEvent): void;
}
```

`onPointerMove` fires on **every** pointer move while the mode is active, regardless of button state, so a drag-based handler must track whether a press is in progress.

Register (or clear) the handler on the overlay:

```ts
overlay.setCustomControlHandler(handler);
overlay.setMode('customControl');
// …later
overlay.setCustomControlHandler(null);
```

## `createDragValueControl`

For the common case — map drag distance onto a clamped number — use the built-in factory rather than writing the gesture bookkeeping yourself:

```ts
import { createDragValueControl } from 'osdlabel';

const handler = createDragValueControl({
  getValue: () => currentExposure, // read at pointer-down
  setValue: (v) => setExposure(v), // called continuously during drag
  axis: 'x', // 'x' (default) or 'y'
  invert: true, // flip which way counts as "more"
  sensitivity: 0.01, // value-units per CSS pixel (keep positive)
  step: 0.025, // resolution of change (omit for continuous)
  min: -1,
  max: 1,
});
```

It captures the starting value on `pointerdown`, then on each move sets `startValue + delta * sensitivity`, optionally quantized to `step` (the resolution of change) and clamped to `[min, max]`. By default the x-axis increases rightward and the y-axis increases upward; `invert` reverses that, which keeps direction separate from the sensitivity magnitude rather than expressing it as a negative sensitivity. It is framework-agnostic and side-effect-free apart from your `getValue`/`setValue`, and it is defensive about lost pointer captures: a move with no button held (e.g. a dropped `pointercancel`) disarms the drag so hovering can't keep mutating the value. Redundant writes are skipped, so holding at a clamp boundary doesn't spam `setValue`.

## How the bundled UI wires exposure and contrast

The Solid and React `ViewControls` expose two drag-to-adjust toggles — one for exposure, one for contrast. Selecting either sets a UI field, `activeViewerControl` (`'exposure' | 'contrast'`), which is **mutually exclusive** with the active annotation tool and with the other control — picking a tool exits the control and vice versa, and arming one control disarms the other. The single mode-authority effect in `useAnnotationTool` resolves the overlay mode by precedence (`customControl` > `annotation` > `navigation`) and registers a `createDragValueControl` handler for the armed control.

The drag parameters for both controls live in one shared registry, `VIEWER_CONTROL_SPECS`, so Solid and React can't drift apart:

| Control    | Axis                        | Sensitivity | Step    | Range  |
| ---------- | --------------------------- | ----------- | ------- | ------ |
| `exposure` | `x`, inverted (left = more) | `0.01`      | `0.025` | −1 … 1 |
| `contrast` | `y` (up = more)             | `0.01`      | `0.025` | −1 … 1 |

The two controls deliberately occupy different axes: horizontal drag is exposure, vertical drag is contrast.

Each control reads the active cell's current value from the registry's `getValue` and dispatches `setActiveImageExposure` / `setActiveImageContrast` on drag. The `SET_EXPOSURE` / `SET_CONTRAST` reducers store the value faithfully, so the control owns the resolution rather than the reducer snapping to a coarser grid.

Both values also have discrete button and keyboard steps of `0.1` (`Shift+E` / `Shift+D` for exposure, `Shift+C` / `Shift+X` for contrast) and are cleared by `Reset` (`Shift+0`). They are rendered as CSS filters on OSD's drawer canvas in a fixed order — `brightness()`, then `contrast()`, then `invert()` — composed by the pure `composeImageFilterCss` helper.

## Behavior notes

- **No `Ctrl`/`Cmd`+drag pan in `customControl`.** Unlike annotation mode, `customControl` swallows all pointer drags. To pan, exit the control first; `Ctrl`/`Cmd`+scroll zoom remains available.
- **Switching the active cell keeps the control armed.** `activeViewerControl` is not cleared on cell change — the drag simply retargets the newly active cell. Selecting a tool, or toggling the control off, exits it.

## Adding your own viewer control

To add another drag-driven function: give it a `ViewerControlId`, add its drag parameters to `VIEWER_CONTROL_SPECS`, map the id to the action that writes its value in `useAnnotationTool`, and add a toggle to your toolbar that calls `setActiveViewerControl(id)`.
