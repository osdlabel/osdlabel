"""Build data-manifest.json for the DICOM PoC from the NCI Imaging Data Commons index.

Run once (the committed manifest is its output):

    python3 -m venv .venv && .venv/bin/pip install idc-index
    .venv/bin/python -I scripts/build-manifest.py > data-manifest.json

Every series is public IDC data under a CC BY licence (3.0 or 4.0; NC variants
are rejected below). Files are fetched from IDC's public GCS bucket
`idc-open-data` over plain HTTPS by scripts/fetch-data.mjs; nothing is
committed. Each series is the smallest one found that exercises one ingest
path (see `why`).
"""

import json
import sys

from idc_index import IDCClient

SERIES = [
    # role, SeriesInstanceUID, why, mode ('full' or a byte count for a header-only Range fetch)
    ("ct", "1.2.840.113654.2.55.132885202418071974383822083798209602006",
     "CT stack: PixelSpacing, WC/WW, RescaleSlope/Intercept, IPP/IOP plane geometry", "full"),
    ("mr", "1.3.6.1.4.1.14519.5.2.1.78485505130860068157010350516995609658",
     "MR stack: plane geometry, VOI", "full"),
    ("mr-implicit", "1.3.6.1.4.1.14519.5.2.1.3671.4011.170673121874838815094639449405",
     "MR stack in Implicit VR Little Endian (parser coverage)", "full"),
    ("us-multiframe", "1.3.6.1.4.1.14519.5.2.1.215849873716944378040247591588522942212",
     "US multi-frame (cine timing, SequenceOfUltrasoundRegions)", "full"),
    ("us-ge", "1.3.6.1.4.1.14519.5.2.1.1.56314755871495081827678310314743171188",
     "US single frame, GE (SequenceOfUltrasoundRegions)", "full"),
    ("us-philips", "1.3.6.1.4.1.14519.5.2.1.1.25869676686610164028204351785146127480",
     "US single frame, Philips (SequenceOfUltrasoundRegions)", "full"),
    ("us-ceus", "1.3.6.1.4.1.14519.5.2.1.1188.2803.156377778121234083968073390093",
     "US multi-frame CEUS, ~87 MB per instance: header only via HTTP Range", 262144),
    ("dx", "1.3.6.1.4.1.14519.5.2.1.329926054576247509690119430351081746992",
     "DX, MONOCHROME1 (inverted by default), ImagerPixelSpacing", "full"),
    ("mg", "1.3.6.1.4.1.14519.5.2.1.4792.2001.130364784008142920564986387622",
     "MG, MONOCHROME1, ImagerPixelSpacing + EstimatedRadiographicMagnificationFactor", "full"),
    ("sm-jpeg", "1.3.6.1.4.1.5962.99.1.2219644737.40318689.1720206595905.4.0",
     "SM whole-slide pyramid, JPEG baseline frames (TILED_FULL)", "full"),
    ("sm-j2k", "1.3.6.1.4.1.5962.99.1.130939882.1398993800.1640808479722.2.0",
     "SM whole-slide pyramid, JPEG 2000 frames", "full"),
    # Third-party derived objects, to test reading DICOM others wrote.
    ("3p-ann-nuclei", "1.2.826.0.1.3680043.10.511.3.32128561288088313085163728063596872",
     "ANN: 55k nuclei polygons on a TCGA slide (pan_cancer_nuclei_seg_dicom; IDC's median group is 9, p75 441k)", "full"),
    ("3p-ann-small", "1.2.826.0.1.3680043.10.511.3.37969102008264807502333614010587043",
     "ANN: two rectangles (bone marrow WSI)", "full"),
    ("3p-seg-lidc", "1.2.276.0.7230010.3.1.3.0.66190.1553353048.71209",
     "SEG written by dcmqi (LIDC-IDRI nodule)", "full"),
    ("3p-sr-lidc", "1.2.276.0.7230010.3.1.3.0.66616.1553353516.76601",
     "SR TID 1500 written by dcmqi (LIDC-IDRI nodule measurements)", "full"),
    ("3p-seg-qiba", "1.2.276.0.7230010.3.1.3.1031255639.1360.1345986125.197",
     "SEG (QIBA VolCT 1B)", "full"),
    ("3p-sr-qiba", "1.3.6.1.4.1.5962.99.1.36.1981.1343676635934.286.3.0.2",
     "SR (QIBA VolCT 1B)", "full"),
]


def main() -> None:
    client = IDCClient()
    index = client.index
    out = {
        "source": "NCI Imaging Data Commons (https://portal.imaging.datacommons.cancer.gov)",
        "idc_index_data_version": client.get_idc_version(),
        "bucket_base_url": "https://storage.googleapis.com/idc-open-data",
        "series": [],
    }
    for role, uid, why, mode in SERIES:
        row = index[index.SeriesInstanceUID == uid]
        if len(row) != 1:
            raise SystemExit(f"series {uid} not found in the index")
        r = row.iloc[0]
        lic = str(r.license_short_name)
        if "NC" in lic or not lic.startswith("CC BY"):
            raise SystemExit(f"{role}: licence {lic} is not CC BY")
        urls = client.get_series_file_URLs(uid, source_bucket_location="gcs")
        # Each URL is <scheme>://idc-open-data/<series_uuid>/<instance_uuid>.dcm
        files = sorted(u.split("idc-open-data/", 1)[1] for u in urls)
        out["series"].append({
            "role": role,
            "why": why,
            "collection_id": r.collection_id,
            "license": lic,
            "source_doi": str(r.source_DOI),
            "modality": r.Modality,
            "sop_class_name": r.sop_class_name,
            "transfer_syntax": r.transfer_syntax_name,
            "manufacturer": None if str(r.Manufacturer) == "nan" else str(r.Manufacturer),
            "series_instance_uid": uid,
            "series_size_mb": round(float(r.series_size_MB), 3),
            "instance_count": int(r.instanceCount),
            "fetch": "full" if mode == "full" else {"range_bytes": mode, "max_instances": 1},
            "files": files,
        })
    json.dump(out, sys.stdout, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
