"""Export SAM-family ONNX models whose real weights the sandbox cannot reach.

Latency does not depend on weight values, so for the latency study (H1) each
architecture is built from its upstream source with RANDOM weights and exported
with the same graph the official exporters produce. Quality is NOT measured on
these models; the report cites published numbers instead.

Real-weight models (MobileSAM encoder, SAM decoder, EfficientSAM-Ti) come from
scripts/fetch-models.mjs. This script also writes int8 dynamic-quantised
variants of the real MobileSAM / EfficientSAM-Ti encoders.

Usage (needs torch, onnx, onnxruntime, segment-anything, timm, iopath):
  python -I scripts/export_models.py [--only name,name] [--models-dir DIR]

Outputs go to apps/poc-sam/models/ (git-ignored). Upstream model *source* files
are downloaded from raw.githubusercontent.com into apps/poc-sam/.model-src/.
"""

from __future__ import annotations

import argparse
import importlib
import os
import sys
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
APP = HERE.parent
SRC_CACHE = APP / ".model-src"

RAW = "https://raw.githubusercontent.com"
SOURCES = {
    # EdgeSAM (RepViT-m1 encoder, SAM decoder) - Apache-2.0 / S-Lab license
    "edge_sam/modeling/rep_vit.py": f"{RAW}/chongzhou96/EdgeSAM/master/edge_sam/modeling/rep_vit.py",
    "edge_sam/modeling/common.py": f"{RAW}/chongzhou96/EdgeSAM/master/edge_sam/modeling/common.py",
    # LiteMedSAM (TinyViT at 256 px, stride 4) - Apache-2.0
    "litemedsam/tiny_vit_sam.py": f"{RAW}/bowang-lab/MedSAM/LiteMedSAM/tiny_vit_sam.py",
    # SAM 2.1 (Hiera) - Apache-2.0
    "sam2/modeling/backbones/hieradet.py": f"{RAW}/facebookresearch/sam2/main/sam2/modeling/backbones/hieradet.py",
    "sam2/modeling/backbones/image_encoder.py": f"{RAW}/facebookresearch/sam2/main/sam2/modeling/backbones/image_encoder.py",
    "sam2/modeling/backbones/utils.py": f"{RAW}/facebookresearch/sam2/main/sam2/modeling/backbones/utils.py",
    "sam2/modeling/position_encoding.py": f"{RAW}/facebookresearch/sam2/main/sam2/modeling/position_encoding.py",
    "sam2/modeling/sam/mask_decoder.py": f"{RAW}/facebookresearch/sam2/main/sam2/modeling/sam/mask_decoder.py",
    "sam2/modeling/sam/prompt_encoder.py": f"{RAW}/facebookresearch/sam2/main/sam2/modeling/sam/prompt_encoder.py",
    "sam2/modeling/sam/transformer.py": f"{RAW}/facebookresearch/sam2/main/sam2/modeling/sam/transformer.py",
    "sam2/modeling/sam2_utils.py": f"{RAW}/facebookresearch/sam2/main/sam2/modeling/sam2_utils.py",
    "sam2/utils/misc.py": f"{RAW}/facebookresearch/sam2/main/sam2/utils/misc.py",
}
PACKAGES = [
    "edge_sam",
    "edge_sam/modeling",
    "litemedsam",
    "sam2",
    "sam2/modeling",
    "sam2/modeling/backbones",
    "sam2/modeling/sam",
    "sam2/utils",
]


def fetch_sources() -> None:
    for rel, url in SOURCES.items():
        dest = SRC_CACHE / rel
        if dest.exists():
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        print(f"  fetching {url}")
        with urllib.request.urlopen(url, timeout=60) as r:
            dest.write_bytes(r.read())
    for pkg in PACKAGES:
        init = SRC_CACHE / pkg / "__init__.py"
        init.parent.mkdir(parents=True, exist_ok=True)
        if not init.exists():
            init.write_text("")
    if str(SRC_CACHE) not in sys.path:
        sys.path.insert(0, str(SRC_CACHE))


# --------------------------------------------------------------- exporters --


def export(model, args, path: Path, input_names, output_names, dynamic_axes=None, opset=17):
    import torch

    model.eval()
    t0 = time.time()
    with torch.no_grad():
        torch.onnx.export(
            model,
            args,
            str(path),
            input_names=input_names,
            output_names=output_names,
            dynamic_axes=dynamic_axes,
            opset_version=opset,
            do_constant_folding=True,
            dynamo=False,
        )
    print(f"  wrote {path.name} ({path.stat().st_size / 1e6:.1f} MB) in {time.time() - t0:.1f}s")


def randomize(module) -> None:
    """Default init leaves some parameters at zero (e.g. pos embeds); give every
    float parameter a small random value so no branch is constant-folded away."""
    import torch

    with torch.no_grad():
        for p in module.parameters():
            if p.dtype.is_floating_point:
                p.normal_(0.0, 0.02)


def sam_vit_b_encoder(out: Path) -> None:
    import torch
    from segment_anything import sam_model_registry

    sam = sam_model_registry["vit_b"](checkpoint=None)
    randomize(sam.image_encoder)
    export(
        sam.image_encoder,
        (torch.randn(1, 3, 1024, 1024),),
        out / "sam_vit_b.encoder.rand.onnx",
        ["x"],
        ["image_embeddings"],
    )


def sam_decoder_random(out: Path) -> None:
    """The official SAM ONNX decoder graph (segment_anything.utils.onnx), random
    weights. Same graph as the real one fetched from @geti-ui/smart-tools; kept
    so the exporter path is reproducible end to end."""
    import torch
    from segment_anything import sam_model_registry
    from segment_anything.utils.onnx import SamOnnxModel

    sam = sam_model_registry["vit_b"](checkpoint=None)
    onnx_model = SamOnnxModel(sam, return_single_mask=False)
    emb = torch.randn(1, 256, 64, 64)
    args = (
        emb,
        torch.randint(0, 1024, (1, 5, 2), dtype=torch.float),
        torch.randint(0, 4, (1, 5), dtype=torch.float),
        torch.randn(1, 1, 256, 256),
        torch.tensor([1], dtype=torch.float),
        torch.tensor([1500, 2250], dtype=torch.float),
    )
    export(
        onnx_model,
        args,
        out / "sam_vit_b.decoder.rand.onnx",
        ["image_embeddings", "point_coords", "point_labels", "mask_input", "has_mask_input", "orig_im_size"],
        ["masks", "iou_predictions", "low_res_masks"],
        dynamic_axes={"point_coords": {1: "num_points"}, "point_labels": {1: "num_points"}},
    )


def litemedsam_encoder(out: Path) -> None:
    import torch

    fetch_sources()
    TinyViT = importlib.import_module("litemedsam.tiny_vit_sam").TinyViT
    enc = TinyViT(
        img_size=256,
        in_chans=3,
        embed_dims=[64, 128, 160, 320],
        depths=[2, 2, 6, 2],
        num_heads=[2, 4, 5, 10],
        window_sizes=[7, 7, 14, 7],
        mlp_ratio=4.0,
        drop_rate=0.0,
        drop_path_rate=0.0,
        use_checkpoint=False,
        mbconv_expand_ratio=4.0,
        local_conv_size=3,
        layer_lr_decay=0.8,
    )
    randomize(enc)
    export(enc, (torch.randn(1, 3, 256, 256),), out / "litemedsam.encoder.rand.onnx", ["x"], ["image_embeddings"])


def edge_sam_encoder(out: Path) -> None:
    import torch

    fetch_sources()
    RepViT = importlib.import_module("edge_sam.modeling.rep_vit").RepViT
    enc = RepViT(arch="m1", img_size=1024, upsample_mode="bicubic", fuse=True)
    randomize(enc)
    export(enc, (torch.randn(1, 3, 1024, 1024),), out / "edge_sam.encoder.rand.onnx", ["x"], ["image_embeddings"])


def _sam2_parts():
    import torch
    from torch import nn

    fetch_sources()
    hieradet = importlib.import_module("sam2.modeling.backbones.hieradet")
    image_encoder = importlib.import_module("sam2.modeling.backbones.image_encoder")
    position_encoding = importlib.import_module("sam2.modeling.position_encoding")
    mask_decoder = importlib.import_module("sam2.modeling.sam.mask_decoder")
    prompt_encoder = importlib.import_module("sam2.modeling.sam.prompt_encoder")
    transformer = importlib.import_module("sam2.modeling.sam.transformer")

    # sam2.1_hiera_t.yaml, image path only (memory modules are video-only).
    trunk = hieradet.Hiera(
        embed_dim=96,
        num_heads=1,
        stages=[1, 2, 7, 2],
        global_att_blocks=[5, 7, 9],
        window_pos_embed_bkg_spatial_size=[7, 7],
    )
    neck = image_encoder.FpnNeck(
        position_encoding=position_encoding.PositionEmbeddingSine(
            num_pos_feats=256, normalize=True, scale=None, temperature=10000
        ),
        d_model=256,
        backbone_channel_list=[768, 384, 192, 96],
        fpn_top_down_levels=[2, 3],
        fpn_interp_model="nearest",
    )
    encoder = image_encoder.ImageEncoder(trunk=trunk, neck=neck, scalp=1)
    decoder = mask_decoder.MaskDecoder(
        num_multimask_outputs=3,
        transformer=transformer.TwoWayTransformer(depth=2, embedding_dim=256, mlp_dim=2048, num_heads=8),
        transformer_dim=256,
        iou_head_depth=3,
        iou_head_hidden_dim=256,
        use_high_res_features=True,
        iou_prediction_use_sigmoid=True,
        pred_obj_scores=True,
        pred_obj_scores_mlp=True,
        use_multimask_token_for_obj_ptr=True,
        dynamic_multimask_via_stability=True,
        dynamic_multimask_stability_delta=0.05,
        dynamic_multimask_stability_thresh=0.98,
    )
    prompt = prompt_encoder.PromptEncoder(
        embed_dim=256, image_embedding_size=(64, 64), input_image_size=(1024, 1024), mask_in_chans=16
    )
    no_mem_embed = nn.Parameter(torch.randn(1, 1, 256) * 0.02)
    for m in (encoder, decoder, prompt):
        randomize(m)
    return encoder, decoder, prompt, no_mem_embed


def sam2_tiny(out: Path) -> None:
    import torch
    from torch import nn

    encoder, decoder, prompt, no_mem_embed = _sam2_parts()

    class Sam2Encoder(nn.Module):
        """Image encoder + the high-res projections SAM2Base.forward_image applies,
        + no_mem_embed as SAM2ImagePredictor.set_image does (image mode)."""

        def __init__(self):
            super().__init__()
            self.encoder = encoder
            self.conv_s0 = decoder.conv_s0
            self.conv_s1 = decoder.conv_s1
            self.no_mem_embed = no_mem_embed

        def forward(self, x):
            out = self.encoder(x)
            fpn = out["backbone_fpn"]
            feat0 = self.conv_s0(fpn[0])
            feat1 = self.conv_s1(fpn[1])
            emb = fpn[2] + self.no_mem_embed.reshape(1, 256, 1, 1)
            return feat0, feat1, emb

    class Sam2Decoder(nn.Module):
        """Prompt encoder + mask decoder, SAM-ONNX style point embedding."""

        def __init__(self):
            super().__init__()
            self.prompt = prompt
            self.decoder = decoder

        def _embed_points(self, coords, labels):
            coords = coords + 0.5
            coords = coords / 1024.0
            pe = self.prompt.pe_layer._pe_encoding(coords)
            labels = labels.unsqueeze(-1).expand_as(pe)
            pe = pe * (labels != -1)
            pe = pe + self.prompt.not_a_point_embed.weight * (labels == -1)
            for i in range(self.prompt.num_point_embeddings):
                pe = pe + self.prompt.point_embeddings[i].weight * (labels == i)
            return pe

        def forward(self, image_embed, high_res_feats_0, high_res_feats_1, point_coords, point_labels, mask_input, has_mask_input):
            sparse = self._embed_points(point_coords, point_labels)
            dense = self.prompt.mask_downscaling(mask_input) * has_mask_input + (
                1 - has_mask_input
            ) * self.prompt.no_mask_embed.weight.reshape(1, -1, 1, 1)
            masks, iou, _tokens, _obj = self.decoder.predict_masks(
                image_embeddings=image_embed,
                image_pe=self.prompt.get_dense_pe(),
                sparse_prompt_embeddings=sparse,
                dense_prompt_embeddings=dense,
                repeat_image=False,
                high_res_features=[high_res_feats_0, high_res_feats_1],
            )
            return masks, iou

    export(
        Sam2Encoder(),
        (torch.randn(1, 3, 1024, 1024),),
        out / "sam2.1_hiera_tiny.encoder.rand.onnx",
        ["image"],
        ["high_res_feats_0", "high_res_feats_1", "image_embed"],
    )
    export(
        Sam2Decoder(),
        (
            torch.randn(1, 256, 64, 64),
            torch.randn(1, 32, 256, 256),
            torch.randn(1, 64, 128, 128),
            torch.randint(0, 1024, (1, 5, 2), dtype=torch.float),
            torch.randint(0, 4, (1, 5), dtype=torch.float),
            torch.randn(1, 1, 256, 256),
            torch.tensor([1], dtype=torch.float),
        ),
        out / "sam2.1_hiera_tiny.decoder.rand.onnx",
        ["image_embed", "high_res_feats_0", "high_res_feats_1", "point_coords", "point_labels", "mask_input", "has_mask_input"],
        ["masks", "iou_predictions"],
        dynamic_axes={"point_coords": {1: "num_points"}, "point_labels": {1: "num_points"}},
    )


def quantize(out: Path) -> None:
    from onnxruntime.quantization import QuantType, quantize_dynamic

    for src, dst in [
        ("mobile_sam.encoder.onnx", "mobile_sam.encoder.int8.onnx"),
        ("efficient_sam_vitt_encoder.onnx", "efficient_sam_vitt_encoder.int8.onnx"),
        ("sam_vit_h_4b8939.decoder.onnx", "sam_vit_h_4b8939.decoder.int8.onnx"),
    ]:
        if not (out / src).exists():
            print(f"  skip quantize {src}: run fetch-models first")
            continue
        t0 = time.time()
        quantize_dynamic(str(out / src), str(out / dst), weight_type=QuantType.QUInt8)
        print(f"  wrote {dst} ({(out / dst).stat().st_size / 1e6:.1f} MB) in {time.time() - t0:.1f}s")


EXPORTS = {
    "sam_vit_b": sam_vit_b_encoder,
    "sam_decoder": sam_decoder_random,
    "litemedsam": litemedsam_encoder,
    "edge_sam": edge_sam_encoder,
    "sam2_tiny": sam2_tiny,
    "quantize": quantize,
}


def verify(out: Path) -> None:
    import numpy as np
    import onnxruntime as ort

    for f in sorted(out.glob("*.onnx")):
        s = ort.InferenceSession(str(f), providers=["CPUExecutionProvider"])
        ins = ", ".join(f"{i.name}{i.shape}" for i in s.get_inputs())
        outs = ", ".join(f"{o.name}{o.shape}" for o in s.get_outputs())
        print(f"  {f.name}: in [{ins}] out [{outs}]")
        del s
    _ = np


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--only", default=",".join(EXPORTS))
    p.add_argument("--models-dir", default=str(APP / "models"))
    p.add_argument("--verify", action="store_true")
    a = p.parse_args()
    out = Path(a.models_dir)
    out.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("CUDA_VISIBLE_DEVICES", "")
    for name in a.only.split(","):
        print(f"[{name}]")
        EXPORTS[name](out)
    if a.verify:
        verify(out)


if __name__ == "__main__":
    main()
