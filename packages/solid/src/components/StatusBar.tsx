import type { Component } from 'solid-js';
import { Show } from 'solid-js';
import { useAnnotator } from '../state/annotator-context.js';
import type { ImageId } from '@osdlabel/viewer-api';
import FpsCounter from './FpsCounter.js';
import { OSDLABEL_PARTS, themeVar } from 'osdlabel';

export interface StatusBarProps {
  readonly imageId: ImageId | undefined;
  readonly showFps?: boolean | undefined;
}

const StatusBar: Component<StatusBarProps> = (props) => {
  const { uiState, contextState, annotationState } = useAnnotator();

  const activeContextLabel = () => {
    if (!contextState.activeContextId) return 'No context';
    const ctx = contextState.contexts.find((c) => c.id === contextState.activeContextId);
    return ctx?.label ?? 'Unknown';
  };

  const activeToolName = () => {
    const tool = uiState.activeTool;
    if (tool === null) return 'Navigate';
    return tool.charAt(0).toUpperCase() + tool.slice(1);
  };

  const totalAnnotationCount = () => {
    const imgId = props.imageId;
    if (!imgId) return 0;
    const imageAnns = annotationState.byImage[imgId];
    if (!imageAnns) return 0;
    return Object.keys(imageAnns).length;
  };

  return (
    <div
      part={OSDLABEL_PARTS.statusBar}
      style={{
        padding: '4px 12px',
        background: themeVar('surfaceSunken'),
        color: themeVar('textMuted'),
        display: 'flex',
        gap: '16px',
        'align-items': 'center',
        'font-family': themeVar('fontFamily'),
        'font-size': themeVar('fontSizeStatus'),
        'flex-shrink': '0',
      }}
    >
      <span data-testid="status-context">
        Context: <strong style={{ color: themeVar('text') }}>{activeContextLabel()}</strong>
      </span>
      <span data-testid="status-tool">
        Tool: <strong style={{ color: themeVar('text') }}>{activeToolName()}</strong>
      </span>
      <span data-testid="status-count">
        Annotations: <strong style={{ color: themeVar('text') }}>{totalAnnotationCount()}</strong>
      </span>
      <Show when={props.showFps}>
        <FpsCounter />
      </Show>
    </div>
  );
};

export default StatusBar;
