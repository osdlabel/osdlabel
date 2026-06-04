import { createStore } from 'solid-js/store';
import { For, Show, createMemo } from 'solid-js';
import { createImageId, createAnnotationContextId } from '@osdlabel/solid';
import type { ImageSource, AnnotationContext, ToolConstraint, ToolType } from '@osdlabel/solid';
import { TOOL_TYPES } from './defaults.js';

interface DraftImage {
  id: string;
  tileSource: string;
  label: string;
  thumbnailUrl: string;
}

interface DraftTool {
  type: ToolType;
  maxCount: string;
  countScope: '' | 'per-image' | 'per-context';
}

interface DraftContext {
  id: string;
  label: string;
  imageIds: string[];
  tools: DraftTool[];
}

interface ConfigDraft {
  images: DraftImage[];
  contexts: DraftContext[];
}

function imageToDraft(img: ImageSource): DraftImage {
  return {
    id: img.id as string,
    tileSource: img.tileSource,
    label: img.label ?? '',
    thumbnailUrl: img.thumbnailUrl ?? '',
  };
}

function contextToDraft(ctx: AnnotationContext): DraftContext {
  return {
    id: ctx.id as string,
    label: ctx.label,
    imageIds: ctx.imageIds ? (ctx.imageIds as readonly string[]).slice() : [],
    tools: ctx.tools.map((t) => ({
      type: t.type,
      maxCount: t.maxCount !== undefined ? String(t.maxCount) : '',
      countScope: t.countScope ?? '',
    })),
  };
}

export interface ConfigPanelProps {
  initialImages: readonly ImageSource[];
  initialContexts: readonly AnnotationContext[];
  onLaunch: (images: ImageSource[], contexts: AnnotationContext[]) => void;
}

const inputStyle = {
  padding: '4px 6px',
  background: '#111',
  color: '#fff',
  border: '1px solid #333',
  'border-radius': '4px',
  'font-size': '12px',
  'font-family': 'inherit',
};

const buttonStyle = {
  padding: '4px 10px',
  border: '1px solid #555',
  'border-radius': '4px',
  cursor: 'pointer',
  background: '#2a2a3e',
  color: '#fff',
  'font-size': '12px',
};

const dangerButtonStyle = {
  ...buttonStyle,
  background: '#3e1a1a',
  'border-color': '#8a2a2a',
};

const primaryButtonStyle = {
  ...buttonStyle,
  background: '#1a5c2a',
  'border-color': '#2a8a3e',
  padding: '8px 16px',
  'font-size': '14px',
  'font-weight': 'bold',
};

const labelStyle = {
  display: 'flex',
  'flex-direction': 'column' as const,
  gap: '2px',
  'font-size': '11px',
  color: '#aaa',
  flex: '1',
  'min-width': '0',
};

const cardStyle = {
  background: '#1a1a2e',
  border: '1px solid #333',
  'border-radius': '6px',
  padding: '10px',
  display: 'flex',
  'flex-direction': 'column' as const,
  gap: '8px',
};

export default function ConfigPanel(props: ConfigPanelProps) {
  const [draft, setDraft] = createStore<ConfigDraft>({
    images: props.initialImages.map(imageToDraft),
    contexts: props.initialContexts.map(contextToDraft),
  });

  const errors = createMemo(() => {
    const errs: string[] = [];
    if (draft.images.length === 0) errs.push('Add at least one image.');
    if (draft.contexts.length === 0) errs.push('Add at least one context.');

    const imgIds = draft.images.map((i) => i.id.trim());
    if (imgIds.some((id) => id === '')) errs.push('All image IDs must be non-empty.');
    if (draft.images.some((i) => i.tileSource.trim() === ''))
      errs.push('All images need a tile source URL.');
    const nonEmptyImg = imgIds.filter(Boolean);
    if (new Set(nonEmptyImg).size !== nonEmptyImg.length) errs.push('Image IDs must be unique.');

    const ctxIds = draft.contexts.map((c) => c.id.trim());
    if (ctxIds.some((id) => id === '')) errs.push('All context IDs must be non-empty.');
    const nonEmptyCtx = ctxIds.filter(Boolean);
    if (new Set(nonEmptyCtx).size !== nonEmptyCtx.length) errs.push('Context IDs must be unique.');

    for (const ctx of draft.contexts) {
      const name = ctx.label || ctx.id || '(unnamed)';
      if (ctx.tools.length === 0) errs.push(`Context "${name}" needs at least one tool.`);
      for (const imgId of ctx.imageIds) {
        if (!imgIds.includes(imgId))
          errs.push(`Context "${name}" references unknown image "${imgId}".`);
      }
    }
    return errs;
  });

  const isValid = () => errors().length === 0;

  const launch = () => {
    if (!isValid()) return;
    const images: ImageSource[] = draft.images.map((d) => {
      const base = {
        id: createImageId(d.id.trim()),
        tileSource: d.tileSource.trim(),
      };
      const label = d.label.trim();
      const thumbnailUrl = d.thumbnailUrl.trim();
      return {
        ...base,
        ...(label ? { label } : {}),
        ...(thumbnailUrl ? { thumbnailUrl } : {}),
      };
    });
    const contexts: AnnotationContext[] = draft.contexts.map((d) => {
      const tools: ToolConstraint[] = d.tools.map((t) => {
        const constraint: {
          type: ToolType;
          maxCount?: number;
          countScope?: 'per-image' | 'per-context';
        } = {
          type: t.type,
        };
        const trimmed = t.maxCount.trim();
        if (trimmed !== '') {
          const n = Number(trimmed);
          if (Number.isFinite(n) && n > 0) constraint.maxCount = Math.floor(n);
        }
        if (t.countScope !== '') constraint.countScope = t.countScope;
        return constraint;
      });
      const base = {
        id: createAnnotationContextId(d.id.trim()),
        label: d.label.trim() || d.id.trim(),
        tools,
      };
      return d.imageIds.length > 0
        ? { ...base, imageIds: d.imageIds.map((id) => createImageId(id)) }
        : base;
    });
    props.onLaunch(images, contexts);
  };

  const addImage = () => {
    setDraft('images', (imgs) => [
      ...imgs,
      { id: `image-${imgs.length + 1}`, tileSource: '', label: '', thumbnailUrl: '' },
    ]);
  };

  const addContext = () => {
    setDraft('contexts', (cs) => [
      ...cs,
      {
        id: `ctx-${cs.length + 1}`,
        label: '',
        imageIds: [],
        tools: [{ type: 'rectangle', maxCount: '', countScope: '' }],
      },
    ]);
  };

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        overflow: 'auto',
        background: '#0f0f1e',
        color: '#fff',
        'font-family': 'system-ui, sans-serif',
        'box-sizing': 'border-box',
        padding: '20px',
      }}
    >
      <div
        style={{
          'max-width': '900px',
          margin: '0 auto',
          display: 'flex',
          'flex-direction': 'column',
          gap: '20px',
        }}
      >
        <header>
          <h1 style={{ margin: '0 0 4px 0', 'font-size': '24px' }}>osdlabel demo</h1>
          <p style={{ margin: '0', color: '#aaa', 'font-size': '13px' }}>
            Configure your images and annotation contexts, then launch the annotator. The form is
            pre-filled with sample data &mdash; click Launch to use the defaults.
          </p>
        </header>

        {/* Images section */}
        <section style={cardStyle}>
          <div
            style={{ display: 'flex', 'align-items': 'center', 'justify-content': 'space-between' }}
          >
            <h2 style={{ margin: '0', 'font-size': '16px' }}>Images</h2>
            <button type="button" onClick={addImage} style={buttonStyle}>
              + Add image
            </button>
          </div>
          <For each={draft.images}>
            {(img, i) => (
              <div
                style={{
                  display: 'grid',
                  'grid-template-columns': '1fr 2fr 1fr 1fr auto',
                  gap: '8px',
                  'align-items': 'end',
                  padding: '8px',
                  background: '#15152a',
                  'border-radius': '4px',
                }}
              >
                <label style={labelStyle}>
                  <span>ID</span>
                  <input
                    type="text"
                    value={img.id}
                    onInput={(e) => setDraft('images', i(), 'id', e.currentTarget.value)}
                    style={inputStyle}
                  />
                </label>
                <label style={labelStyle}>
                  <span>Tile source (DZI URL or static image URL)</span>
                  <input
                    type="text"
                    value={img.tileSource}
                    onInput={(e) => setDraft('images', i(), 'tileSource', e.currentTarget.value)}
                    placeholder="https://example.com/image.dzi"
                    style={inputStyle}
                  />
                </label>
                <label style={labelStyle}>
                  <span>Label</span>
                  <input
                    type="text"
                    value={img.label}
                    onInput={(e) => setDraft('images', i(), 'label', e.currentTarget.value)}
                    style={inputStyle}
                  />
                </label>
                <label style={labelStyle}>
                  <span>Thumbnail URL (optional)</span>
                  <input
                    type="text"
                    value={img.thumbnailUrl}
                    onInput={(e) => setDraft('images', i(), 'thumbnailUrl', e.currentTarget.value)}
                    style={inputStyle}
                  />
                </label>
                <button
                  type="button"
                  onClick={() => setDraft('images', (imgs) => imgs.filter((_, idx) => idx !== i()))}
                  style={dangerButtonStyle}
                  aria-label="Remove image"
                >
                  Remove
                </button>
              </div>
            )}
          </For>
        </section>

        {/* Contexts section */}
        <section style={cardStyle}>
          <div
            style={{ display: 'flex', 'align-items': 'center', 'justify-content': 'space-between' }}
          >
            <h2 style={{ margin: '0', 'font-size': '16px' }}>Annotation contexts</h2>
            <button type="button" onClick={addContext} style={buttonStyle}>
              + Add context
            </button>
          </div>
          <For each={draft.contexts}>
            {(ctx, ci) => (
              <div
                style={{
                  padding: '10px',
                  background: '#15152a',
                  'border-radius': '4px',
                  display: 'flex',
                  'flex-direction': 'column',
                  gap: '10px',
                }}
              >
                <div
                  style={{
                    display: 'grid',
                    'grid-template-columns': '1fr 1fr auto',
                    gap: '8px',
                    'align-items': 'end',
                  }}
                >
                  <label style={labelStyle}>
                    <span>ID</span>
                    <input
                      type="text"
                      value={ctx.id}
                      onInput={(e) => setDraft('contexts', ci(), 'id', e.currentTarget.value)}
                      style={inputStyle}
                    />
                  </label>
                  <label style={labelStyle}>
                    <span>Label</span>
                    <input
                      type="text"
                      value={ctx.label}
                      onInput={(e) => setDraft('contexts', ci(), 'label', e.currentTarget.value)}
                      style={inputStyle}
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() =>
                      setDraft('contexts', (cs) => cs.filter((_, idx) => idx !== ci()))
                    }
                    style={dangerButtonStyle}
                  >
                    Remove context
                  </button>
                </div>

                <div>
                  <div style={{ 'font-size': '11px', color: '#aaa', 'margin-bottom': '4px' }}>
                    Applies to images (none selected &rarr; all images)
                  </div>
                  <div style={{ display: 'flex', gap: '10px', 'flex-wrap': 'wrap' }}>
                    <Show
                      when={draft.images.length > 0}
                      fallback={
                        <span style={{ color: '#777', 'font-size': '11px' }}>Add images first</span>
                      }
                    >
                      <For each={draft.images}>
                        {(img) => (
                          <label
                            style={{
                              display: 'flex',
                              gap: '4px',
                              'align-items': 'center',
                              'font-size': '12px',
                              cursor: 'pointer',
                            }}
                          >
                            <input
                              type="checkbox"
                              checked={ctx.imageIds.includes(img.id)}
                              onChange={(e) => {
                                const checked = e.currentTarget.checked;
                                setDraft('contexts', ci(), 'imageIds', (ids) =>
                                  checked ? [...ids, img.id] : ids.filter((x) => x !== img.id),
                                );
                              }}
                            />
                            {img.label || img.id || '(unnamed)'}
                          </label>
                        )}
                      </For>
                    </Show>
                  </div>
                </div>

                <div>
                  <div
                    style={{
                      display: 'flex',
                      'align-items': 'center',
                      'justify-content': 'space-between',
                      'margin-bottom': '4px',
                    }}
                  >
                    <span style={{ 'font-size': '11px', color: '#aaa' }}>Tools</span>
                    <button
                      type="button"
                      onClick={() =>
                        setDraft('contexts', ci(), 'tools', (ts) => [
                          ...ts,
                          { type: 'rectangle', maxCount: '', countScope: '' },
                        ])
                      }
                      style={buttonStyle}
                    >
                      + Add tool
                    </button>
                  </div>
                  <div style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
                    <For each={ctx.tools}>
                      {(tool, ti) => (
                        <div
                          style={{
                            display: 'grid',
                            'grid-template-columns': '2fr 1fr 1fr auto',
                            gap: '6px',
                            'align-items': 'end',
                          }}
                        >
                          <label style={labelStyle}>
                            <span>Type</span>
                            <select
                              value={tool.type}
                              onChange={(e) =>
                                setDraft(
                                  'contexts',
                                  ci(),
                                  'tools',
                                  ti(),
                                  'type',
                                  e.currentTarget.value as ToolType,
                                )
                              }
                              style={inputStyle}
                            >
                              <For each={TOOL_TYPES}>{(t) => <option value={t}>{t}</option>}</For>
                            </select>
                          </label>
                          <label style={labelStyle}>
                            <span>Max count (optional)</span>
                            <input
                              type="number"
                              min="1"
                              value={tool.maxCount}
                              onInput={(e) =>
                                setDraft(
                                  'contexts',
                                  ci(),
                                  'tools',
                                  ti(),
                                  'maxCount',
                                  e.currentTarget.value,
                                )
                              }
                              style={inputStyle}
                            />
                          </label>
                          <label style={labelStyle}>
                            <span>Count scope</span>
                            <select
                              value={tool.countScope}
                              onChange={(e) =>
                                setDraft(
                                  'contexts',
                                  ci(),
                                  'tools',
                                  ti(),
                                  'countScope',
                                  e.currentTarget.value as DraftTool['countScope'],
                                )
                              }
                              style={inputStyle}
                            >
                              <option value="">(default)</option>
                              <option value="per-image">per-image</option>
                              <option value="per-context">per-context</option>
                            </select>
                          </label>
                          <button
                            type="button"
                            onClick={() =>
                              setDraft('contexts', ci(), 'tools', (ts) =>
                                ts.filter((_, idx) => idx !== ti()),
                              )
                            }
                            style={dangerButtonStyle}
                          >
                            Remove
                          </button>
                        </div>
                      )}
                    </For>
                  </div>
                </div>
              </div>
            )}
          </For>
        </section>

        {/* Validation + Launch */}
        <div
          style={{
            display: 'flex',
            'flex-direction': 'column',
            gap: '8px',
            'align-items': 'flex-start',
          }}
        >
          <Show when={!isValid()}>
            <ul
              style={{
                color: '#ff6b6b',
                'font-size': '12px',
                margin: '0',
                padding: '8px 8px 8px 24px',
                background: '#3e1a1a',
                border: '1px solid #8a2a2a',
                'border-radius': '4px',
                'list-style': 'disc',
              }}
            >
              <For each={errors()}>{(err) => <li>{err}</li>}</For>
            </ul>
          </Show>
          <button
            type="button"
            onClick={launch}
            disabled={!isValid()}
            style={{
              ...primaryButtonStyle,
              opacity: isValid() ? '1' : '0.5',
              cursor: isValid() ? 'pointer' : 'not-allowed',
            }}
          >
            Launch annotator
          </button>
        </div>
      </div>
    </div>
  );
}
