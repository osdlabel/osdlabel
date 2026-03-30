---
title: Full Documentation (LLM)
description: Complete osdlabel documentation in a single page for LLM consumption
sidebar:
  hidden: true
---

# Installation

## Install the package

The main `osdlabel` package includes the complete SolidJS UI and re-exports all core logic. For most projects, this is the only package you need to install.

<PackageManagers pkg="osdlabel" pkgManagers={['npm', 'pnpm', 'yarn', 'bun', 'deno']} />

*Note: `osdlabel` is built as a modular monorepo. If you are building a custom UI or using a different framework, you can install the underlying packages individually (e.g., `@osdlabel/annotation`, `@osdlabel/fabric-osd`). See [Packages & Architecture](/osdlabel/guides/packages-and-architecture/) for details.*

## Bundler setup

osdlabel is an ESM-only package. It comes pre-compiled with SolidJS optimized JavaScript, so your bundler does not need to handle its JSX.

## TypeScript

osdlabel ships with full TypeScript declarations. No `@types` packages needed.

## Next steps

See the [Quick Start](/osdlabel/getting-started/quick-start/) guide to create your first annotator.

---

# Quick Start

This guide walks you through setting up a minimal annotation interface with osdlabel.

<MinimalViewerDemoWrapper />

## 1. Define your images

Create an array of `ImageSource` objects. Each image needs a unique branded ID and a URL (DZI or standard image).

```tsx

const images: ImageSource[] = [
  {
    id: createImageId('sample-1'),
    tileSource: 'https://openseadragon.github.io/example-images/highsmith/highsmith.dzi',
    label: 'Highsmith',
  },
  {
    id: createImageId('sample-2'),
    tileSource: 'https://openseadragon.github.io/example-images/duomo/duomo.dzi',
    label: 'Duomo',
  },
];
```

## 2. Define annotation contexts

Contexts define which tools are available and their constraints. Each context represents a labelling task (e.g., marking a specific pathology).

```tsx

const contexts: AnnotationContext[] = [
  {
    id: createAnnotationContextId('default'),
    label: 'Default',
    tools: [
      { type: 'rectangle' },
      { type: 'circle' },
      { type: 'line' },
      { type: 'point' },
      { type: 'path' },
      { type: 'freeHandPath' },
    ],
  },
];
```

## 3. Render the Annotator

The `Annotator` component provides a complete annotation interface with toolbar, grid view, filmstrip, and status bar.

```tsx

initFabricModule();

function App() {
  return (
    <div style={{ width: '100vw', height: '100vh' }}>
      <Annotator
        images={images}
        contexts={contexts}
        filmstripPosition="left"
        maxGridSize={{ columns: 4, rows: 4 }}
        showGridControls
        showFilmstrip
        showViewControls
        showFps
        onAnnotationsChange={(annotations) => {
          console.log('Annotations:', annotations.length);
        }}
      />
    </div>
  );
}

render(() => <App />, document.getElementById('app')!);
```

## 4. What you get

The `Annotator` component provides a standard layout using the following built-in components:

- **Toolbar** — Tool selector that respects context constraints, showing which tools are available and their usage counts
- **Grid View** — One or more image viewers in a configurable grid
- **Filmstrip** — Sidebar for assigning images to grid cells
- **Status Bar** — Shows the active context, tool, and annotation count
- **Grid Controls** — Optional visual selector for resizing the grid (Table Selector)
- **Context Switcher** — Optional dropdown for switching between different annotation tasks

All these components are also available individually for building custom layouts with `AnnotatorProvider`.

## 5. Interact with annotations

Click on a drawing tool in the toolbar (or press a keyboard shortcut like `r` for rectangle), then draw on the image. Annotations can be selected, moved, resized, and rotated after creation.

Use `Ctrl`/`Cmd` + drag to pan, and `Ctrl`/`Cmd` + scroll to zoom while in annotation mode.

## Next steps

- Learn about [Core Concepts](/osdlabel/getting-started/concepts/) — coordinate systems, the overlay model, and branded types
- See the [Annotation Contexts](/osdlabel/guides/annotation-contexts/) guide for constraint configuration
- Explore [Multiple Annotation Contexts](/osdlabel/examples/multiple-contexts/) for a complex real-world setup
- Build a custom UI with the [Custom Toolbar](/osdlabel/examples/custom-toolbar/) example

---

# Core Concepts

## Architecture overview

`osdlabel` is built as a layered monorepo of 7 separate packages, ensuring that the core data model and generic utilities have **zero framework dependencies**. The architecture is composed of three main layers:

1. **OpenSeaDragon** — Manages the DZI/tiled image viewer, handling pan, zoom, and tile loading
2. **Fabric.js overlay** — A transparent Fabric.js canvas positioned on top of each OSD viewer, synchronized on every animation frame (via `@osdlabel/fabric-osd`)
3. **SolidJS state & UI** — Reactive stores that drive the UI, tool selection, constraints, and annotation data (the main `osdlabel` package)

For full details on how the packages are split, see the [Packages & Architecture](/osdlabel/guides/packages-and-architecture/) guide.

The overlay's job is to compute a `viewportTransform` matrix that maps **image-space** coordinates to **screen-space**, so annotations stored in image pixels render correctly at any zoom level.

## Coordinate systems

osdlabel uses four coordinate systems:

| System            | Origin                       | Units                    | Usage                             |
| ----------------- | ---------------------------- | ------------------------ | --------------------------------- |
| **Image-space**   | Top-left of full-res image   | Pixels                   | Annotation geometry storage       |
| **OSD Viewport**  | Top-left of viewport         | Image width = 1.0        | OSD internal calculations         |
| **Screen-space**  | Top-left of browser viewport | CSS pixels               | Mouse events, element positioning |
| **Fabric canvas** | Same as screen-space         | CSS pixels (transformed) | Rendering via `viewportTransform` |

All annotation geometry (`Geometry` type) is stored in **image-space**. You never need to convert coordinates manually — the overlay handles the transform between image-space and screen-space automatically.

## Branded ID types

osdlabel uses TypeScript branded types for IDs to prevent accidental mixing:

```ts
type AnnotationId = string & { readonly __brand: unique symbol };
type ImageId = string & { readonly __brand: unique symbol };
type AnnotationContextId = string & { readonly __brand: unique symbol };
```

You cannot pass a plain `string` where a branded ID is expected. Use the factory functions:

```ts

const imageId = createImageId('my-image');
const annotationId = createAnnotationId('ann-1');
const contextId = createAnnotationContextId('ctx-1');
```

## Annotation contexts

A context represents a single annotation task — for example, "mark fractures" or "outline pneumothorax." Each context defines:

- **Label** — Human-readable name
- **Tools** — Which drawing tools are available, optionally with count limits
- **Image scoping** — Optionally restrict the context to specific images
- **Count scope** — Whether limits apply per-image or globally

Only one context is active at a time. Switching contexts changes which tools are available in the toolbar.

## The overlay model

Each grid cell contains an OpenSeaDragon viewer with a `FabricOverlay` on top. The overlay operates in two modes:

- **Navigation mode** — OSD handles all mouse input (pan/zoom). Fabric is display-only.
- **Annotation mode** — Fabric handles mouse input (draw/select/edit). OSD navigation is disabled, except for `Ctrl`/`Cmd`+drag (pan) and `Ctrl`/`Cmd`+scroll (zoom).

The active cell is in annotation mode; all other cells are in navigation mode.

## State management

osdlabel uses three SolidJS stores:

| Store               | Contents                                                                         |
| ------------------- | -------------------------------------------------------------------------------- |
| **AnnotationState** | All annotations organized by image ID                                            |
| **UIState**         | Active tool, active cell, grid dimensions, grid assignments, selected annotation |
| **ContextState**    | Available contexts and the active context ID                                     |

State is accessed via the `useAnnotator()` hook and mutated through named action functions. Components never modify stores directly.

## Reactivity model

SolidJS components run **once** to set up the view. Updates happen through signals and effects, not re-renders. This is critical for 60fps overlay synchronization:

- `createEffect` synchronizes imperative libraries (OSD, Fabric) with reactive state
- `createMemo` derives constraint status from annotation counts and context limits
- The toolbar reads derived constraint state reactively — no imperative enable/disable logic

---

# Packages & Architecture

`osdlabel` is decomposed into a layered monorepo of 7 packages with clear dependency boundaries. This architecture ensures that core logic remains framework-agnostic while still providing a seamless, fully-integrated UI layer.

## The 7 Packages

### `@osdlabel/annotation`
Pure annotation data model with **zero framework dependencies**.
- Contains branded ID types (`AnnotationId`, `ImageId`), geometry discriminated unions, the generic `Annotation<E>` type, and basic sanitization utilities.
- Pluggable serialization system (`createAnnotationValidator`, `ExtensionValidator<E>`).
- Depends only on `@standard-schema/spec` (types-only).

### `@osdlabel/viewer-api`
Viewer state types with **zero framework dependencies**.
- Contains types like `CellTransform`, `UIState`, and `KeyboardShortcutMap`.
- Depends only on `@osdlabel/annotation`.

### `@osdlabel/annotation-context`
Annotation context, constraints, and scoping logic.
- Defines `AnnotationContext`, `ToolConstraint`, and the `ContextFields` extension interface.
- Contains validation and scoping utilities.
- Depends only on `@osdlabel/annotation`.

### `@osdlabel/validation`
Valibot schema implementations for rigorous data validation.
- Implements the Standard Schema interface for annotation types (`GeometrySchema`, `PointSchema`, `BaseAnnotationSchema`).
- Depends on `@osdlabel/annotation` and `valibot`.

### `@osdlabel/fabric-annotations`
Fabric.js annotation tools and utilities, completely **SolidJS-agnostic and OSD-agnostic**.
- Contains all tool implementations (`RectangleTool`, `CircleTool`, `FreeHandPathTool`, etc.).
- Defines the `ToolOverlay` interface and `FabricFields` extension interface.
- Depends on `@osdlabel/annotation`, `@osdlabel/annotation-context`, `@osdlabel/viewer-api`, and `fabric`.

### `@osdlabel/fabric-osd`
The overlay bridge connecting Fabric.js and OpenSeaDragon.
- Implements the `FabricOverlay` class, handling coordinate transformations and pointer event routing.
- **SolidJS-agnostic**.
- Depends on the core packages, `fabric`, and `openseadragon`.

### `osdlabel`
The final SolidJS annotator UI layer.
- Re-exports and composes all the above packages.
- Contains the reactive state stores, hooks (`useAnnotator`, `useConstraints`), and components (`Annotator`, `ViewerCell`, `Toolbar`, etc.).
- The `OsdAnnotation` type is composed here by intersecting `BaseAnnotation` with `ContextFields` and `FabricFields`.

---

## Import structure

For most applications, importing directly from the main `osdlabel` package is the quickest and easiest way to get started. `osdlabel` provides ESM-friendly sub-path exports.

### 1. Main barrel
Recommended for quick starts. Re-exports the primary components and functions.

```ts

```

### 2. Sub-path barrels
Preferred for better build performance and tree-shaking in production apps.

```ts

```

### 3. Direct Package Imports
For advanced usage, you can import types and core logic directly from the granular packages. This is particularly useful if you are building a custom UI layer instead of using the SolidJS components.

```ts

```

---

# Components

osdlabel provides a set of SolidJS components that you can compose to build your annotation interface. All components must be used within an `AnnotatorProvider`.

## Main components

### Annotator

The `Annotator` component is an all-in-one solution that includes a toolbar, grid view, filmstrip, and status bar. It's the quickest way to get started if you want a complete, out-of-the-box layout.

```tsx

<Annotator
  images={images}
  contexts={contexts}
  showContextSwitcher={true}
  filmstripPosition="left"
  onAnnotationsChange={(anns) => console.log(anns.length)}
/>
```

### AnnotatorProvider

The `AnnotatorProvider` is the context provider that manages all state stores. Use this when you want to build a custom layout instead of using the default `Annotator`.

```tsx

<AnnotatorProvider onAnnotationsChange={(anns) => saveAnnotations(anns)}>
  <Toolbar />
  <GridView columns={2} rows={1} maxColumns={4} maxRows={4} images={images} />
  <StatusBar imageId={activeImageId()} />
</AnnotatorProvider>
```

## Viewers & Grid

### ViewerCell

A single OpenSeaDragon viewer with a Fabric.js overlay. This is the core rendering component. Used internally by `GridView`, but can be used directly for custom layouts.

```tsx

```

### GridView

A configurable MxN grid layout of `ViewerCell` components.

```tsx

<GridView columns={2} rows={2} maxColumns={4} maxRows={4} images={images} />
```

## UI Controls

### Toolbar

A tool selector that respects the active context's constraints and shows available tools with count indicators.

```tsx

```

### Filmstrip

A thumbnail sidebar for assigning images to grid cells. Clicking a thumbnail assigns that image to the active cell.

```tsx

<Filmstrip images={images} position="left" />
```

### StatusBar

Displays the active context, tool, and annotation count for the current image.

```tsx

<StatusBar imageId={activeImageId()} />
```

### ContextSwitcher

A dropdown for switching between available annotation contexts.

```tsx

<ContextSwitcher label="Task:" />
```

### GridControls

UI controls for adjusting grid dimensions (columns and rows).

```tsx

<GridControls maxColumns={4} maxRows={4} />
```

---

# State Management & Hooks

osdlabel is built on SolidJS and uses a reactive state model. State is managed via context providers and accessed through custom hooks.

## State Architecture

osdlabel uses three internal SolidJS stores:

| Store               | Contents                                                                         |
| ------------------- | -------------------------------------------------------------------------------- |
| **AnnotationState** | All annotations organized by image ID                                            |
| **UIState**         | Active tool, active cell, grid dimensions, grid assignments, selected annotation |
| **ContextState**    | Available contexts and the active context ID                                     |

All of these stores are provided to the component tree via the `AnnotatorProvider`.

## `useAnnotator`

The primary hook for accessing all annotation state and actions. Must be used within an `AnnotatorProvider`.

```ts

function MyComponent() {
  const { annotationState, uiState, actions } = useAnnotator();

  // Read state
  console.log('Active tool:', uiState.activeTool);

  // Mutate state using actions
  return (
    <button onClick={() => actions.setActiveTool('rectangle')}>
      Select Rectangle Tool
    </button>
  );
}
```

### Mutating State

You **must never** modify the stores directly. All mutations must go through the provided `actions` object returned by `useAnnotator()`.

The `actions` object provides methods for:
- **Annotations**: `addAnnotation`, `updateAnnotation`, `deleteAnnotation`, `loadAnnotations`
- **UI**: `setActiveTool`, `setActiveCell`, `setSelectedAnnotation`, `assignImageToCell`, `setGridDimensions`
- **Contexts**: `setContexts`, `setActiveContext`, `setDisplayedContexts`

## `useConstraints`

A convenience hook for checking tool availability based on the active context's constraints.

```ts

function MyToolbar() {
  const { isToolEnabled } = useConstraints();

  return (
    <div>
      <button disabled={!isToolEnabled('rectangle')}>Rectangle</button>
      <button disabled={!isToolEnabled('circle')}>Circle</button>
    </div>
  );
}
```

## `useKeyboard`

Sets up keyboard shortcut handling. This is called automatically by `AnnotatorProvider`, so you usually don't need to call it directly unless you are building a completely custom provider setup.

```ts

```

---

# Annotation Contexts

## What is a context?

An annotation context defines a scope where annotations exist — for example, multiple annotation and labelling tasks. Each context specifies which drawing tools are available and optionally limits how many annotations of each type can be created.

Annotation contexts are an extension of the core Annotation model, and are defined in the `@osdlabel/annotation-context` package.

Only one context is active at a time.

<MultipleContextsDemoWrapper />

## Defining contexts

```tsx

const contexts: AnnotationContext[] = [
  {
    id: createAnnotationContextId('buildings'),
    label: 'Buildings',
    // Only annotate buildings in specific regions
    imageIds: [createImageId('sample-1'), createImageId('sample-2')],
    tools: [
      // Up to 10 building outlines per image
      { type: 'rectangle', maxCount: 10, countScope: 'per-image' },
      // Up to 5 freehand boundaries total for irregular shapes
      { type: 'path', maxCount: 5 },
    ],
  },
  {
    id: createAnnotationContextId('roads'),
    label: 'Roads',
    tools: [
      // Trace road segments with lines
      { type: 'line', maxCount: 20, countScope: 'per-image' },
      // Mark intersections
      { type: 'point', maxCount: 15 },
    ],
  },
  {
    id: createAnnotationContextId('landmarks'),
    label: 'Landmarks',
    tools: [
      { type: 'rectangle' },
      { type: 'circle' },
      { type: 'line' },
      { type: 'point' },
      { type: 'path' },
      { type: 'freeHandPath' },
    ],
  },
];
```

## Tool constraints

Each tool in a context can have:

| Property       | Type                       | Default       | Description                                                                          |
| -------------- | -------------------------- | ------------- | ------------------------------------------------------------------------------------ |
| `type`         | `ToolType`                 | (required)    | `'rectangle'` \| `'circle'` \| `'line'` \| `'point'` \| `'path'` \| `'freeHandPath'` |
| `maxCount`     | `number`                   | unlimited     | Maximum number of annotations of this type                                           |
| `countScope`   | `CountScope`               | `'global'`    | Whether `maxCount` applies per-image or globally across all images                   |
| `defaultStyle` | `Partial<AnnotationStyle>` | default style | Override the default stroke/fill for this tool                                       |

When a tool's `maxCount` is reached, it is automatically disabled in the toolbar and via keyboard shortcuts.

## Count scope

The `countScope` property controls how annotations are counted against `maxCount`:

- **`'global'`** (default) — Counts all annotations of this type across all images
- **`'per-image'`** — Counts annotations per image independently

```tsx
{
  type: 'line',
  maxCount: 3,
  countScope: 'per-image', // Each image can have up to 3 lines
}
```

## Image scoping

A context can be restricted to specific images using the `imageIds` property:

```tsx
{
  id: createAnnotationContextId('context1'),
  label: 'My context',
  imageIds: [createImageId('img-1'), createImageId('img-2')],
  tools: [{ type: 'line', maxCount: 3 }],
}
```

When the active cell shows an image not in the context's `imageIds`, all tools are disabled. If `imageIds` is omitted, the context applies to all images.

## Setting contexts

Pass contexts to the `Annotator` component or set them programmatically:

```tsx
// Via Annotator component
<Annotator images={images} contexts={contexts} />;

// Via actions (when using AnnotatorProvider)
const { actions } = useAnnotator();
actions.setContexts(contexts);
actions.setActiveContext(contexts[0].id);
```

## Switching contexts

You can switch contexts programmatically using actions:

```tsx
const { actions } = useAnnotator();
actions.setActiveContext(contextId);

// Clear the active tool when switching contexts
actions.setActiveTool(null);
```

Or enable the built-in UI in the `Annotator` component:

```tsx
<Annotator images={images} contexts={contexts} showContextSwitcher={true} />
```

The `ContextSwitcher` component can also be used independently in custom layouts. See [Components](/osdlabel/api/components/#contextswitcher).

## Displaying multiple contexts

By default, only the active context's annotations are visible on the canvas. You can display annotations from additional contexts as a read-only overlay — visible but not selectable or editable.

### Via the Annotator component

```tsx
<Annotator
  images={images}
  contexts={contexts}
  displayedContextIds={[createAnnotationContextId('ctx1'), createAnnotationContextId('ctx2')]}
/>
```

### Via actions (when using AnnotatorProvider)

```tsx
const { actions } = useAnnotator();
actions.setDisplayedContexts([
  createAnnotationContextId('ctx1'),
  createAnnotationContextId('ctx2'),
]);
```

The active context is always displayed regardless of `displayedContextIds`. Annotations from non-active displayed contexts are rendered on the canvas but cannot be selected, moved, or modified.

## Reading constraint status

Use the `constraintStatus` accessor to check which tools are enabled:

```tsx
const { constraintStatus } = useAnnotator();

const status = constraintStatus();
// status.rectangle.enabled — boolean
// status.rectangle.currentCount — number
// status.rectangle.maxCount — number | null
```

Or use the `useConstraints` hook for convenience:

```tsx

const { isToolEnabled, canAddAnnotation } = useConstraints();

if (isToolEnabled('rectangle')) {
  // Rectangle tool is available
}
```

---

# Serialization

osdlabel provides built-in functions for serializing its internal state into a standard JSON document format and deserializing it back.

<SerializationDemoWrapper />

## Document format

osdlabel uses a JSON document format for persisting annotations:

```json
{
  "version": "1.0.0",
  "exportedAt": "2026-03-06T12:00:00.000Z",
  "images": [
    {
      "imageId": "sample-1",
      "sourceUrl": "https://example.com/image.dzi",
      "annotations": [
        {
          "id": "ann-1",
          "imageId": "sample-1",
          "contextId": "general",
          "geometry": {
            "type": "rectangle",
            "origin": { "x": 100, "y": 200 },
            "width": 300,
            "height": 150,
            "rotation": 0
          },
          "rawAnnotationData": {
            "format": "fabric",
            "fabricVersion": "7.2.0",
            "data": { ... }
          },
          "createdAt": "2026-03-06T12:00:00.000Z",
          "updatedAt": "2026-03-06T12:00:00.000Z"
        }
      ]
    }
  ]
}
```

## Exporting annotations

Use `serialize()` to create an `AnnotationDocument` from the current state:

```tsx

const { annotationState } = useAnnotator();

const doc = serialize(annotationState, images);
const json = JSON.stringify(doc, null, 2);

// Save to file, send to API, etc.
```

## Importing annotations

Use `deserialize()` to parse a document and load it into the store:

```tsx

const { actions } = useAnnotator();

const parsed = JSON.parse(jsonString);
const byImage = deserialize(parsed);
actions.loadAnnotations(byImage);
```

`deserialize()` validates the document structure and throws `SerializationError` on invalid input.

## Validation

The `validateBaseAnnotation()` function is a type guard that checks if a value has valid base annotation fields:

```tsx

if (validateBaseAnnotation(unknownData)) {
  // unknownData is BaseAnnotation
}
```

For full annotation validation including extension fields, use `createAnnotationValidator()` with either a type guard function or a Standard Schema:

```tsx

const validate = createAnnotationValidator(myExtensionValidator);
```

Validation checks include:

- Required string fields (`id`, `imageId`, timestamps)
- Geometry type and shape validation
- Extension fields (when using a composed validator)
- Numeric bounds checking (coordinates, dimensions)

## Listening to changes

The `onAnnotationsChange` callback fires whenever annotations are added, updated, or deleted:

```tsx
<AnnotatorProvider
  onAnnotationsChange={(annotations) => {
    // annotations: Annotation[] — flat list of all annotations
    saveToBackend(annotations);
  }}
>
  {/* ... */}
</AnnotatorProvider>
```

## Getting all annotations

Use `getAllAnnotationsFlat()` to extract a flat array from the state at any time:

```tsx

const { annotationState } = useAnnotator();
const allAnnotations = getAllAnnotationsFlat(annotationState);
```

---

# Keyboard Shortcuts

osdlabel is designed for high-throughput annotation tasks with a comprehensive set of keyboard shortcuts.

<MinimalViewerDemoWrapper />

## Default shortcuts

| Key                    | Action                                    |
| ---------------------- | ----------------------------------------- |
| `v`                    | Select tool                               |
| `r`                    | Rectangle tool                            |
| `c`                    | Circle tool                               |
| `l`                    | Line tool                                 |
| `p`                    | Point tool                                |
| `d`                    | Path (draw) tool                          |
| `f`                    | Free hand path tool                       |
| `Escape`               | Deselect annotation, then deactivate tool |
| `Delete` / `Backspace` | Delete selected annotation                |
| `1`–`9`                | Activate grid cell by position            |
| `=` / `+`              | Add a grid column                         |
| `-`                    | Remove a grid column                      |
| `]`                    | Add a grid row                            |
| `[`                    | Remove a grid row                         |

### Path tool shortcuts

| Key      | Action                      |
| -------- | --------------------------- |
| `Enter`  | Finish path (open polyline) |
| `c`      | Close path (polygon)        |
| `Escape` | Cancel path in progress     |

### Free hand path tool shortcuts

| Key      | Action                                          |
| -------- | ----------------------------------------------- |
| `Shift`  | Hold while drawing to produce an open polyline  |
| `Escape` | Cancel stroke in progress                       |

## Customizing shortcuts

Pass a `keyboardShortcuts` prop to override any default binding:

```tsx
<AnnotatorProvider
  keyboardShortcuts={{
    rectangleTool: 'b', // 'b' for box instead of 'r'
    circleTool: 'o', // 'o' for oval instead of 'c'
    delete: 'x', // 'x' to delete instead of Delete
  }}
>
  {/* ... */}
</AnnotatorProvider>
```

Or via the `Annotator` component:

```tsx
<Annotator images={images} contexts={contexts} keyboardShortcuts={{ rectangleTool: 'b' }} />
```

Unspecified keys keep their default bindings. See [`KeyboardShortcutMap`](/osdlabel/api/types/#keyboardshortcutmap) for all available keys.

## Suppressing shortcuts

Shortcuts are automatically suppressed when focus is in an `<input>`, `<textarea>`, or `contenteditable` element.

For additional suppression logic, use the `shouldSkipKeyboardShortcutPredicate` prop:

```tsx
<AnnotatorProvider
  shouldSkipKeyboardShortcutPredicate={(target) => {
    // Skip shortcuts when focus is inside a modal
    return target.closest('.modal') !== null;
  }}
>
  {/* ... */}
</AnnotatorProvider>
```

---

# Coordinate Systems

## Overview

osdlabel involves four coordinate systems. Understanding them is essential if you need to do custom coordinate conversions or build advanced overlay features.

```
Image-space (pixels)     →  stored in Annotation.geometry
        ↓  computeViewportTransform()
Fabric canvas-space      →  Fabric objects rendered here via viewportTransform
        =
Screen-space (CSS px)    →  mouse events, element positioning
        ↑  OSD internal
OSD Viewport-space       →  image width = 1.0, aspect-ratio-dependent
```

## Image-space

- **Origin:** Top-left of the full-resolution image
- **Units:** Pixels
- **Usage:** All annotation geometry is stored in this space

Image-space coordinates are stable regardless of zoom level. A point at `(500, 300)` always refers to pixel 500, 300 in the source image.

```ts
const geometry = {
  type: 'rectangle' as const,
  origin: { x: 100, y: 200 }, // image pixels
  width: 300, // image pixels
  height: 150, // image pixels
  rotation: 0,
};
```

## OSD Viewport-space

- **Origin:** Top-left of the viewport
- **Units:** Image width = 1.0, Y is aspect-ratio-dependent
- **Usage:** OpenSeaDragon's internal coordinate system

You generally don't interact with this directly. It's used internally by OSD for pan/zoom calculations.

## Screen-space

- **Origin:** Top-left of the browser viewport
- **Units:** CSS pixels
- **Usage:** Mouse events (`clientX`, `clientY`), element positioning

## Fabric canvas-space

- **Same as screen-space**, but Fabric objects are drawn using the `viewportTransform` matrix
- The transform maps image-space coordinates to screen-space at the current zoom/pan

## The viewportTransform

The overlay computes a 6-element affine matrix `[a, b, c, d, tx, ty]` that maps image-space to screen-space:

```ts

// Called internally on every OSD animation frame
const matrix = computeViewportTransform(viewer);
fabricCanvas.setViewportTransform(matrix);
```

This matrix encodes the current scale, rotation, and translation. Fabric uses it to render all objects — you store coordinates in image-space and the transform handles the rest.

## Coordinate conversion

The `FabricOverlay` provides conversion methods:

```ts
// Screen-space → Image-space
const imagePoint = overlay.screenToImage({ x: event.clientX, y: event.clientY });

// Image-space → Screen-space
const screenPoint = overlay.imageToScreen({ x: 500, y: 300 });
```

These are thin wrappers around OSD's `viewerElementToImageCoordinates()` and `imageToViewerElementCoordinates()`.

## Key principle

**Store in image-space, render via transform.**

Annotations are always stored in image-space pixels. The overlay's `viewportTransform` matrix handles the mapping to screen-space at the current zoom level. This means:

- Annotations are resolution-independent
- No coordinate recalculation needed on zoom/pan
- Serialized data is always in the same coordinate system regardless of viewport state

---

# OSD-Fabric Integration

This guide explains the internals of how osdlabel synchronizes a Fabric.js annotation canvas with an OpenSeadragon (OSD) deep-zoom viewer. It covers the overlay architecture, affine matrix math, coordinate transforms, event routing, and the specific workarounds required for rotation and flip support.

## Architecture overview

OSD renders deep-zoom imagery on its own canvas. osdlabel creates a **second** canvas on top of it — managed by Fabric.js — for annotations. The two libraries know nothing about each other. The `FabricOverlay` class bridges them:

```
┌─────────────────────────────────────────┐
│  OSD Viewer Container (div)             │
│  ┌───────────────────────────────────┐  │
│  │  OSD Tile Canvas (managed by OSD) │  │
│  ├───────────────────────────────────┤  │
│  │  Fabric Canvas (managed by        │  │
│  │  FabricOverlay, absolutely        │  │
│  │  positioned over OSD canvas)      │  │
│  └───────────────────────────────────┘  │
│  ┌───────────────────────────────────┐  │
│  │  OSD MouseTracker (intercepts     │  │
│  │  pointer events, forwards to      │  │
│  │  Fabric or lets OSD handle them)  │  │
│  └───────────────────────────────────┘  │
└─────────────────────────────────────────┘
```

The Fabric canvas element has `pointer-events: none` in CSS. All pointer event routing is handled by an OSD `MouseTracker`, not by CSS hit-testing. This ensures clean control over which library processes each event.

## The sync loop

When the user pans or zooms in OSD, the annotation canvas must move in lockstep. The `FabricOverlay` subscribes to four OSD events:

| OSD Event          | When it fires                           |
| ------------------ | --------------------------------------- |
| `animation`        | Every frame during a pan/zoom animation |
| `animation-finish` | When an animation completes             |
| `resize`           | When the viewer container resizes       |
| `open`             | When a new image is loaded              |

Additionally, `flip` and `rotate` events trigger a sync when the view transform changes.

On each event, `sync()` runs:

```ts
sync(): void {
  const vpt = computeViewportTransform(this._viewer);
  this._fabricCanvas.setViewportTransform(vpt);
  this._fabricCanvas.renderAll();
}
```

`sync()` uses **synchronous** `renderAll()`, not `requestRenderAll()`. This is critical because `sync()` runs inside OSD's own `requestAnimationFrame` callback. Using the async variant would defer the Fabric paint to the next frame, causing a visible 1-frame lag where the image has moved but annotations haven't.

## The affine viewportTransform

Fabric's `viewportTransform` is a 6-element array representing a 2D affine transformation matrix:

```
[a, b, c, d, tx, ty]
```

This encodes the matrix:

```
┌         ┐   ┌       ┐   ┌    ┐
│ screenX │   │ a   c │   │ ix │   ┌ tx ┐
│         │ = │       │ × │    │ + │    │
│ screenY │   │ b   d │   │ iy │   └ ty ┘
└         ┘   └       ┘   └    ┘
```

Where `(ix, iy)` is a point in image-space (pixels) and `(screenX, screenY)` is where it appears on screen (CSS pixels). The matrix encodes scale, rotation, and translation all at once.

### Computing the matrix: 3-point sampling

Rather than manually computing scale, rotation, and translation from OSD's internal state, `computeViewportTransform` uses **3-point sampling**. It maps three known image-space points through OSD's coordinate API and derives the full matrix from the results:

```ts
const origin = new OpenSeadragon.Point(0, 0); // image origin
const unitX = new OpenSeadragon.Point(1, 0); // 1 pixel right
const unitY = new OpenSeadragon.Point(0, 1); // 1 pixel down

const screenOrigin = viewer.viewport.imageToViewerElementCoordinates(origin);
const screenUnitX = viewer.viewport.imageToViewerElementCoordinates(unitX);
const screenUnitY = viewer.viewport.imageToViewerElementCoordinates(unitY);
```

The matrix elements are the vectors from the origin to each unit point:

```ts
a = screenUnitX.x - screenOrigin.x; // how much screenX changes per image pixel right
b = screenUnitX.y - screenOrigin.y; // how much screenY changes per image pixel right
c = screenUnitY.x - screenOrigin.x; // how much screenX changes per image pixel down
d = screenUnitY.y - screenOrigin.y; // how much screenY changes per image pixel down
tx = screenOrigin.x; // screen X of image origin
ty = screenOrigin.y; // screen Y of image origin
```

**Why 3 points instead of 2?** With only 2 points (origin + unitX), you can derive `a`, `b`, and `tx`/`ty`, but `c` and `d` must be inferred by assuming a 90° rotation relationship (`c = -b`, `d = a`). This assumption holds for pure rotation+scale but would break if OSD ever introduced skew or non-uniform scaling. The 3-point approach is robust against any affine transform OSD might produce.

### What the matrix looks like in practice

**Zoom only (scale=2, no rotation):**

```
[2, 0, 0, 2, tx, ty]
```

Moving 1 image pixel right → 2 screen pixels right. No skew.

**90° rotation at scale=1:**

```
[0, 1, -1, 0, tx, ty]
```

Moving 1 image pixel right → 1 screen pixel down. Moving 1 image pixel down → 1 screen pixel left.

**45° rotation at scale=2:**

```
[√2·2, √2·2, -√2·2, √2·2, tx, ty] ≈ [1.41, 1.41, -1.41, 1.41, tx, ty]
```

## How OSD handles rotation

OSD's `viewport.setRotation(degrees)` rotates the entire viewport. The rotation is handled inside the coordinate conversion pipeline:

1. `imageToViewerElementCoordinates(point)` converts image pixels → OSD viewport coordinates → viewer element coordinates
2. Inside `_pixelFromPoint()`, OSD applies rotation around the viewport center using the standard 2D rotation formula

This means the screen positions returned by `imageToViewerElementCoordinates` already account for rotation. The 3-point sampling captures this naturally — no special rotation handling is needed in `computeViewportTransform`.

**Important:** `setRotation(degrees)` uses a spring animation by default. When applying a view transform programmatically, pass `immediately=true` to snap instantly:

```ts
viewport.setRotation(rotation, true);
```

Without this, the rotation interpolates over several frames. If `sync()` runs before the animation completes, it computes a matrix for an intermediate rotation angle, causing a brief desync.

## How OSD handles flip — and why it's special

OSD's flip is fundamentally different from rotation. `viewport.setFlip(true)` sets an internal flag, but **`imageToViewerElementCoordinates` does NOT apply the flip.** The flip is implemented entirely in OSD's tile rendering pipeline:

```
OSD Drawer:
  context.save()
  context.scale(-1, 1)         // mirror the canvas horizontally
  context.translate(-canvasWidth, 0)
  // ... draw tiles ...
  context.restore()
```

This means the tiles appear flipped on screen, but `imageToViewerElementCoordinates` still returns the **unflipped** position. The 3-point sampling would produce a matrix that doesn't account for flip.

### Composing flip into the matrix

`computeViewportTransform` reads OSD's flip state and manually composes a horizontal mirror:

```ts
if (viewport.getFlip()) {
  const W = viewer.viewport.getContainerSize().x;
  return [-a, b, -c, d, W - tx, ty];
}
```

The math: a horizontal flip mirrors the X coordinate around the container center. For a point at screen position `x`, the flipped position is `W - x`. Substituting the affine formula:

```
Unflipped:  screenX = a·ix + c·iy + tx
Flipped:    screenX = W - (a·ix + c·iy + tx)
          = -a·ix + -c·iy + (W - tx)
```

So the flipped matrix is `[-a, b, -c, d, W-tx, ty]` — negate `a` and `c`, and replace `tx` with `W - tx`. The Y components (`b`, `d`, `ty`) are unchanged.

### Vertical flip

OSD only has horizontal flip (`setFlip`). Vertical flip is achieved by combining horizontal flip with a 180° rotation:

```ts
// In applyViewTransform (receives CellTransform):
const isFlipped = transform.flippedH !== transform.flippedV; // XOR
if (transform.flippedV) {
  rotation = (rotation + 180) % 360;
}
viewport.setFlip(isFlipped);
viewport.setRotation(rotation, true);
```

A 180° rotation inverts both axes. Combined with a horizontal flip (which inverts X), the net effect is inverting only Y — a vertical flip.

## The getZoom() override

Fabric.js internally calls `canvas.getZoom()` in several places, most critically in `_getCacheCanvasDimensions()` which sizes the per-object cache canvases used for rendering. The default implementation is:

```ts
// Fabric's default:
getZoom() {
  return this.viewportTransform[0];  // element 'a'
}
```

This is correct when the viewportTransform is a simple scale+translate matrix (`[scale, 0, 0, scale, tx, ty]`), where `a = scale`. But with rotation:

```
a = cos(θ) × scale
```

| Rotation | a             | Problem                                        |
| -------- | ------------- | ---------------------------------------------- |
| 0°       | 1 × scale     | Correct                                        |
| 45°      | 0.707 × scale | Too small — objects render undersized          |
| 90°      | 0 × scale = 0 | Cache dimensions = 0 — objects invisible       |
| 180°     | -1 × scale    | Negative cache dimensions — clipping artifacts |

The fix overrides `getZoom()` to compute the actual scale as the magnitude of the first column vector of the matrix:

```ts
this._fabricCanvas.getZoom = () => {
  const vpt = this._fabricCanvas.viewportTransform;
  return Math.sqrt(vpt[0] * vpt[0] + vpt[1] * vpt[1]); // √(a² + b²)
};
```

This is the Euclidean length of the vector `(a, b)`, which equals `scale` regardless of rotation angle. It equals `|cos²(θ)·scale² + sin²(θ)·scale²| = scale`.

## skipOffscreen: false

Fabric's default `skipOffscreen: true` skips rendering objects whose bounding boxes don't intersect the visible canvas area. However, Fabric's offscreen culling doesn't account for rotation in the `viewportTransform`. An object that's visible on the rotated canvas may have a bounding box (computed in unrotated space) that falls outside the canvas rectangle, causing it to be incorrectly culled.

Setting `skipOffscreen: false` disables this optimization, ensuring all objects render regardless of the viewport transform.

## Event routing

The `FabricOverlay` uses an OSD `MouseTracker` to intercept pointer events before OSD processes them. The routing depends on the current mode:

### Navigation mode

The MouseTracker is disabled (`setTracking(false)`). Events fall through to OSD's own tracker for pan/zoom. Fabric objects are set to `selectable: false` and `evented: false`.

### Annotation mode

The MouseTracker intercepts events in `preProcessEventHandler`:

```
pointerdown:
  ├── Ctrl/Cmd held? → Pan passthrough: enable OSD nav, let event propagate
  └── Normal click?  → Stop propagation, forward to Fabric

pointermove:
  ├── Pan gesture active? → Let OSD handle it
  └── Otherwise?          → Stop propagation, forward to Fabric

pointerup:
  ├── Pan gesture active? → End gesture, re-disable OSD nav
  └── Otherwise?          → Stop propagation, forward to Fabric

scroll:
  └── Ctrl/Cmd held? → Manual viewport.zoomBy() (OSD scroll-zoom is disabled)
```

### Forwarding to Fabric

Events are forwarded by dispatching a synthetic `PointerEvent` on Fabric's upper canvas element. This is necessary because the original DOM event targets the MouseTracker's element, not Fabric's canvas.

A **re-entrancy guard** (`_forwarding` flag) prevents infinite loops: the synthetic event bubbles from Fabric's upper canvas up to the container div, where the MouseTracker would intercept it again. The guard ensures the bubbled-back event is ignored.

```ts
private _forwardToFabric(type: string, originalEvent: PointerEvent): void {
  if (this._forwarding) return;  // Guard: ignore bubbled-back events
  this._forwarding = true;
  try {
    const syntheticEvent = new PointerEvent(type, {
      clientX: originalEvent.clientX,
      clientY: originalEvent.clientY,
      // ... all other properties copied from original
      bubbles: true,
      cancelable: true,
    });
    this._fabricCanvas.upperCanvasEl.dispatchEvent(syntheticEvent);
  } finally {
    this._forwarding = false;
  }
}
```

## How annotations stay correct under rotation/flip

Annotations are stored in **image-space** — pixel coordinates relative to the full-resolution image. The `viewportTransform` matrix maps these to screen-space for rendering. This design means:

1. **Existing annotations** visually rotate/flip with the image automatically — the same matrix transforms both tiles and annotation objects.

2. **New annotations** drawn while rotated/flipped get correct image-space coordinates. Fabric's `scenePoint` (used by annotation tools via `getScenePoint()`) is computed by inverse-transforming the screen pointer through the `viewportTransform`. The inverse of a rotation+scale+flip matrix yields the original image-space coordinates.

3. **Moved/resized annotations** report their properties (left, top, width, height) in image-space because Fabric objects live in scene-space (which is image-space in this setup). The `viewportTransform` is a view transform only — it doesn't modify object coordinates.

No annotation data is ever modified by rotation or flip. The view transform is purely a rendering concern.

## Lifecycle summary

```
1. ViewerCell mounts
   └── Creates OSD Viewer
       └── OSD fires 'open'
           └── FabricOverlay constructor:
               ├── Creates <canvas> element over OSD
               ├── Creates Fabric.Canvas on it
               ├── Overrides getZoom()
               ├── Creates OSD MouseTracker
               ├── Subscribes to animation/resize/open/flip/rotate events
               └── Initial sync()

2. User pans/zooms
   └── OSD fires 'animation' (every frame)
       └── sync()
           ├── computeViewportTransform(viewer)  → 6-element matrix
           ├── fabricCanvas.setViewportTransform(matrix)
           └── fabricCanvas.renderAll()          → synchronous

3. User applies rotation/flip
   └── applyViewTransform(cellTransform)
       ├── Compute effective rotation (add 180° for vertical flip)
       ├── viewport.setFlip(isFlipped)           → immediately
       ├── viewport.setRotation(rotation, true)  → immediately (no spring)
       └── sync()                                → recompute matrix

4. ViewerCell unmounts
   └── overlay.destroy()
       ├── MouseTracker.destroy()
       ├── Remove all OSD event handlers
       ├── Fabric canvas.dispose()
       └── Remove <canvas> from DOM
```

---

# Minimal Viewer

A complete, minimal annotation setup with a single image and unrestricted tools.

<MinimalViewerDemoWrapper />

```tsx

const images: ImageSource[] = [
  {
    id: createImageId('demo'),
    tileSource: 'https://openseadragon.github.io/example-images/highsmith/highsmith.dzi',
    label: 'Demo Image',
  },
];

const contexts: AnnotationContext[] = [
  {
    id: createAnnotationContextId('default'),
    label: 'Default',
    tools: [
      { type: 'rectangle' },
      { type: 'circle' },
      { type: 'line' },
      { type: 'point' },
      { type: 'path' },
    ],
  },
];

function App() {
  return (
    <div style={{ width: '100vw', height: '100vh' }}>
      <Annotator images={images} contexts={contexts} />
    </div>
  );
}

render(() => <App />, document.getElementById('app')!);
```

This gives you:

- A full-screen image viewer with pan/zoom
- All 5 drawing tools available in the toolbar
- Keyboard shortcuts for tool selection
- Selection, move, resize, and rotate for created annotations
- Filmstrip sidebar (single image) and status bar

---

# Multiple Annotation Contexts

A setup with multiple annotation contexts for classifying different types of features, each with its own set of allowed tools and count limits.

<MultipleContextsDemoWrapper />

```tsx

const images: ImageSource[] = [
  {
    id: createImageId('sample-1'),
    tileSource: 'https://openseadragon.github.io/example-images/highsmith/highsmith.dzi',
    label: 'Region North',
  },
  {
    id: createImageId('sample-2'),
    tileSource: 'https://openseadragon.github.io/example-images/duomo/duomo.dzi',
    label: 'Region South',
  },
];

const contexts: AnnotationContext[] = [
  {
    id: createAnnotationContextId('buildings'),
    label: 'Buildings',
    // Only annotate buildings in specific regions
    imageIds: [createImageId('sample-1'), createImageId('sample-2')],
    tools: [
      // Up to 10 building outlines per image
      { type: 'rectangle', maxCount: 10, countScope: 'per-image' },
      // Up to 5 freehand boundaries total for irregular shapes
      { type: 'path', maxCount: 5 },
    ],
  },
  {
    id: createAnnotationContextId('roads'),
    label: 'Roads',
    tools: [
      // Trace road segments with lines
      { type: 'line', maxCount: 20, countScope: 'per-image' },
      // Mark intersections
      { type: 'point', maxCount: 15 },
    ],
  },
  {
    id: createAnnotationContextId('landmarks'),
    label: 'Landmarks',
    tools: [
      { type: 'rectangle' },
      { type: 'circle' },
      { type: 'line' },
      { type: 'point' },
      { type: 'path' },
    ],
  },
];

function App() {
  return (
    <div style={{ width: '100vw', height: '100vh' }}>
      <Annotator
        images={images}
        contexts={contexts}
        showContextSwitcher={true}
        filmstripPosition="left"
        maxGridSize={{ columns: 2, rows: 1 }}
        displayedContextIds={[
          createAnnotationContextId('buildings'),
          createAnnotationContextId('roads'),
        ]}
        onAnnotationsChange={(annotations) => {
          console.log(`Total annotations: ${annotations.length}`);
        }}
      />
    </div>
  );
}

render(() => <App />, document.getElementById('app')!);
```

## Key features demonstrated

- **Context Switching** — use `showContextSwitcher={true}` to enable the built-in UI for switching tasks
- **Displayed contexts** — `displayedContextIds` shows annotations from Buildings and Roads contexts as a read-only overlay, even when another context is active
- **Multiple contexts** with different tool constraints (Buildings, Roads, Landmarks)
- **Image scoping** — contexts can be restricted to specific images in the dataset
- **Per-image counting** — constraints can limit annotations per individual image
- **Global counting** — constraints can also limit annotations across the entire image set
- **Callbacks** for annotation changes and constraint status updates

---

# Custom Toolbar

Use `AnnotatorProvider` and `useAnnotator()` to build a fully custom annotation UI.

<CustomToolbarDemoWrapper />

```tsx

const images: ImageSource[] = [
  {
    id: createImageId('sample'),
    tileSource: 'https://openseadragon.github.io/example-images/highsmith/highsmith.dzi',
    label: 'Sample',
  },
];

const contexts: AnnotationContext[] = [
  {
    id: createAnnotationContextId('default'),
    label: 'Default',
    tools: [{ type: 'rectangle', maxCount: 5 }, { type: 'circle', maxCount: 3 }, { type: 'line' }],
  },
];

function CustomToolbar() {
  const { actions, uiState, constraintStatus } = useAnnotator();
  const { isToolEnabled } = useConstraints();

  const tools: { type: ToolType | 'select'; label: string }[] = [
    { type: 'select', label: 'Select' },
    { type: 'rectangle', label: 'Rect' },
    { type: 'circle', label: 'Circle' },
    { type: 'line', label: 'Line' },
  ];

  const toolInfo = (type: ToolType) => {
    const status = constraintStatus();
    const s = status[type];
    if (s.maxCount === null) return '';
    return ` (${s.currentCount}/${s.maxCount})`;
  };

  return (
    <div style={{ display: 'flex', gap: '4px', padding: '8px', background: '#1a1a2e' }}>
      {tools.map((tool) => (
        <button
          disabled={tool.type !== 'select' && !isToolEnabled(tool.type)}
          onClick={() => actions.setActiveTool(tool.type)}
          style={{
            padding: '6px 12px',
            border: uiState.activeTool === tool.type ? '2px solid #4f6df5' : '1px solid #555',
            'border-radius': '4px',
            background: uiState.activeTool === tool.type ? '#2a2a5e' : '#2a2a3e',
            color: '#fff',
            cursor: 'pointer',
            opacity: tool.type !== 'select' && !isToolEnabled(tool.type) ? '0.5' : '1',
          }}
        >
          {tool.label}
          {tool.type !== 'select' && toolInfo(tool.type)}
        </button>
      ))}

      <button
        onClick={() => actions.setActiveTool(null)}
        style={{
          'margin-left': 'auto',
          padding: '6px 12px',
          border: '1px solid #555',
          'border-radius': '4px',
          background: '#2a2a3e',
          color: '#fff',
          cursor: 'pointer',
        }}
      >
        Navigate
      </button>
    </div>
  );
}

function AppContent() {
  const { uiState, actions, activeImageId } = useAnnotator();

  actions.setContexts(contexts);
  actions.setActiveContext(contexts[0]!.id);
  actions.assignImageToCell(0, images[0]!.id);

  return (
    <div style={{ width: '100vw', height: '100vh', display: 'flex', 'flex-direction': 'column' }}>
      <CustomToolbar />
      <div style={{ flex: '1', 'min-height': '0' }}>
        <GridView columns={1} rows={1} maxColumns={1} maxRows={1} images={images} />
      </div>
      <StatusBar imageId={activeImageId()} />
    </div>
  );
}

function App() {
  return (
    <AnnotatorProvider>
      <AppContent />
    </AnnotatorProvider>
  );
}

render(() => <App />, document.getElementById('app')!);
```

## Key patterns

- Use `AnnotatorProvider` instead of `Annotator` for full layout control
- Access state via `useAnnotator()` and `useConstraints()`
- The `constraintStatus()` accessor provides reactive count information
- Set contexts and assign images in the content component (inside the provider)
