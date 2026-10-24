"""int8 variants of the MobileSAM encoder and the SAM decoder (review finding B1).

    python scripts/quantize_variants.py --models models --calib <dir from calib-inputs.mjs>

Writes, next to the fp32 graphs:

  mobile_sam.encoder.int8.onnx           dynamic, every default op (Conv -> ConvInteger,
                                          MatMul -> MatMulInteger), QUInt8 weights.
                                          The variant the first PoC run measured
                                          (export_models.py `quantize`); rewritten only
                                          when missing.
  mobile_sam.encoder.int8mm.onnx         dynamic, MatMul only (Conv stays fp32), QInt8 weights.
  mobile_sam.encoder.qdq.onnx            static QDQ, per-channel QInt8 weights, QUInt8
                                          activations, MinMax calibration on
                                          synthetic views (not the scenario's).
  sam_vit_h_4b8939.decoder.lowres.int8.onnx
                                          dynamic, default ops, QUInt8 weights: the
                                          same recipe as the existing full-graph
                                          int8 decoder, applied to the low-res graph,
                                          so int8 vs fp32 decoders compare graph for graph.

Needs onnx + onnxruntime (>= 1.17) and numpy.
"""

from __future__ import annotations

import argparse
import time
from pathlib import Path

import numpy as np


def dynamic(src: Path, dst: Path, *, op_types: list[str] | None, weight: str) -> None:
    from onnxruntime.quantization import QuantType, quantize_dynamic

    t0 = time.time()
    quantize_dynamic(
        str(src),
        str(dst),
        op_types_to_quantize=op_types,
        weight_type=QuantType.QInt8 if weight == "s8" else QuantType.QUInt8,
    )
    print(f"  wrote {dst.name} ({dst.stat().st_size / 1e6:.1f} MB) in {time.time() - t0:.1f}s")


class RawReader:
    """CalibrationDataReader over raw float32 [1,3,1024,1024] files."""

    def __init__(self, files: list[Path], input_name: str) -> None:
        self.files = iter(files)
        self.input_name = input_name

    def get_next(self):  # noqa: ANN201 - onnxruntime's protocol
        f = next(self.files, None)
        if f is None:
            return None
        x = np.fromfile(f, dtype=np.float32).reshape(1, 3, 1024, 1024)
        return {self.input_name: x}


def static_qdq(src: Path, dst: Path, calib: list[Path]) -> None:
    from onnxruntime.quantization import (
        CalibrationMethod,
        QuantFormat,
        QuantType,
        quantize_static,
    )
    from onnxruntime.quantization.shape_inference import quant_pre_process

    pre = dst.with_suffix(".pre.onnx")
    t0 = time.time()
    quant_pre_process(str(src), str(pre), skip_symbolic_shape=False)
    import onnx

    name = onnx.load(str(pre), load_external_data=False).graph.input[0].name
    quantize_static(
        str(pre),
        str(dst),
        RawReader(calib, name),
        quant_format=QuantFormat.QDQ,
        per_channel=True,
        activation_type=QuantType.QUInt8,
        weight_type=QuantType.QInt8,
        calibrate_method=CalibrationMethod.MinMax,
    )
    pre.unlink(missing_ok=True)
    print(
        f"  wrote {dst.name} ({dst.stat().st_size / 1e6:.1f} MB) in {time.time() - t0:.1f}s "
        f"from {len(calib)} calibration views"
    )


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", type=Path, default=Path(__file__).resolve().parent.parent / "models")
    ap.add_argument("--calib", type=Path, required=True)
    ap.add_argument("--only", default="int8,int8mm,qdq,declr")
    a = ap.parse_args()
    only = set(a.only.split(","))
    m = a.models
    enc = m / "mobile_sam.encoder.onnx"
    if "int8" in only and not (m / "mobile_sam.encoder.int8.onnx").exists():
        dynamic(enc, m / "mobile_sam.encoder.int8.onnx", op_types=None, weight="u8")
    if "int8mm" in only:
        dynamic(enc, m / "mobile_sam.encoder.int8mm.onnx", op_types=["MatMul"], weight="s8")
    if "qdq" in only:
        calib = sorted(a.calib.glob("calib-*.f32"))
        if not calib:
            raise SystemExit(f"no calib-*.f32 in {a.calib}: run scripts/calib-inputs.mjs first")
        static_qdq(enc, m / "mobile_sam.encoder.qdq.onnx", calib)
    if "declr" in only:
        dynamic(
            m / "sam_vit_h_4b8939.decoder.lowres.onnx",
            m / "sam_vit_h_4b8939.decoder.lowres.int8.onnx",
            op_types=None,
            weight="u8",
        )


if __name__ == "__main__":
    main()
