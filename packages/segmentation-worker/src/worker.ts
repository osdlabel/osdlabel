import type {
  ProviderCapabilities,
  SegmentationImageKey,
  SegmentationPrompt,
  SegmentationProvider,
  SegmentationResult,
  SegmentationTarget,
} from '@osdlabel/segmentation';

/**
 * A provider-agnostic Worker RPC: any {@link SegmentationProvider} built inside
 * a worker is driven from the main thread through {@link WorkerSegmentationProvider},
 * which implements the same interface. Inference, tile reads and the
 * embedding cache all stay off the main thread; only prompts go in and
 * low-res rasters (transferred, not copied) come out.
 */
export type ToWorker<TConfig> =
  | { readonly type: 'init'; readonly id: number; readonly config: TConfig }
  | { readonly type: 'prepare'; readonly id: number; readonly target: SegmentationTarget }
  | {
      readonly type: 'segment';
      readonly id: number;
      readonly target: SegmentationTarget;
      readonly prompt: SegmentationPrompt;
    }
  | { readonly type: 'abort'; readonly id: number }
  | { readonly type: 'configure'; readonly id: number; readonly message: unknown }
  | { readonly type: 'dispose'; readonly imageKey?: SegmentationImageKey | undefined };

export type FromWorker =
  | {
      readonly type: 'ready';
      readonly id: number;
      readonly capabilities: ProviderCapabilities;
      readonly info: unknown;
    }
  | {
      readonly type: 'result';
      readonly id: number;
      readonly result: SegmentationResult | null;
      readonly value?: unknown;
    }
  | {
      readonly type: 'error';
      readonly id: number;
      readonly name: string;
      readonly message: string;
    };

/** The bits of a worker / `self` the RPC needs. */
export interface MessagePortLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}

export interface HostedProvider {
  readonly provider: SegmentationProvider;
  readonly info?: unknown;
  /** Handles `configure` messages (e.g. registering an image's pyramid). */
  configure?(message: unknown): unknown;
}

function transferablesOf(result: SegmentationResult): Transferable[] {
  const seen = new Set<ArrayBufferLike>();
  for (const c of result.candidates) seen.add(c.mask.data.buffer);
  return [...seen].filter((b): b is ArrayBuffer => b instanceof ArrayBuffer);
}

/** Worker side: builds the provider from the init config and serves requests. */
export function serveSegmentationWorker<TConfig>(
  scope: MessagePortLike,
  create: (config: TConfig) => Promise<HostedProvider>,
): void {
  let hosted: HostedProvider | null = null;
  const inflight = new Map<number, AbortController>();
  const fail = (id: number, e: unknown): void => {
    const err = e instanceof Error ? e : new Error(String(e));
    scope.postMessage({
      type: 'error',
      id,
      name: err.name,
      message: err.message,
    } satisfies FromWorker);
  };

  scope.addEventListener('message', (event: MessageEvent) => {
    const msg = event.data as ToWorker<TConfig>;
    switch (msg.type) {
      case 'init':
        create(msg.config).then(
          (h) => {
            hosted = h;
            scope.postMessage({
              type: 'ready',
              id: msg.id,
              capabilities: h.provider.capabilities,
              info: h.info ?? null,
            } satisfies FromWorker);
          },
          (e: unknown) => fail(msg.id, e),
        );
        return;
      case 'abort':
        inflight.get(msg.id)?.abort();
        return;
      case 'dispose':
        hosted?.provider.dispose?.(msg.imageKey);
        return;
      case 'configure':
        try {
          const value = hosted?.configure?.(msg.message);
          scope.postMessage({
            type: 'result',
            id: msg.id,
            result: null,
            value,
          } satisfies FromWorker);
        } catch (e) {
          fail(msg.id, e);
        }
        return;
      case 'prepare':
      case 'segment': {
        const h = hosted;
        if (!h) {
          fail(msg.id, new Error('worker not initialised'));
          return;
        }
        const controller = new AbortController();
        inflight.set(msg.id, controller);
        const work =
          msg.type === 'segment'
            ? h.provider.segment(msg.target, msg.prompt, controller.signal)
            : (h.provider.prepare?.(msg.target, controller.signal) ?? Promise.resolve()).then(
                () => null,
              );
        work.then(
          (result) => {
            inflight.delete(msg.id);
            scope.postMessage(
              { type: 'result', id: msg.id, result } satisfies FromWorker,
              result ? transferablesOf(result) : [],
            );
          },
          (e: unknown) => {
            inflight.delete(msg.id);
            fail(msg.id, e);
          },
        );
        return;
      }
    }
  });
}

interface Pending {
  readonly resolve: (msg: FromWorker) => void;
  readonly reject: (e: Error) => void;
}

/** Main-thread side: a {@link SegmentationProvider} backed by a worker. */
export class WorkerSegmentationProvider<TConfig> implements SegmentationProvider {
  private readonly port: MessagePortLike;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private caps: ProviderCapabilities = {
    box: false,
    negativePoints: false,
    multimask: false,
    maskInput: false,
    inputSize: null,
  };

  constructor(port: MessagePortLike) {
    this.port = port;
    port.addEventListener('message', (event: MessageEvent) => {
      const msg = event.data as FromWorker;
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.type === 'error') {
        const err = new Error(msg.message);
        err.name = msg.name;
        p.reject(err);
      } else {
        p.resolve(msg);
      }
    });
  }

  get capabilities(): ProviderCapabilities {
    return this.caps;
  }

  private request(
    build: (id: number) => ToWorker<TConfig>,
    signal?: AbortSignal,
  ): Promise<FromWorker> {
    const id = this.nextId++;
    return new Promise<FromWorker>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      this.pending.set(id, { resolve, reject });
      signal?.addEventListener(
        'abort',
        () => {
          this.port.postMessage({ type: 'abort', id } satisfies ToWorker<TConfig>);
        },
        { once: true },
      );
      this.port.postMessage(build(id));
    });
  }

  async init(config: TConfig): Promise<unknown> {
    const msg = await this.request((id) => ({ type: 'init', id, config }));
    if (msg.type !== 'ready') throw new Error('unexpected init reply');
    this.caps = msg.capabilities;
    return msg.info;
  }

  async configure(message: unknown): Promise<unknown> {
    const msg = await this.request((id) => ({ type: 'configure', id, message }));
    return msg.type === 'result' ? msg.value : undefined;
  }

  async prepare(target: SegmentationTarget, signal: AbortSignal): Promise<void> {
    await this.request((id) => ({ type: 'prepare', id, target }), signal);
  }

  async segment(
    target: SegmentationTarget,
    prompt: SegmentationPrompt,
    signal: AbortSignal,
  ): Promise<SegmentationResult> {
    const msg = await this.request((id) => ({ type: 'segment', id, target, prompt }), signal);
    if (msg.type !== 'result' || !msg.result) throw new Error('unexpected segment reply');
    return msg.result;
  }

  dispose(imageKey?: SegmentationImageKey): void {
    this.port.postMessage({ type: 'dispose', imageKey } satisfies ToWorker<TConfig>);
  }
}
