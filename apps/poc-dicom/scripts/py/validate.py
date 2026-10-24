"""Validate the PoC's DICOM exports with independent tools.

    python -I scripts/py/validate.py <export-dir> <expectations.json> > validation.json

For every exported file:
  * dciodvfy (David Clunie's dicom3tools, via the `dicom3tools` wheel): IOD
    conformance — errors and warnings, verbatim.
  * highdicom: parse with the high-level reader for the object type (SR TID
    1500 measurement groups, SEG pixels by source instance, ANN groups), and
    compare what it reads with what osdlabel exported.
Plus a coordinate-frame cross-check: highdicom's ImageToReferenceTransformer
against @osdlabel/dicom's imageToPatient on the same points.
"""

import hashlib
import json
import os
import shutil
import subprocess
import sys

import numpy as np
import highdicom as hd
import pydicom


def dciodvfy(path):
    exe = shutil.which("dciodvfy") or os.path.join(os.path.dirname(sys.executable), "dciodvfy")
    if not os.path.exists(exe):
        return {"available": False}
    p = subprocess.run([exe, "-new", path], capture_output=True, text=True)
    lines = (p.stdout + p.stderr).splitlines()
    errors = [l for l in lines if l.startswith("Error")]
    warnings = [l for l in lines if l.startswith("Warning")]
    return {"available": True, "errors": errors, "warnings": warnings, "iod": [l for l in lines if not l.startswith(("Error", "Warning"))]}


def mask_hash(x, y, w, h, data):
    m = hashlib.sha256()
    m.update(f"{x},{y},{w},{h}|".encode())
    m.update(np.ascontiguousarray(data, dtype=np.uint8).tobytes())
    return m.hexdigest()[:16]


def check_sr(path, exp):
    sr = hd.sr.srread(path)
    groups = list(sr.content.get_planar_roi_measurement_groups()) + list(sr.content.get_image_measurement_groups())
    out = {"groups": len(groups), "shapes": []}
    worst_coord = 0.0
    worst_rel = 0.0
    for e in exp["expected"]:
        g = next((g for g in groups if g.tracking_identifier == e["label"]), None)
        if g is None:
            out["shapes"].append({"id": e["id"], "found": False})
            worst_coord = float("inf")
            continue
        ms = {m.name.meaning: (float(m.value), m.unit.value) for m in g.get_measurements()}
        rel = 0.0
        for em in e["measurements"]:
            got = ms.get(em["name"])
            if got is None or got[1] != em["unit"]:
                rel = float("inf")
            else:
                rel = max(rel, abs(got[0] - em["value"]) / max(abs(em["value"]), 1e-12))
        worst_rel = max(worst_rel, rel)
        roi = getattr(g, "roi", None)
        coord = None
        gt = None
        if roi is not None:
            gt = roi.graphic_type.value
            if exp["mode"] == "2d":
                data = roi.value
                pts = np.array([[p["x"], p["y"]] for p in e["points"]])
                if data.shape == pts.shape:
                    coord = float(np.abs(data - pts).max())
        if coord is not None:
            worst_coord = max(worst_coord, coord)
        out["shapes"].append({"id": e["id"], "found": True, "graphic_type": gt, "coord_error_px": coord,
                              "measurement_rel_error": rel, "template_kind": type(g).__name__})
    out["max_measurement_rel_error"] = worst_rel
    out["max_coord_error_px_planar_rois"] = worst_coord
    return out


def check_seg(path, exp):
    seg = hd.seg.segread(path)
    out = {"segments": [int(s) for s in seg.get_segment_numbers()], "masks": []}
    ok = True
    for m in exp["perMask"]:
        arr = seg.get_pixels_by_source_instance(
            source_sop_instance_uids=[m["sopInstanceUid"]], segment_numbers=[1]
        )
        a = np.asarray(arr)[0, :, :, 0].astype(np.uint8)
        ys, xs = np.nonzero(a)
        x0, y0 = int(xs.min()), int(ys.min())
        w, h = int(xs.max()) - x0 + 1, int(ys.max()) - y0 + 1
        crop = a[y0:y0 + h, x0:x0 + w]
        hsh = mask_hash(x0, y0, w, h, crop)
        same = hsh == m["hash"]
        ok = ok and same
        out["masks"].append({"sop": m["sopInstanceUid"][-12:], "pixels": int(a.sum()), "expected_pixels": m["pixels"],
                             "hash_equal": same})
    out["exact"] = ok
    return out


def check_ann(path, exp):
    ann = hd.ann.annread(path)
    ctype = ann.annotation_coordinate_type
    out = {"coordinate_type": ctype.value, "groups": []}
    worst = 0.0
    for e in exp["expected"]:
        g = next((g for g in ann.get_annotation_groups() if g.label == e["label"]), None)
        if g is None:
            out["groups"].append({"label": e["label"], "found": False})
            worst = float("inf")
            continue
        data = g.get_graphic_data(coordinate_type=ctype)[0]
        if ctype.value == "2D":
            ref = np.array([[p["x"], p["y"]] for p in e["points"]])
        else:
            ref = np.array(e["slide"])
        gt = g.graphic_type.value
        # POLYGON in ANN is implicitly closed; our expected points come from
        # SCOORD (closed by repetition) for rectangles/polygons.
        if gt in ("POLYGON", "RECTANGLE") and len(ref) == len(data) + 1:
            ref = ref[:-1]
        err = float(np.abs(np.asarray(data, dtype=float) - ref).max()) if data.shape == ref.shape else None
        if gt == "ELLIPSE":
            err = None  # expected points are SCOORD CIRCLE form; compared node-side
        if err is not None:
            worst = max(worst, err)
        out["groups"].append({"label": e["label"], "graphic_type": gt, "max_abs_error": err})
    out["max_abs_error"] = worst
    out["unit"] = "px" if ctype.value == "2D" else "mm"
    return out


def check_transforms(planes):
    res = {}
    for name, p in planes.items():
        if p is None:
            continue
        t = hd.spatial.ImageToReferenceTransformer(
            image_position=p["position"],
            image_orientation=list(p["rowDirection"]) + list(p["columnDirection"]),
            pixel_spacing=[p["spacing"]["y"], p["spacing"]["x"]],
        )
        pts = np.array([[q["x"], q["y"]] for q in p["samples"]])
        ref = t(pts)
        ours = np.array(p["ours"])
        res[name] = {"max_abs_diff_mm": float(np.abs(ref - ours).max()), "points": len(pts)}
    return res


def parse_only(path):
    """Validate a file with no expectations: dciodvfy + a highdicom read of its type."""
    ds = pydicom.dcmread(path)
    r = {"dciodvfy": dciodvfy(path), "sop_class": str(ds.SOPClassUID.name)}
    try:
        if ds.Modality == "SR":
            sr = hd.sr.srread(path)
            groups = (list(sr.content.get_planar_roi_measurement_groups())
                      + list(sr.content.get_volumetric_roi_measurement_groups())
                      + list(sr.content.get_image_measurement_groups()))
            r["highdicom"] = {"groups": len(groups), "measurements": [
                [m.name.meaning, float(m.value), m.unit.value] for g in groups for m in g.get_measurements()]}
        elif ds.Modality == "SEG":
            seg = hd.seg.segread(path)
            # Foreground per segment, same rule as @osdlabel/dicom-export's
            # reader: BINARY as is, FRACTIONAL thresholded at half the maximum.
            arr = np.asarray(ds.pixel_array).reshape(int(ds.NumberOfFrames), ds.Rows, ds.Columns)
            if ds.SegmentationType == "FRACTIONAL":
                arr = arr > (0.5 * float(ds.get("MaximumFractionalValue", 255)))
            pixels = {}
            shared = ds.get("SharedFunctionalGroupsSequence")
            for f in range(arr.shape[0]):
                fg = ds.PerFrameFunctionalGroupsSequence[f]
                sid = fg.get("SegmentIdentificationSequence") or (shared[0].get("SegmentIdentificationSequence") if shared else None)
                n = int(sid[0].ReferencedSegmentNumber)
                pixels[n] = pixels.get(n, 0) + int(np.count_nonzero(arr[f]))
            r["highdicom"] = {"segments": [int(s) for s in seg.get_segment_numbers()], "frames": int(ds.NumberOfFrames),
                              "sources": len(seg.get_source_image_uids()), "type": str(ds.SegmentationType),
                              "pixelsPerSegment": pixels}
        elif ds.Modality == "ANN":
            ann = hd.ann.annread(path)
            r["highdicom"] = {"groups": [(g.label, g.graphic_type.value, int(g.number_of_annotations))
                                         for g in ann.get_annotation_groups()]}
        r["highdicom_ok"] = True
    except Exception as e:
        r["highdicom_ok"] = False
        r["highdicom_error"] = f"{type(e).__name__}: {e}"[:400]
    return r


def main():
    if sys.argv[1] == "--files":
        out = {"highdicom": hd.__version__, "files": {os.path.basename(p): parse_only(p) for p in sys.argv[2:]}}
        json.dump(out, sys.stdout, indent=1, default=float)
        return
    export_dir, exp_path = sys.argv[1], sys.argv[2]
    with open(exp_path) as f:
        expectations = json.load(f)
    results = {"highdicom": hd.__version__, "pydicom": pydicom.__version__, "files": {}}
    for case in expectations["cases"]:
        path = os.path.join(export_dir, case["file"])
        r = {"dciodvfy": dciodvfy(path)}
        try:
            if case["kind"] == "SR":
                r["highdicom"] = check_sr(path, case)
            elif case["kind"] == "SEG":
                r["highdicom"] = check_seg(path, case)
            elif case["kind"] == "ANN":
                r["highdicom"] = check_ann(path, case)
            r["highdicom_ok"] = True
        except Exception as e:  # report, do not hide
            r["highdicom_ok"] = False
            r["highdicom_error"] = f"{type(e).__name__}: {e}"[:400]
        results["files"][case["file"]] = r
    results["transforms"] = check_transforms(expectations["planes"])
    json.dump(results, sys.stdout, indent=1, default=float)


if __name__ == "__main__":
    main()
