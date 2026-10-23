"""Derive a 'low-res only' SAM decoder from the official ONNX decoder graph.

The official export (segment_anything.utils.onnx.SamOnnxModel) always
upsamples the 4 low-res mask logits (256x256) to 1024x1024 and then to
orig_im_size inside the graph. For a gigapixel viewport crop the image-space
size can be tens of thousands of pixels, and even at model size the upsample
is pure overhead when the host only needs the mask inside its bounding box.
This keeps every node needed for `iou_predictions` + `low_res_masks` and
drops the rest (onnx.utils.Extractor), then times both graphs natively.

  python -I scripts/lowres_decoder.py [src.onnx] [dst.onnx]
"""

from __future__ import annotations

import statistics
import sys
import time
from pathlib import Path

import numpy as np
import onnx
import onnx.utils
import onnxruntime as ort

APP = Path(__file__).resolve().parent.parent
MODELS = APP / "models"


def feeds(orig=(1024, 1024)):
    return {
        "image_embeddings": np.random.randn(1, 256, 64, 64).astype(np.float32),
        "point_coords": np.array([[[400, 300], [0, 0]]], dtype=np.float32),
        "point_labels": np.array([[1, -1]], dtype=np.float32),
        "mask_input": np.zeros((1, 1, 256, 256), dtype=np.float32),
        "has_mask_input": np.zeros(1, dtype=np.float32),
        "orig_im_size": np.array(orig, dtype=np.float32),
    }


def bench(path: Path, threads: int, fetch=None, orig=(1024, 1024), reps=20) -> float:
    so = ort.SessionOptions()
    so.intra_op_num_threads = threads
    s = ort.InferenceSession(str(path), so, providers=["CPUExecutionProvider"])
    f = {i.name: v for i, v in zip(s.get_inputs(), feeds(orig).values()) if i.name in feeds(orig)}
    f = {k: v for k, v in feeds(orig).items() if k in {i.name for i in s.get_inputs()}}
    s.run(fetch, f)
    t = []
    for _ in range(reps):
        t0 = time.perf_counter()
        s.run(fetch, f)
        t.append((time.perf_counter() - t0) * 1000)
    return statistics.median(t)


def main() -> None:
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else MODELS / "sam_vit_h_4b8939.decoder.onnx"
    dst = Path(sys.argv[2]) if len(sys.argv) > 2 else MODELS / "sam_vit_h_4b8939.decoder.lowres.onnx"
    model = onnx.load(str(src))
    inputs = [i.name for i in model.graph.input if i.name != "orig_im_size"]
    extracted = onnx.utils.Extractor(model).extract_model(inputs, ["iou_predictions", "low_res_masks"])
    onnx.save(extracted, str(dst))
    print(f"wrote {dst.name}: {len(model.graph.node)} -> {len(extracted.graph.node)} nodes")
    for threads in (1, 4):
        full = bench(src, threads)
        full_big = bench(src, threads, orig=(8192, 8192), reps=3)
        subset = bench(src, threads, fetch=["iou_predictions", "low_res_masks"])
        low = bench(dst, threads)
        print(
            f"threads={threads}: full graph {full:.1f} ms | full graph, orig_im_size 8192^2 {full_big:.1f} ms | "
            f"full graph fetching low-res only {subset:.1f} ms | extracted low-res graph {low:.1f} ms"
        )


if __name__ == "__main__":
    main()
