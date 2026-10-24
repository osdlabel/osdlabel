#!/usr/bin/env python3
"""Generate the synthetic test videos for the video PoC.

Every frame burns its own index into the pixels as a 16-bit barcode, so a
harness can check programmatically which frame it is looking at:

  band 1 (y in [0, band_h)):         16 blocks, MSB first, white = 1, black = 0
  band 2 (y in [band_h, 2*band_h)):  the same bits inverted (a parity check:
                                     a blended or corrupted frame fails it)
  y in [2*band_h, 3*band_h):         flat grey, reserved for the overlay's
                                     own barcode in the render benchmark
  a pure red square (the "marker") at a fixed image position, used by the
  render benchmark to measure overlay-vs-video spatial sync, with a 4x4
  copy of the index right under it (readable when zoomed in)

The rest is moving texture (drifting stripes, a moving box, fixed noise) so
the encoder does real motion-compensated work. Output goes to ../media/
(gitignored) with a manifest.json holding ffprobe's ground truth: every
frame's presentation timestamp and which frames are keyframes.

Usage: python3 scripts/gen-videos.py [--only name1,name2] [--force]
Needs ffmpeg/ffprobe with libx264, libvpx-vp9 and libsvtav1, and numpy.
"""

import argparse
import json
import os
import subprocess
import sys
from fractions import Fraction

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
MEDIA = os.path.join(HERE, "..", "media")
BITS = 16

# name, codec, container, width, height, fps (rational), gop, bframes, frames, vfr
VARIANTS = [
    ("h264-720p-30-g30-bf", "h264", "mp4", 1280, 720, "30", 30, 3, 300, False),
    ("h264-720p-30-g30-nobf", "h264", "mp4", 1280, 720, "30", 30, 0, 300, False),
    ("h264-720p-30-g1", "h264", "mp4", 1280, 720, "30", 1, 0, 300, False),
    ("h264-720p-30-g250-bf", "h264", "mp4", 1280, 720, "30", 250, 3, 300, False),
    ("h264-720p-2997-g30-bf", "h264", "mp4", 1280, 720, "30000/1001", 30, 3, 300, False),
    ("h264-720p-vfr-g30-bf", "h264", "mp4", 1280, 720, "30", 30, 3, 300, True),
    ("h264-1080p-30-g30-bf", "h264", "mp4", 1920, 1080, "30", 30, 3, 300, False),
    ("h264-1080p-2997-g250-bf", "h264", "mp4", 1920, 1080, "30000/1001", 250, 3, 300, False),
    ("vp9-720p-30-g30", "vp9", "webm", 1280, 720, "30", 30, 0, 300, False),
    ("vp9-720p-2997-g250", "vp9", "webm", 1280, 720, "30000/1001", 250, 0, 300, False),
    ("vp9-1080p-30-g30", "vp9", "webm", 1920, 1080, "30", 30, 0, 300, False),
    ("av1-720p-30-g30", "av1", "mp4", 1280, 720, "30", 30, 0, 300, False),
]


def layout(w, h):
    band_h = round(h / 18)
    s = round(h / 10)
    return {
        "bits": BITS,
        "bandH": band_h,
        "blockW": w / BITS,
        "marker": {"x": w // 2 - s, "y": round(h * 0.15), "size": s},
        # 4x4 copy of the low 16 bits right under the marker, MSB first, row
        # major: readable from a screenshot even when the view is zoomed in.
        "compact": {"x": w // 2 - s, "y": round(h * 0.15) + s, "cell": s // 4},
    }


def make_frames(w, h, n):
    lay = layout(w, h)
    band_h = lay["bandH"]
    m = lay["marker"]
    rng = np.random.default_rng(1234)
    # A small pool of temporal noise fields keeps the bitrate in the range of
    # real camera footage (several Mbit/s) instead of a few hundred kbit/s.
    noise_pool = [rng.integers(-7, 7, size=(h, w), dtype=np.int16) for _ in range(7)]
    yy, xx = np.mgrid[0:h, 0:w].astype(np.int32)
    diag = xx + yy
    base_b = (60 + 80 * xx / w).astype(np.int16)
    img = np.empty((h, w, 3), dtype=np.int16)
    for i in range(n):
        g = (70 + 50 * (((diag + 4 * i) // 24) % 2)).astype(np.int16)
        img[..., 0] = g - 10
        img[..., 1] = g
        img[..., 2] = base_b
        img += noise_pool[i % 7][..., None]
        # moving box
        bx = int((i * 7) % (w - 200))
        by = int(h * 0.55 + (h * 0.2) * np.sin(i / 15))
        img[by : by + 120, bx : bx + 160, :] = (200, 180, 40)
        out = np.clip(img, 0, 255).astype(np.uint8)
        # barcode bands
        for k in range(BITS):
            bit = (i >> (BITS - 1 - k)) & 1
            x0 = round(k * w / BITS)
            x1 = round((k + 1) * w / BITS)
            out[0:band_h, x0:x1, :] = 255 if bit else 0
            out[band_h : 2 * band_h, x0:x1, :] = 0 if bit else 255
        out[2 * band_h : 3 * band_h, :, :] = 128
        out[m["y"] : m["y"] + m["size"], m["x"] : m["x"] + m["size"], :] = (255, 0, 0)
        c = lay["compact"]
        for k in range(16):
            bit = (i >> (15 - k)) & 1
            cx0 = c["x"] + (k % 4) * c["cell"]
            cy0 = c["y"] + (k // 4) * c["cell"]
            out[cy0 : cy0 + c["cell"], cx0 : cx0 + c["cell"], :] = 255 if bit else 0
        yield out.tobytes()


def encode(v, out):
    name, codec, container, w, h, fps, gop, bf, n, vfr = v
    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}", "-r", fps, "-i", "-",
    ]
    if vfr:
        # Durations cycle 1/30, 1/60, 1/20 s: pts(N) = floor(N/3)*0.1 + {0, 1/30, 1/20}.
        # Integer ticks of a 1/600 timebase, passed through untouched to the muxer.
        cmd += [
            "-vf", "settb=1/600,setpts='floor(N/3)*60+eq(mod(N,3),1)*20+eq(mod(N,3),2)*30'",
            "-fps_mode", "passthrough", "-enc_time_base", "1/600",
        ]
    # Bitrate typical of camera / endoscopy footage, so decode cost is realistic.
    rate = "12M" if h >= 1080 else "6M"
    if codec == "h264":
        cmd += [
            "-c:v", "libx264", "-preset", "veryfast", "-b:v", rate, "-maxrate", rate, "-bufsize", rate, "-pix_fmt", "yuv420p",
            "-g", str(gop), "-keyint_min", str(gop), "-sc_threshold", "0", "-bf", str(bf),
            "-x264-params", f"keyint={gop}:min-keyint={gop}:scenecut=0:open-gop=0",
        ]
        cmd += ["-movflags", "+faststart"]
    elif codec == "vp9":
        cmd += [
            "-c:v", "libvpx-vp9", "-deadline", "good", "-cpu-used", "5", "-row-mt", "1",
            "-b:v", rate, "-g", str(gop), "-keyint_min", str(gop), "-pix_fmt", "yuv420p",
        ]
    elif codec == "av1":
        cmd += ["-c:v", "libsvtav1", "-preset", "10", "-b:v", rate, "-g", str(gop), "-pix_fmt", "yuv420p"]
        cmd += ["-movflags", "+faststart"]
    cmd += [out]
    p = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    for frame in make_frames(w, h, n):
        p.stdin.write(frame)
    p.stdin.close()
    if p.wait() != 0:
        raise SystemExit(f"ffmpeg failed for {name}")


def probe(path):
    """Ground truth from ffprobe: presentation timestamps (decoder output order) and keyframes."""
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
         "stream=time_base,r_frame_rate,avg_frame_rate,codec_name:frame=pts,pkt_dts,key_frame,pict_type",
         "-of", "json", "-show_frames", path],
        capture_output=True, check=True, text=True,
    )
    d = json.loads(r.stdout)
    st = d["streams"][0]
    tb = Fraction(st["time_base"])
    frames = d["frames"]
    pts = [int(f["pts"]) for f in frames]
    order = sorted(range(len(pts)), key=lambda i: pts[i])
    pts_us = [float(pts[i] * tb * 1_000_000) for i in order]
    keys = [k for k, i in enumerate(order) if frames[i].get("key_frame") == 1]
    pkt = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts,dts,flags",
         "-of", "json", "-show_packets", path],
        capture_output=True, check=True, text=True,
    )
    packets = json.loads(pkt.stdout)["packets"]
    reordered = sum(1 for p in packets if p.get("pts") is not None and p.get("dts") is not None and p["pts"] != p["dts"])
    pts_sorted = sorted(int(p["pts"]) for p in packets if p.get("pts") is not None)
    out_of_order = sum(1 for a, b in zip(packets, packets[1:]) if int(b["pts"]) < int(a["pts"]))
    return {
        "codecName": st["codec_name"],
        "timeBase": st["time_base"],
        "rFrameRate": st["r_frame_rate"],
        "avgFrameRate": st["avg_frame_rate"],
        "frameCount": len(pts_us),
        "packetCount": len(packets),
        "ptsUs": pts_us,
        "keyframes": keys,
        "packetsWithPtsNeDts": reordered,
        "decodeOrderInversions": out_of_order,
        "firstPtsTb": pts_sorted[0] if pts_sorted else None,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="")
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()
    only = set(x for x in a.only.split(",") if x)
    os.makedirs(MEDIA, exist_ok=True)
    manifest_path = os.path.join(MEDIA, "manifest.json")
    manifest = {}
    if os.path.exists(manifest_path) and not a.force:
        with open(manifest_path) as f:
            manifest = json.load(f)
    for v in VARIANTS:
        name, codec, container, w, h, fps, gop, bf, n, vfr = v
        if only and name not in only:
            continue
        out = os.path.join(MEDIA, f"{name}.{container}")
        if os.path.exists(out) and name in manifest and not a.force:
            continue
        print(f"encoding {name} ...", file=sys.stderr, flush=True)
        encode(v, out)
        info = probe(out)
        fr = Fraction(fps)
        manifest[name] = {
            "name": name, "file": f"{name}.{container}", "codec": codec, "container": container,
            "width": w, "height": h, "fpsNum": fr.numerator, "fpsDen": fr.denominator,
            "gop": gop, "bframes": bf, "vfr": vfr, "bytes": os.path.getsize(out),
            "layout": layout(w, h), **info,
        }
        with open(manifest_path, "w") as f:
            json.dump(manifest, f, indent=1)
    print(json.dumps({k: {"frames": m["frameCount"], "keys": len(m["keyframes"]), "bytes": m["bytes"]} for k, m in manifest.items()}, indent=0))


if __name__ == "__main__":
    main()
