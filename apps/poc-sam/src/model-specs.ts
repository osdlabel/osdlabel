/**
 * The model matrix the PoC measures. `weights: 'random'` models are the real
 * architecture exported with random weights (scripts/export_models.py):
 * latency is valid, mask quality is not.
 */
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
  /** Parameter count of the image encoder, for the report. */
  readonly encoderParams: string;
}

export const MODEL_SPECS: readonly ModelSpec[] = [
  {
    id: 'mobile_sam',
    label: 'MobileSAM (TinyViT-5M)',
    family: 'sam1',
    weights: 'real',
    inputSize: 1024,
    encoder: 'mobile_sam.encoder.onnx',
    decoder: 'sam_vit_h_4b8939.decoder.lowres.onnx',
    encoderParams: '5.7M',
  },
  {
    id: 'mobile_sam_int8',
    label: 'MobileSAM int8 (dynamic quant.)',
    family: 'sam1',
    weights: 'real',
    inputSize: 1024,
    encoder: 'mobile_sam.encoder.int8.onnx',
    decoder: 'sam_vit_h_4b8939.decoder.int8.onnx',
    encoderParams: '5.7M',
  },
  {
    id: 'efficient_sam_ti',
    label: 'EfficientSAM-Ti (ViT-Ti)',
    family: 'efficientsam',
    weights: 'real',
    inputSize: 1024,
    encoder: 'efficient_sam_vitt_encoder.onnx',
    decoder: 'efficient_sam_vitt_decoder.onnx',
    encoderParams: '5.7M',
  },
  {
    id: 'edge_sam',
    label: 'EdgeSAM (RepViT-m1)',
    family: 'sam1',
    weights: 'random',
    inputSize: 1024,
    encoder: 'edge_sam.encoder.rand.onnx',
    decoder: 'sam_vit_h_4b8939.decoder.lowres.onnx',
    encoderParams: '5.5M',
  },
  {
    id: 'litemedsam',
    label: 'LiteMedSAM (TinyViT @256)',
    family: 'sam1',
    weights: 'random',
    inputSize: 256,
    encoder: 'litemedsam.encoder.rand.onnx',
    decoder: 'sam_vit_h_4b8939.decoder.lowres.onnx',
    encoderParams: '5.7M',
  },
  {
    id: 'sam2_tiny',
    label: 'SAM 2.1 Hiera-T',
    family: 'sam2',
    weights: 'random',
    inputSize: 1024,
    encoder: 'sam2.1_hiera_tiny.encoder.rand.onnx',
    decoder: 'sam2.1_hiera_tiny.decoder.rand.onnx',
    encoderParams: '27M',
  },
  {
    id: 'sam_vit_b',
    label: 'SAM ViT-B',
    family: 'sam1',
    weights: 'random',
    inputSize: 1024,
    encoder: 'sam_vit_b.encoder.rand.onnx',
    decoder: 'sam_vit_h_4b8939.decoder.lowres.onnx',
    encoderParams: '89M',
  },
];

export function findSpec(id: string): ModelSpec {
  const spec = MODEL_SPECS.find((s) => s.id === id);
  if (!spec) throw new Error(`unknown model ${id}`);
  return spec;
}
