"""Ground truth for the parser comparison: pydicom's reading of every PoC file.

    python -I scripts/py/truth.py <data-dir> > results/pydicom-truth.json

Emits, per file, the attributes the adapter maps, normalised to plain JSON
(numbers as floats, multi-values as lists). The bench compares each JS
parser's reading against this.
"""

import json
import os
import sys

import pydicom

FIELDS = [
    "SOPInstanceUID", "Modality", "Rows", "Columns", "NumberOfFrames", "PhotometricInterpretation",
    "BitsAllocated", "BitsStored", "PixelRepresentation", "SamplesPerPixel", "PixelSpacing",
    "ImagerPixelSpacing", "WindowCenter", "WindowWidth", "RescaleSlope", "RescaleIntercept",
    "ImagePositionPatient", "ImageOrientationPatient", "FrameTime", "CineRate",
    "TotalPixelMatrixColumns", "TotalPixelMatrixRows",
]


def norm(v):
    if v is None:
        return None
    if isinstance(v, (list, tuple, pydicom.multival.MultiValue)):
        return [norm(x) for x in v]
    if isinstance(v, (int, float)):
        return float(v)
    try:
        return float(v)
    except (TypeError, ValueError):
        return str(v)


def main() -> None:
    root = sys.argv[1]
    out = {}
    for role in sorted(os.listdir(root)):
        d = os.path.join(root, role)
        for f in sorted(os.listdir(d)):
            if not f.endswith(".dcm"):
                continue
            ds = pydicom.dcmread(os.path.join(d, f), stop_before_pixels=True, force=True)
            rec = {k: norm(ds.get(k)) for k in FIELDS if k in ds}
            shared = ds.get("SharedFunctionalGroupsSequence")
            if shared and "PixelMeasuresSequence" in shared[0]:
                pm = shared[0].PixelMeasuresSequence[0]
                if "PixelSpacing" in pm:
                    rec["SharedPixelSpacing"] = norm(pm.PixelSpacing)
            regions = ds.get("SequenceOfUltrasoundRegions")
            if regions:
                rec["UltrasoundRegionDeltas"] = [
                    [norm(r.get("PhysicalDeltaX")), norm(r.get("PhysicalDeltaY"))] for r in regions
                ]
            out[f"{role}/{f}"] = rec
    json.dump(out, sys.stdout, indent=1)


if __name__ == "__main__":
    main()
