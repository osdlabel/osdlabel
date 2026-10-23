"""Native (onnxruntime CPU, MLAS) reference latency for every model the
browser benchmark measures. This is the 'server-side' baseline the remote
topology would get on the same machine, and the gap to WASM shows what the
browser costs. Writes results/native-<stamp>.json and prints a table.

  python -I scripts/native_bench.py [--reps 5] [--threads 1,4]
"""

from __future__ import annotations

import argparse
import json
import statistics
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort

HERE = Path(__file__).resolve().parent
APP = HERE.parent
MODELS = APP / "models"

# name -> (file, feeds factory)
SAM1_DEC = "sam_vit_h_4b8939.decoder.onnx"


def enc_feeds(size: int, name: str = "x"):
    return lambda: {name: np.random.rand(1, 3, size, size).astype(np.float32)}


def sam1_dec_feeds():
    return {
        "image_embeddings": np.random.randn(1, 256, 64, 64).astype(np.float32),
        "point_coords": np.array([[[400, 300], [0, 0]]], dtype=np.float32),
        "point_labels": np.array([[1, -1]], dtype=np.float32),
        "mask_input": np.zeros((1, 1, 256, 256), dtype=np.float32),
        "has_mask_input": np.zeros(1, dtype=np.float32),
        "orig_im_size": np.array([1024, 1024], dtype=np.float32),
    }


def esam_dec_feeds():
    return {
        "image_embeddings": np.random.randn(1, 256, 64, 64).astype(np.float32),
        "batched_point_coords": np.array([[[[400, 300]]]], dtype=np.float32),
        "batched_point_labels": np.array([[[1]]], dtype=np.float32),
        "orig_im_size": np.array([1024, 1024], dtype=np.int64),
    }


def sam2_dec_feeds():
    return {
        "image_embed": np.random.randn(1, 256, 64, 64).astype(np.float32),
        "high_res_feats_0": np.random.randn(1, 32, 256, 256).astype(np.float32),
        "high_res_feats_1": np.random.randn(1, 64, 128, 128).astype(np.float32),
        "point_coords": np.array([[[400, 300], [0, 0]]], dtype=np.float32),
        "point_labels": np.array([[1, -1]], dtype=np.float32),
        "mask_input": np.zeros((1, 1, 256, 256), dtype=np.float32),
        "has_mask_input": np.zeros(1, dtype=np.float32),
    }


CASES = [
    ("mobile_sam/encoder", "mobile_sam.encoder.onnx", enc_feeds(1024)),
    ("mobile_sam/encoder-int8", "mobile_sam.encoder.int8.onnx", enc_feeds(1024)),
    ("efficient_sam_ti/encoder", "efficient_sam_vitt_encoder.onnx", enc_feeds(1024, "batched_images")),
    ("efficient_sam_ti/encoder-int8", "efficient_sam_vitt_encoder.int8.onnx", enc_feeds(1024, "batched_images")),
    ("edge_sam/encoder", "edge_sam.encoder.rand.onnx", enc_feeds(1024)),
    ("litemedsam/encoder", "litemedsam.encoder.rand.onnx", enc_feeds(256)),
    ("sam2.1_tiny/encoder", "sam2.1_hiera_tiny.encoder.rand.onnx", enc_feeds(1024, "image")),
    ("sam_vit_b/encoder", "sam_vit_b.encoder.rand.onnx", enc_feeds(1024)),
    ("sam/decoder", SAM1_DEC, sam1_dec_feeds),
    ("sam/decoder-int8", "sam_vit_h_4b8939.decoder.int8.onnx", sam1_dec_feeds),
    ("efficient_sam_ti/decoder", "efficient_sam_vitt_decoder.onnx", esam_dec_feeds),
    ("sam2.1_tiny/decoder", "sam2.1_hiera_tiny.decoder.rand.onnx", sam2_dec_feeds),
]


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--reps", type=int, default=5)
    p.add_argument("--threads", default="1,4")
    p.add_argument("--only", default="")
    a = p.parse_args()
    rows = []
    for threads in [int(t) for t in a.threads.split(",")]:
        for name, file, feeds in CASES:
            if a.only and a.only not in name:
                continue
            path = MODELS / file
            if not path.exists():
                print(f"skip {name}: {file} missing")
                continue
            so = ort.SessionOptions()
            so.intra_op_num_threads = threads
            so.inter_op_num_threads = 1
            t0 = time.perf_counter()
            s = ort.InferenceSession(str(path), so, providers=["CPUExecutionProvider"])
            create_ms = (time.perf_counter() - t0) * 1000
            f = feeds()
            reps = a.reps if "encoder" in name else a.reps * 4
            s.run(None, f)  # warm-up
            times = []
            for _ in range(reps):
                t0 = time.perf_counter()
                s.run(None, f)
                times.append((time.perf_counter() - t0) * 1000)
            row = {
                "case": name,
                "file": file,
                "threads": threads,
                "create_ms": round(create_ms, 1),
                "median_ms": round(statistics.median(times), 1),
                "min_ms": round(min(times), 1),
                "max_ms": round(max(times), 1),
                "reps": reps,
            }
            rows.append(row)
            print(f"{name:32s} t={threads} median {row['median_ms']:8.1f} ms  (min {row['min_ms']:.1f}, max {row['max_ms']:.1f}, create {row['create_ms']:.0f})")
            del s
    out = APP / "results" / f"native-{time.strftime('%Y%m%d-%H%M%S')}.json"
    out.parent.mkdir(exist_ok=True)
    out.write_text(json.dumps({"runtime": f"onnxruntime {ort.__version__} CPU", "rows": rows}, indent=2))
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
