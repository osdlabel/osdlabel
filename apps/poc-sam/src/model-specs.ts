/**
 * The model matrix the PoC measures, read from `model-table.json` (also read
 * by scripts/bench.mjs and scripts/remote-sam-server.mjs, so there is one
 * list). `weights: 'random'` models are the real architecture exported with
 * random weights (scripts/export_models.py): latency is valid, mask quality
 * is not.
 */
import table from './model-table.json';

export type ModelFamily = 'sam1' | 'efficientsam' | 'sam2';

export interface ModelSpec {
  readonly id: string;
  readonly label: string;
  readonly family: ModelFamily;
  readonly weights: 'real' | 'random';
  /** Encoder input side (square). */
  readonly inputSize: number;
  readonly encoder: string;
  readonly decoder: string;
  /** Used when `decoder` is missing (the low-res decoder needs Python to derive). */
  readonly decoderFallback?: string;
  /** Parameter count of the image encoder, for the report. */
  readonly encoderParams: string;
  readonly source: string;
}

const FAMILIES: readonly ModelFamily[] = ['sam1', 'efficientsam', 'sam2'];

function parse(row: (typeof table)[number]): ModelSpec {
  const family = FAMILIES.find((f) => f === row.family);
  if (!family) throw new Error(`model-table.json: unknown family ${row.family}`);
  if (row.weights !== 'real' && row.weights !== 'random') {
    throw new Error(`model-table.json: bad weights ${row.weights}`);
  }
  const fallback = 'decoderFallback' in row ? row.decoderFallback : undefined;
  return {
    id: row.id,
    label: row.label,
    family,
    weights: row.weights,
    inputSize: row.inputSize,
    encoder: row.encoder,
    decoder: row.decoder,
    ...(fallback !== undefined ? { decoderFallback: fallback } : {}),
    encoderParams: row.encoderParams,
    source: row.source,
  };
}

export const MODEL_SPECS: readonly ModelSpec[] = table.map(parse);

export function findSpec(id: string): ModelSpec {
  const spec = MODEL_SPECS.find((s) => s.id === id);
  if (!spec) throw new Error(`unknown model ${id}`);
  return spec;
}

/** The URL of the first model file the server has. */
export async function modelUrl(file: string, fallback?: string): Promise<string> {
  const primary = new URL(`/models/${file}`, location.href).href;
  if (!fallback) return primary;
  const res = await fetch(primary, { method: 'HEAD' });
  return res.ok ? primary : new URL(`/models/${fallback}`, location.href).href;
}
