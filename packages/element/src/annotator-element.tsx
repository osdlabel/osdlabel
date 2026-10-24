import { render } from 'solid-js/web';
import { createEffect, createSignal, on, onCleanup, type Component, type JSX } from 'solid-js';
import { Annotator, ToolbarView, useAnnotator } from '@osdlabel/solid';
import type { AnnotationId, ToolType } from '@osdlabel/annotation';
import type { AnnotationContext, AnnotationContextId } from '@osdlabel/annotation-context';
import type { ImageId, ImageSource, KeyboardShortcutMap } from '@osdlabel/viewer-api';
import type { DecorationProvider } from '@osdlabel/decoration';
import { getAllAnnotationsFlat } from '@osdlabel/viewer-api';
import { ANNOTATOR_SLOT_NAMES } from 'osdlabel';
import type {
  OsdAnnotation,
  OsdFields,
  ToolbarModel,
  ToolbarSlotProps,
  ToolbarTool,
} from 'osdlabel';
import { groupAnnotationsByImage } from './annotations-io.js';
import {
  BOOLEAN_ATTRIBUTES,
  OBSERVED_ATTRIBUTES,
  isBooleanAttributeName,
  parseBooleanAttribute,
  parseFilmstripPosition,
  type BooleanAttributeName,
  type FilmstripPosition,
} from './attribute-parsing.js';
import {
  createAnnotatorEvent,
  type AnnotatorEventDetailMap,
  type AnnotatorEventName,
} from './element-events.js';

/** The provider value the element drives its imperative API through. */
type AnnotatorApi = ReturnType<typeof useAnnotator>;

export type ShadowMode = 'open' | 'none';

export interface DefineAnnotatorOptions {
  /** Tag to register. Default `osdlabel-annotator`. */
  readonly tagName?: string | undefined;
  /**
   * `'open'` (default) renders into an open shadow root; `'none'` renders into
   * the element's own light-DOM children. See the PoC report (H2) for what
   * each costs.
   */
  readonly shadow?: ShadowMode | undefined;
}

/** The element's public surface: properties for structured inputs, methods for commands. */
export interface OsdlabelAnnotatorElement extends HTMLElement {
  images: readonly ImageSource[];
  contexts: readonly AnnotationContext[];
  /** Flat list, the same shape `annotationschange` carries. Setting it does not fire `annotationschange`. */
  annotations: readonly OsdAnnotation[];
  displayedContextIds: readonly AnnotationContextId[];
  decorationProviders: readonly DecorationProvider<OsdFields>[];
  keyboardShortcuts: Partial<KeyboardShortcutMap> | undefined;
  readonly activeTool: ToolType | 'select' | null;
  readonly selectedAnnotationId: AnnotationId | null;
  /** The shadow root, or the element itself in light-DOM mode. */
  readonly renderRoot: ShadowRoot | HTMLElement;
  /** The toolbar's shared view-model; `null` before mount. See `toolbarmodelchange`. */
  readonly toolbarModel: ToolbarModel | null;
  setActiveTool(tool: ToolType | 'select' | null): void;
  /** As the stock toolbar's buttons do: a no-op for a tool the constraints disable. */
  selectTool(tool: ToolbarTool): void;
  setBrushRadius(radius: number): void;
  setBrushErasing(erasing: boolean): void;
  convertSelectedToRect(): void;
  selectAnnotation(id: AnnotationId | null): void;
  assignImageToCell(cellIndex: number, imageId: ImageId): void;
}

export type OsdlabelAnnotatorElementConstructor = new () => OsdlabelAnnotatorElement;

/** Properties a framework may set before the element is upgraded; see `upgradeProperty`. */
const UPGRADABLE_PROPERTIES = [
  'images',
  'contexts',
  'annotations',
  'displayedContextIds',
  'decorationProviders',
  'keyboardShortcuts',
] as const;

const HOST_CSS =
  ':host{display:block;position:relative}:host([hidden]){display:none}' +
  '.osdlabel-mount{width:100%;height:100%}';

/** Reads the provider value out from inside the Solid tree, and forwards UI changes as DOM events. */
function Bridge(props: {
  readonly onApi: (api: AnnotatorApi | undefined) => void;
  readonly emit: <K extends AnnotatorEventName>(
    name: K,
    detail: AnnotatorEventDetailMap[K],
  ) => void;
}): JSX.Element {
  const api = useAnnotator();
  props.onApi(api);
  onCleanup(() => props.onApi(undefined));
  createEffect(
    on(
      () => api.uiState.selectedAnnotationId,
      (id) => props.emit('selectedannotationchange', { annotationId: id }),
      { defer: true },
    ),
  );
  createEffect(
    on(
      () => api.uiState.activeTool,
      (tool) => props.emit('activetoolchange', { tool }),
      { defer: true },
    ),
  );
  return null;
}

/**
 * Builds (but does not register) the element class. A factory rather than a
 * module-level class so importing the package is side-effect free and safe
 * where `HTMLElement` does not exist (SSR, workers).
 */
export function createAnnotatorElementClass(
  options: DefineAnnotatorOptions = {},
): OsdlabelAnnotatorElementConstructor {
  const shadowMode: ShadowMode = options.shadow ?? 'open';

  class AnnotatorElement extends HTMLElement implements OsdlabelAnnotatorElement {
    static get observedAttributes(): readonly string[] {
      return OBSERVED_ATTRIBUTES;
    }

    readonly #images = createSignal<readonly ImageSource[]>([]);
    readonly #displayed = createSignal<readonly AnnotationContextId[]>([]);
    readonly #providers = createSignal<readonly DecorationProvider<OsdFields>[]>([]);
    readonly #shortcuts = createSignal<Partial<KeyboardShortcutMap> | undefined>(undefined);
    readonly #flags = createSignal<Readonly<Record<BooleanAttributeName, boolean>>>({
      ...BOOLEAN_ATTRIBUTES,
    });
    readonly #filmstripPosition = createSignal<FilmstripPosition>('left');
    #contexts: readonly AnnotationContext[] = [];
    #pendingAnnotations: readonly OsdAnnotation[] = [];
    #api: AnnotatorApi | undefined;
    /** The toolbar slot's props, captured from inside the tree. */
    #toolbar: ToolbarSlotProps | undefined;
    #dispose: (() => void) | undefined;
    #root: ShadowRoot | HTMLElement | undefined;
    /** Set while a property write loads state, so it is not echoed back as a change event. */
    #applyingProperty = false;

    constructor() {
      super();
      for (const name of UPGRADABLE_PROPERTIES) this.#upgradeProperty(name);
    }

    // ── Properties ────────────────────────────────────────────────
    get images(): readonly ImageSource[] {
      return this.#images[0]();
    }
    set images(value: readonly ImageSource[]) {
      this.#images[1](() => value);
    }

    get contexts(): readonly AnnotationContext[] {
      return this.#contexts;
    }
    set contexts(value: readonly AnnotationContext[]) {
      this.#contexts = value;
      const api = this.#api;
      if (!api) return;
      api.actions.setContexts([...value]);
      const active = api.contextState.activeContextId;
      if (!value.some((c) => c.id === active) && value[0])
        api.actions.setActiveContext(value[0].id);
    }

    get annotations(): readonly OsdAnnotation[] {
      const api = this.#api;
      return api ? getAllAnnotationsFlat(api.annotationState) : this.#pendingAnnotations;
    }
    set annotations(value: readonly OsdAnnotation[]) {
      this.#pendingAnnotations = value;
      const api = this.#api;
      if (!api) return;
      this.#applyingProperty = true;
      try {
        api.actions.loadAnnotations(groupAnnotationsByImage(value));
      } finally {
        this.#applyingProperty = false;
      }
    }

    get displayedContextIds(): readonly AnnotationContextId[] {
      return this.#displayed[0]();
    }
    set displayedContextIds(value: readonly AnnotationContextId[]) {
      this.#displayed[1](() => value);
    }

    get decorationProviders(): readonly DecorationProvider<OsdFields>[] {
      return this.#providers[0]();
    }
    set decorationProviders(value: readonly DecorationProvider<OsdFields>[]) {
      // The provider reads this once at mount; a later write takes effect on remount.
      this.#providers[1](() => value);
    }

    get keyboardShortcuts(): Partial<KeyboardShortcutMap> | undefined {
      return this.#shortcuts[0]();
    }
    set keyboardShortcuts(value: Partial<KeyboardShortcutMap> | undefined) {
      this.#shortcuts[1](() => value);
    }

    get activeTool(): ToolType | 'select' | null {
      return this.#api?.uiState.activeTool ?? null;
    }

    get selectedAnnotationId(): AnnotationId | null {
      return this.#api?.uiState.selectedAnnotationId ?? null;
    }

    get toolbarModel(): ToolbarModel | null {
      return this.#toolbar?.model ?? null;
    }

    get renderRoot(): ShadowRoot | HTMLElement {
      return this.#root ?? this;
    }

    // ── Commands ──────────────────────────────────────────────────
    setActiveTool(tool: ToolType | 'select' | null): void {
      this.#api?.actions.setActiveTool(tool);
    }

    selectTool(tool: ToolbarTool): void {
      this.#toolbar?.onSelectTool(tool);
    }

    setBrushRadius(radius: number): void {
      this.#toolbar?.onBrushRadiusChange(radius);
    }

    setBrushErasing(erasing: boolean): void {
      this.#toolbar?.onBrushErasingChange(erasing);
    }

    convertSelectedToRect(): void {
      this.#toolbar?.onConvertToRect();
    }

    selectAnnotation(id: AnnotationId | null): void {
      this.#api?.actions.setSelectedAnnotation(id);
    }

    assignImageToCell(cellIndex: number, imageId: ImageId): void {
      this.#api?.actions.assignImageToCell(cellIndex, imageId);
    }

    // ── Lifecycle ─────────────────────────────────────────────────
    attributeChangedCallback(name: string, _old: string | null, value: string | null): void {
      if (isBooleanAttributeName(name)) {
        const fallback = BOOLEAN_ATTRIBUTES[name];
        this.#flags[1]((prev) => ({ ...prev, [name]: parseBooleanAttribute(value, fallback) }));
      } else if (name === 'filmstrip-position') {
        this.#filmstripPosition[1](parseFilmstripPosition(value));
      }
    }

    connectedCallback(): void {
      if (this.#dispose) return;
      this.#mount();
    }

    disconnectedCallback(): void {
      // A framework moving the element (keyed list reorder, portal) disconnects
      // and reconnects it in one task; only tear down if it stays detached.
      queueMicrotask(() => {
        if (this.isConnected || !this.#dispose) return;
        this.#dispose();
        this.#dispose = undefined;
      });
    }

    #mount(): void {
      const root = this.#ensureRoot();
      const mountPoint = document.createElement('div');
      mountPoint.className = 'osdlabel-mount';
      root.append(mountPoint);

      const [images] = this.#images;
      const [displayed] = this.#displayed;
      const [providers] = this.#providers;
      const [shortcuts] = this.#shortcuts;
      const [flags] = this.#flags;
      const [filmstripPosition] = this.#filmstripPosition;
      const initial = groupAnnotationsByImage(this.#pendingAnnotations);
      const emit = <K extends AnnotatorEventName>(
        name: K,
        detail: AnnotatorEventDetailMap[K],
      ): void => {
        this.dispatchEvent(createAnnotatorEvent(name, detail));
      };

      /**
       * The Toolbar override point. In shadow mode the stock toolbar is the
       * fallback content of `<slot name="toolbar">`, so a host child with
       * `slot="toolbar"` replaces it with no script; that child drives the
       * annotator through `toolbarModel` / `toolbarmodelchange` and the
       * `selectTool()`-style commands. Light DOM has no slots, so there the
       * stock toolbar always renders.
       */
      const ToolbarSlot: Component<ToolbarSlotProps> = (slotProps) => {
        this.#toolbar = slotProps;
        onCleanup(() => {
          this.#toolbar = undefined;
        });
        createEffect(
          on(
            () => slotProps.model,
            (model) => emit('toolbarmodelchange', { model }),
          ),
        );
        const stock = (
          <ToolbarView
            model={slotProps.model}
            onSelectTool={slotProps.onSelectTool}
            onBrushRadiusChange={slotProps.onBrushRadiusChange}
            onBrushErasingChange={slotProps.onBrushErasingChange}
            onConvertToRect={slotProps.onConvertToRect}
          />
        );
        return shadowMode === 'open' ? (
          <slot name={ANNOTATOR_SLOT_NAMES.Toolbar}>{stock}</slot>
        ) : (
          stock
        );
      };

      const disposeTree = render(
        () => (
          <Annotator
            images={images()}
            contexts={this.#contexts}
            displayedContextIds={displayed()}
            initialAnnotations={initial}
            decorationProviders={providers()}
            keyboardShortcuts={shortcuts()}
            showFilmstrip={flags()['show-filmstrip']}
            showGridControls={flags()['show-grid-controls']}
            showContextSwitcher={flags()['show-context-switcher']}
            showViewControls={flags()['show-view-controls']}
            showFullscreenControl={flags()['show-fullscreen-control']}
            showFps={flags()['show-fps']}
            filmstripPosition={filmstripPosition()}
            testMode={flags()['test-mode']}
            components={{ Toolbar: ToolbarSlot }}
            onAnnotationsChange={(annotations) => {
              if (!this.#applyingProperty) emit('annotationschange', { annotations });
            }}
            onConstraintChange={(status) => emit('constraintchange', { status })}
            providerChildren={
              <Bridge
                onApi={(api) => {
                  this.#api = api;
                }}
                emit={emit}
              />
            }
          />
        ),
        mountPoint,
      );
      this.#dispose = () => {
        disposeTree();
        mountPoint.remove();
      };
      const renderedAt = performance.now();
      // Deferred to a microtask: Angular appends an element to its (already
      // connected) parent in the template's creation pass and registers
      // `(osdlabelready)` only afterwards, so an event dispatched synchronously
      // from connectedCallback reached no listener (measured: the Angular host
      // never assigned its image). Its property bindings (`[images]`) land in
      // the update pass, also before the microtask runs.
      queueMicrotask(() => emit('osdlabelready', { renderedAt }));
    }

    #ensureRoot(): ShadowRoot | HTMLElement {
      if (this.#root) return this.#root;
      if (shadowMode === 'open') {
        const shadow = this.shadowRoot ?? this.attachShadow({ mode: 'open' });
        const style = document.createElement('style');
        style.textContent = HOST_CSS;
        shadow.append(style);
        this.#root = shadow;
      } else {
        if (!this.style.display) this.style.display = 'block';
        this.#root = this;
      }
      return this.#root;
    }

    /**
     * A host framework can create the element and assign `el.images = …`
     * before `customElements.define` runs; that write lands as an own data
     * property shadowing the class accessor. Re-assign it through the setter.
     */
    #upgradeProperty(name: (typeof UPGRADABLE_PROPERTIES)[number]): void {
      if (!Object.prototype.hasOwnProperty.call(this, name)) return;
      const value: unknown = Reflect.get(this, name);
      Reflect.deleteProperty(this, name);
      Reflect.set(this, name, value);
    }
  }

  return AnnotatorElement;
}

/**
 * Registers `<osdlabel-annotator>` (or `options.tagName`). Idempotent: a tag
 * that is already defined is left alone and its constructor returned.
 */
export function defineOsdlabelAnnotator(
  options: DefineAnnotatorOptions = {},
): OsdlabelAnnotatorElementConstructor {
  const tagName = options.tagName ?? 'osdlabel-annotator';
  const existing = customElements.get(tagName);
  if (existing) return existing as OsdlabelAnnotatorElementConstructor;
  const ctor = createAnnotatorElementClass(options);
  customElements.define(tagName, ctor);
  return ctor;
}

/** Typed `addEventListener` for the element's events; returns an unsubscribe. */
export function onAnnotatorEvent<K extends AnnotatorEventName>(
  element: EventTarget,
  name: K,
  listener: (event: CustomEvent<AnnotatorEventDetailMap[K]>) => void,
): () => void {
  const handler = (event: Event): void => {
    if (event instanceof CustomEvent) listener(event as CustomEvent<AnnotatorEventDetailMap[K]>);
  };
  element.addEventListener(name, handler);
  return () => element.removeEventListener(name, handler);
}
