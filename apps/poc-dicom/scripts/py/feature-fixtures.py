"""Writes small synthetic Part 10 files that exercise parser features the
IDC sample does not: UTF-8 text, Explicit VR Big Endian, Deflated Explicit VR
Little Endian, and a Latin-1 (ISO_IR 100) name. No patient data: every value
is made up. Used by scripts/lib/parser-features.mjs.

    python -I feature-fixtures.py OUT_DIR    -> prints a JSON manifest
"""

import json
import sys
from pathlib import Path

import numpy as np
import pydicom
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.uid import (
    DeflatedExplicitVRLittleEndian,
    ExplicitVRBigEndian,
    ExplicitVRLittleEndian,
    ImplicitVRLittleEndian,
    SecondaryCaptureImageStorage,
    generate_uid,
)


def base(charset, name):
    ds = Dataset()
    ds.SpecificCharacterSet = charset
    ds.SOPClassUID = SecondaryCaptureImageStorage
    ds.SOPInstanceUID = generate_uid()
    ds.StudyInstanceUID = generate_uid()
    ds.SeriesInstanceUID = generate_uid()
    ds.Modality = "OT"
    ds.PatientName = name
    ds.StudyDescription = name.replace("^", " ")
    ds.Rows = 4
    ds.Columns = 3
    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = "MONOCHROME2"
    ds.BitsAllocated = 16
    ds.BitsStored = 12
    ds.HighBit = 11
    ds.PixelRepresentation = 0
    ds.PixelSpacing = [0.5, 0.25]
    ds.WindowCenter = [40, 400]
    ds.WindowWidth = [400, 1500]
    ds.RescaleSlope = 1
    ds.RescaleIntercept = -1024
    ds.PixelData = np.arange(12, dtype=np.uint16).reshape(4, 3).tobytes()
    return ds


def save(ds, path, ts):
    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = ds.SOPClassUID
    meta.MediaStorageSOPInstanceUID = ds.SOPInstanceUID
    meta.TransferSyntaxUID = ts
    ds.file_meta = meta
    if ts == ExplicitVRBigEndian:
        # pydicom 3 writes big endian only from a dataset already encoded that way.
        ds.PixelData = np.frombuffer(ds.PixelData, dtype="<u2").astype(">u2").tobytes()
        ds.set_original_encoding(False, False)
    ds.save_as(path, enforce_file_format=True, little_endian=ts != ExplicitVRBigEndian,
               implicit_vr=ts == ImplicitVRLittleEndian)


def main():
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    cases = [
        ("utf8-explicit-le", "ISO_IR 192", "Müller^José", ExplicitVRLittleEndian),
        ("latin1-explicit-le", "ISO_IR 100", "Müller^José", ExplicitVRLittleEndian),
        ("utf8-implicit-le", "ISO_IR 192", "Øster^Zoë", ImplicitVRLittleEndian),
        ("ascii-big-endian", "ISO_IR 6", "Doe^Jane", ExplicitVRBigEndian),
        ("ascii-deflated", "ISO_IR 6", "Doe^Jane", DeflatedExplicitVRLittleEndian),
    ]
    manifest = []
    for key, charset, name, ts in cases:
        path = out / f"{key}.dcm"
        try:
            save(base(charset, name), path, ts)
        except Exception as err:  # noqa: BLE001 - report, do not crash the bench
            manifest.append({"key": key, "error": f"{type(err).__name__}: {err}"})
            continue
        back = pydicom.dcmread(path)
        manifest.append(
            {
                "key": key,
                "path": str(path),
                "transferSyntax": str(ts),
                "expected": {
                    "PatientName": str(back.PatientName),
                    "Rows": int(back.Rows),
                    "PixelSpacing": [float(v) for v in back.PixelSpacing],
                    "WindowCenter": [float(v) for v in back.WindowCenter],
                    "RescaleIntercept": float(back.RescaleIntercept),
                    "firstPixel": int(back.pixel_array.flat[1]),
                },
            }
        )
    json.dump(manifest, sys.stdout)


if __name__ == "__main__":
    main()
