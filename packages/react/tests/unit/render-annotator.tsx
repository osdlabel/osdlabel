import { act, type ReactNode } from 'react';
import {
  AnnotatorProvider,
  useAnnotator,
  type AnnotatorProviderProps,
} from '../../src/state/annotator-context.js';
import { mount } from './mount.js';

/** The value `useAnnotator()` hands a component. */
export type AnnotatorValue = ReturnType<typeof useAnnotator>;
export type AnnotatorActions = AnnotatorValue['actions'];
export type ProviderProps = Omit<AnnotatorProviderProps, 'children'>;

/** A real `AnnotatorProvider`, with a probe reading its context value. */
export interface AnnotatorHarness {
  /** The context value from the latest committed render. */
  readonly current: AnnotatorValue;
  /**
   * Runs `fn` against the provider's actions inside its own `act()`, so the
   * dispatch commits and the provider re-renders before this returns.
   *
   * This is the React-specific part. `createActions` reads state through
   * `getAnnotationState()` / `getContextState()` / `getUIState()`, which return
   * refs the provider refreshes on each render — not a live store as in Solid.
   * An action that reads state (`addAnnotation`, `convertAnnotation`, the
   * active-cell view actions) therefore sees what the last render committed,
   * so dependent steps go in separate `run` calls.
   */
  run(fn: (actions: AnnotatorActions) => void): void;
  /** Re-renders the provider with `props` merged over the previous props. */
  rerender(props?: ProviderProps, children?: ReactNode): void;
  /** How many times the probe has rendered. */
  readonly renderCount: number;
  unmount(): void;
}

/**
 * Mounts a real `AnnotatorProvider` — Immer `useReducer`s, the getter-based
 * `createActions`, the memoised constraint status — rather than a mock, so
 * tests exercise the React wiring itself.
 */
export function renderAnnotator(
  props: ProviderProps = {},
  children: ReactNode = null,
): AnnotatorHarness {
  let latest: AnnotatorValue | undefined;
  let renderCount = 0;
  function Probe() {
    latest = useAnnotator();
    renderCount += 1;
    return null;
  }

  let currentProps = props;
  let currentChildren = children;
  const tree = () => (
    <AnnotatorProvider {...currentProps}>
      <Probe />
      {currentChildren}
    </AnnotatorProvider>
  );
  const mounted = mount(tree());

  const read = (): AnnotatorValue => {
    if (!latest) throw new Error('AnnotatorProvider never rendered its probe');
    return latest;
  };

  return {
    get current() {
      return read();
    },
    get renderCount() {
      return renderCount;
    },
    run(fn) {
      act(() => {
        fn(read().actions);
      });
    },
    rerender(nextProps = {}, nextChildren) {
      currentProps = { ...currentProps, ...nextProps };
      if (nextChildren !== undefined) currentChildren = nextChildren;
      mounted.rerender(tree());
    },
    unmount: () => mounted.unmount(),
  };
}
