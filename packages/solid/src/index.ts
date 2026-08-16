// Re-export everything from osdlabel (framework-agnostic shared code)
export * from 'osdlabel';

// State
export {
  createAnnotationStore,
  createUIStore,
  createContextStore,
  createActions,
  AnnotatorProvider,
  useAnnotator,
  createConstraintStatus,
} from './state/index.js';
export type {
  AnnotatorProviderProps,
  ActiveToolKeyHandlerRef,
} from './state/annotator-context.js';

// Components
export { default as ViewerCell } from './components/ViewerCell.js';
export { default as Toolbar } from './components/Toolbar.js';
export { default as StatusBar } from './components/StatusBar.js';
export { default as ContextSwitcher } from './components/ContextSwitcher.js';
export { default as GridView } from './components/GridView.js';
export { default as Filmstrip } from './components/Filmstrip.js';
export { default as GridControls } from './components/GridControls.js';
export { ViewControls } from './components/ViewControls.js';
export { default as FpsCounter } from './components/FpsCounter.js';
export { default as Annotator } from './components/Annotator.js';
export type { AnnotatorProps } from './components/Annotator.js';

// Hooks
export { useConstraints } from './hooks/useConstraints.js';
export { useKeyboard, MAX_GRID_SIZE, DEFAULT_KEYBOARD_SHORTCUTS } from './hooks/useKeyboard.js';
