# Reference: SolidJS Patterns for Imperative Library Integration

## Core Concept

SolidJS components run **once** to set up the view. There is no re-rendering. Reactive updates happen through signals, effects, and stores. When integrating imperative libraries like OSD and Fabric, you must use `onMount`/`onCleanup` for lifecycle and `createEffect` for reactive bridging.

## Pattern: Imperative Library Initialization

```typescript
import { onMount, onCleanup } from 'solid-js';

function ViewerCell(props) {
  let containerRef: HTMLDivElement | undefined;
  let viewer: OpenSeadragon.Viewer | undefined;
  let overlay: FabricOverlay | undefined;

  onMount(() => {
    // Safe to access DOM refs here
    viewer = OpenSeadragon({
      element: containerRef!,
      // ... config
    });

    overlay = createFabricOverlay(viewer);

    // Open initial image
    if (props.imageSource) {
      viewer.open(/* ... */);
    }
  });

  onCleanup(() => {
    overlay?.destroy();
    viewer?.destroy();
  });

  return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />;
}
```

## Pattern: Watching Props with createEffect

```typescript
import { createEffect, on } from 'solid-js';

function ViewerCell(props) {
  // ... viewer and overlay setup in onMount ...

  // Watch for image source changes
  // IMPORTANT: Do NOT destructure props — it breaks reactivity
  createEffect(
    on(
      () => props.imageSource?.tileSource, // tracked getter
      (url, prevUrl) => {
        if (url !== prevUrl && viewer) {
          viewer.close();
          if (url) {
            viewer.open(/* ... */);
          }
        }
      },
    ),
  );

  // Watch for active state changes
  createEffect(() => {
    // Accessing props.isActive inside createEffect tracks it
    if (props.isActive) {
      overlay?.setMode('annotation');
    } else {
      overlay?.setMode('navigation');
    }
  });
}
```

## Pattern: Do NOT Destructure Props

```typescript
// ❌ WRONG — breaks reactivity
function MyComponent({ imageSource, isActive }) {
  createEffect(() => {
    console.log(isActive); // This will never re-run!
  });
}

// ✅ CORRECT — props object preserves reactivity
function MyComponent(props) {
  createEffect(() => {
    console.log(props.isActive); // Re-runs when isActive changes
  });
}
```

## Pattern: Stores for Nested State

```typescript
import { createStore, produce } from 'solid-js/store';

// Create a store (deeply reactive)
const [state, setState] = createStore({
  byImage: {} as Record<string, Record<string, Annotation>>,
});

// Update with produce (Immer-like syntax)
setState(
  produce((draft) => {
    draft.byImage['img-1'] ??= {};
    draft.byImage['img-1']['ann-1'] = newAnnotation;
  }),
);

// Read reactively — accessing nested paths creates subscriptions
createEffect(() => {
  const annotations = state.byImage['img-1'];
  // This effect re-runs ONLY when img-1's annotations change
});
```

## Pattern: Context Provider

```typescript
import { createContext, useContext, ParentComponent } from 'solid-js';

interface AnnotatorContextValue {
  state: AnnotationState;
  uiState: UIState;
  actions: Actions;
}

const AnnotatorCtx = createContext<AnnotatorContextValue>();

export const AnnotatorProvider: ParentComponent<AnnotatorProviderProps> = (props) => {
  const [state, setState] = createStore<AnnotationState>({ byImage: {} });
  const [uiState, setUIState] = createStore<UIState>({ /* ... */ });

  const actions = {
    addAnnotation: (ann: Annotation) => setState(produce(/* ... */)),
    // ...
  };

  return (
    <AnnotatorCtx.Provider value={{ state, uiState, actions }}>
      {props.children}
    </AnnotatorCtx.Provider>
  );
};

export function useAnnotator() {
  const ctx = useContext(AnnotatorCtx);
  if (!ctx) throw new Error('useAnnotator must be used inside AnnotatorProvider');
  return ctx;
}
```

## Pattern: Derived Computations (createMemo)

```typescript
import { createMemo } from 'solid-js';

// Computed value that re-evaluates only when its dependencies change
const constraintStatus = createMemo(() => {
  const activeCtx = contextState.contexts.find((c) => c.id === contextState.activeContextId);
  if (!activeCtx) return [];

  return activeCtx.tools.map((tc) => ({
    type: tc.type,
    enabled:
      tc.maxCount === undefined || countAnnotations(state, activeCtx.id, tc.type) < tc.maxCount,
  }));
});

// Use it reactively
createEffect(() => {
  console.log('Tool status changed:', constraintStatus());
});
```

## Pattern: Refs for Imperative Access

```typescript
function MyComponent() {
  let canvasRef: HTMLCanvasElement | undefined;

  onMount(() => {
    // canvasRef is guaranteed to be set here
    const ctx = canvasRef!.getContext('2d');
  });

  return <canvas ref={canvasRef} />;
}
```

## Common Mistakes to Avoid

1. **Don't use `useState` — it's React.** Use `createSignal` for simple values, `createStore` for objects.
2. **Don't use `useEffect` — it's React.** Use `createEffect`.
3. **Don't return cleanup functions from effects.** Use `onCleanup` instead.
4. **Don't use `useRef` — it's React.** Use `let myRef: T | undefined` and the `ref` JSX attribute.
5. **Don't conditionally return JSX.** Use `<Show when={condition}>` instead.
6. **Don't map arrays with `.map()`.** Use `<For each={items}>{(item) => ...}</For>` for reactive lists.
7. **Don't assume effects run on mount.** Use `onMount` for initialization code.
