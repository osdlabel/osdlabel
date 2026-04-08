import { type Component, For } from 'solid-js';
import { useAnnotator } from '../state/annotator-context.js';
import type { AnnotationContextId } from '../core/types.js';

export interface ContextSwitcherProps {
  /** Optional custom label for the switcher */
  readonly label?: string | undefined;
}

/**
 * UI control for switching between available annotation contexts.
 */
const ContextSwitcher: Component<ContextSwitcherProps> = (props) => {
  const { contextState, actions } = useAnnotator();

  return (
    <div style={{ display: 'flex', 'align-items': 'center', gap: '8px' }}>
      {props.label && <span style={{ color: '#fff', 'font-size': '13px' }}>{props.label}</span>}
      <select
        value={contextState.activeContextId ?? ''}
        onChange={(e) => actions.setActiveContext(e.currentTarget.value as AnnotationContextId)}
        style={{
          padding: '2px 4px',
          background: '#333',
          color: '#fff',
          border: '1px solid #555',
          'border-radius': '4px',
          'font-size': '13px',
          cursor: 'pointer',
        }}
      >
        <For each={contextState.contexts}>
          {(context) => <option value={context.id}>{context.label}</option>}
        </For>
      </select>
    </div>
  );
};

export default ContextSwitcher;
