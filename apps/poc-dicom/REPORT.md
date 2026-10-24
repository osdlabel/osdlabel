# PoC: DICOM adapter (ingest, whole-slide tiles, SR/SEG/ANN export)

Branch `claude/poc-dicom`, head `712862c057` at the time of the result. Part of the osdlabel roadmap study (branch `claude/osdlabel-roadmap-strategy-uut5ay`). Written by the orchestrating agent from the PoC agent's structured result, because PoC agents in this environment cannot write report files.

**Status:** Built and independently reviewed. The review's two blocking findings: (1) the rejection of dicom-parser rested on a harness artifact (a full-mode parse of a Range-truncated header; in header mode dicom-parser reads it), so the parser choice is open: the in-house reader, or dicom-parser plus the in-house writer; (2) the bulk-annotation layer reached each cell's overlay through a test-only hook, so production needs a small public per-cell overlay hook in both bindings. A fix pass started and was interrupted by a usage limit; its partial work is the last commit on this branch (a WIP snapshot of the parser-bench correction), and the fix pass was then skipped. The roadmap document carries both corrections. The reviewer reproduced ingest (103/103 files), export validation (15/15) and the zero-core-change result for ingest, WSI and export.

## Summary

I continued from the interrupted WIP and confirmed it builds and passes its tests: 43 unit tests, typecheck, lint and prettier all clean. I then finished the reverse direction (third-party SR/SEG/ANN read back and compared with highdicom) and a bulk-annotation scale test, ran the full one-command bench with --reps 3 and committed the results. Three new leaf packages carry the work. @osdlabel/dicom (Part 10 + DICOM JSON reader/writer, metadata mapping) depends only on viewer-api types. @osdlabel/dicom-wsi (an OpenSeadragon tile source written as a plain object, so it never imports OSD; local Part 10, HTTP Range and DICOMweb frame sources; pluggable codecs) and @osdlabel/dicom-export (SR TID 1500, SEG, Microscopy Bulk Simple Annotations, writers and readers) sit beside it. Zero lines changed in any of the 13 existing packages. On real IDC data the ingest reads 103/103 files correctly against pydicom. All 15 exported files pass dciodvfy (0 errors) and highdicom reads them; SR geometry round-trips within 2e-5 px and SEG exactly. The stock Annotator annotates DICOM WSI end to end. Two findings need design work. A single PixelSpacing per image cannot express ultrasound regions or time/velocity axes; the fix is an additive, optional calibrationRegions field. IDC-scale bulk annotations cannot be Fabric objects (8000 polygons take 2.3 s per frame) and need a separate read-only layer: a level-of-detail layer draws all 55 092 nuclei in 2.9 ms or less.

## Hypotheses and verdicts

### H1a: confirmed

A small DICOM-free-at-the-boundary adapter (@osdlabel/dicom) derives osdlabel inputs from real DICOM: ImageSource per frame/series, PixelSpacing (PixelSpacing, ImagerPixelSpacing+ERMF, SequenceOfUltrasoundRegions, PixelMeasuresSequence), default VOI, photometric/MONOCHROME1 inversion, cine timing and plane geometry for stacks.

Real IDC data, 17 series/instances, all CC BY 4.0 or 3.0: CT nlst, MR prostate_mri_us_biopsy (oblique), MR tcga_kich (Implicit VR), US multi-frame Eigen, US GE and Philips (cmb_crc), US CEUS GE (b_mode_and_ceus_liver, header only via Range), DX cmb_lca, MG breast_diagnosis, SM gtex (JPEG), SM cptac_brca (J2K), plus 6 third-party SR/SEG/ANN. Correctness against pydicom on 22 mapped attributes: @osdlabel/dicom 103/103 files, dcmjs 103/103, dicom-parser 102/103 (it threw on the Range-truncated CEUS header). What it derived: CT 1.48438 mm with 2 windows and their explanations (WINDOW1/2) and rescale -1024; DX/MG MONOCHROME1 inverted exactly once alongside Presentation LUT INVERSE; US-GE spacing from SequenceOfUltrasoundRegions (0.00687994 cm/px); CEUS cine on the time axis (FrameTime gives 9.00128 fps, CineRate 9 fps); the 227-frame Eigen US multi-frame is a spatial sweep (Frame Increment Pointer (0054,0080)), not cine. MR stack ordered by position along the normal (InstanceNumber order is reversed); CT stack flagged non-uniform (gaps 6.55-6.7 mm). A 400-instance IDC header survey (40 each of CT, MR, US, DX, CR, MG, XA, PT, NM, SM) parsed 400/400 with 0 errors. image-to-patient/slide matches highdicom ImageToReferenceTransformer within 2.8e-14 mm. Bundle: ingest path 10.5 KB gzip, whole package 14.2 KB gzip.

### H1b: confirmed

For read and write needs, a thin in-house reader/writer is the better base than dicom-parser or dcmjs.

Bundle (esbuild, minified, gzip): own readPart10 5.4 KB, own whole @osdlabel/dicom 14.2 KB, dicom-parser 7.4 KB (read-only, no writer), dcmjs 193.4 KB for read+naturalize, read+write or the whole package. Header-parse median ms per role (Node 22, 3 reps), own / dicom-parser / dcmjs: CT 24 files 0.764/3.587/11.715; MR-implicit 3.855/4.882/47.577; SM-jpeg 0.326/10.048/23.0; ANN nuclei 0.219/0.77/53.4. Full read: dcmjs takes 10 826 ms on the 2250-frame JPEG WSI instance set against 1.0 ms own. dicom-parser's full parse was faster than ours on 3 roles (ANN nuclei 0.586 vs 1.111 ms; SR-lidc 1.192 vs 3.201; MR 1.708 vs 2.3), so speed is not uniformly ours. The decisive factors are the writer requirement, size and truncated-prefix (HTTP Range) tolerance.

### H1c: refuted

osdlabel's single PixelSpacing per image is sufficient to carry DICOM calibration.

Survey: 27 of 40 random IDC US instances calibrate through SequenceOfUltrasoundRegions and 3 of 40 have several regions. The CEUS file has two side-by-side 2D panes (bounds [0..584] and [585..1169]) with identical 0.0299234 cm/px; a line crossing the panes is meaningless, yet one PixelSpacing would measure it. M-mode and spectral Doppler axes are time (s) and velocity (cm/s), not length; only synthetic unit tests cover them, as the 40-instance sample had 0 multi-calibration images. Projection radiographs have two defensible spacings: detector (ImagerPixelSpacing) and magnification-corrected (ERMF), the latter used by MG 17/40 and XA 33/40; DX 34/40 are detector plane only. The PoC works around this with zero core change: an app-level withCalibrationRegions(provider, regionsFor) wrapper, 4 unit tests, which labelled the end-to-end US line 'L: 10.01 mm' and refuses cross-region measurements. Proposed production change: an optional ImageSource.calibrationRegions.

### H1d: partial

Display (VOI/LUT), cine timing and plane geometry, once derived, have a consumer in today's osdlabel core.

All three are derived (DisplayDefaults with windows, VOI LUTs, VOI function LINEAR/LINEAR_EXACT/SIGMOID and rescale; FrameTiming; PlaneGeometry/StackGeometry). None has a home in the core: CellTransform only carries CSS exposure/contrast on an already 8-bit image. The PoC renders native frames to PNG blob URLs on the CPU instead (renderNativeFrame; median render DX 25.9 ms, US 6.4 ms, CT 0.75 ms per frame). Survey prevalence: multiple windows CT 32.5%, DX 42.5%; VOI LUT Sequence CR 27.5%; SIGMOID VOI MG 15%; MONOCHROME1 CR 57.5%. These belong to the pixel-pipeline, frame-axis and volume PoCs; the adapter's job ends at producing these DICOM-free descriptions.

### H2a: confirmed

A DICOM VL Whole Slide Microscopy series (TILED_FULL, levels as instances, JPEG or J2K frames) opens in OpenSeadragon through a custom TileSource fed from local files / HTTP Range / DICOMweb frames, without the package importing OSD.

createWsiTileSource returns a plain object implementing OSD's custom tile-source protocol (getTileUrl/getLevelScale/downloadTileStart/Abort), with DICOM levels mapped 1:1 onto OSD levels. GTEx JPEG (3 levels, 17927x6985 base, 240-px tiles) and CPTAC J2K (17280x19316, 256-px tiles) both load, with 0 failed tiles in every case. Medians of 3 reps, headless Chromium 153, canvas drawer, local server, load 9-18 on 4 cores (metadata / first tile / home-view complete): JPEG part10 226.5/67.1/863.2 ms; range 72/134.5/741.9 ms; dicomweb 33/256.7/1190.4 ms; dicomweb +50 ms latency 81.9/257.6/1027.5 ms; J2K part10 124.6/422.1/1947.7 ms (90 tiles); J2K dicomweb 34.6/410.4/2600.1 ms. Tile fetch median: part10 0.6, range 23.8, dicomweb 29.6, +50 ms 72.3 ms. Decode median: JPEG 4.4-14.7 ms (createImageBitmap); J2K 11.7-15.9 ms end to end, 5.5-6.8 ms inside the OpenJPEG WASM worker. Bytes for the same views: part10 downloads 15.9 MB (the whole series), range 2.93 MB, dicomweb 1.55 MB. Real network, IDC bucket via HTTP Range from Node: 5 header requests (1.31 MB) in 279 ms; sequential frame median 69.3 ms (p90 426 ms); 24 frames at concurrency 6 take 451 ms wall. JPEG 2000 needs a WASM codec (@cornerstonejs/codec-openjpeg 1.3.6, 99 KB gzip, run in a worker); HTJ2K is available as @cornerstonejs/codec-openjph 2.4.11.

### H2b: confirmed

The stock osdlabel <Annotator> (unmodified) annotates DICOM images and exports DICOM end to end.

annotate.html loads 27 images: a WSI over DICOMweb, a CT stack, a US with calibration regions and a MONOCHROME1 DX. Playwright then draws a rectangle and a line on the WSI, a circle and a brush mask on CT, and a line on US. It exports sm-sr.dcm (6234 B), sm-ann.dcm (4530 B), ct-sr.dcm (4774 B), ct-seg.dcm (11004 B) and us-ge-sr.dcm (4488 B). All 5 give dciodvfy 0 errors and are read OK by highdicom 0.28.2. DICOM context stays with the host (Map<ImageId, DicomImageContext>); osdlabel only ever sees plain ImageSource objects.

### H2c: refuted

DICOM Microscopy Bulk Simple Annotations at IDC scale can be imported as ordinary osdlabel annotations (one Fabric object each).

IDC pan-cancer nuclei ANN: 55 092 polygons, 1 538 483 vertices, 12.8 MB; read in 366-438 ms; 122.7 MB JS heap as osdlabel geometry (2336 B per shape). As Fabric objects, renderAll forced to raster (1-px readback), median ms at fit / zoom8 / zoom64: 500 polygons 98.7/2.2/2.2; 2000 polygons 645/6.8/7.0; 8000 polygons 2309/187/77. Mount-to-objects took 309/644/3994 ms and JS heap was 38/91/373 MB (20 MB with none). OSD tile loads hit their 30 s timeout during the 8000 run. A read-only companion canvas on FabricOverlay.overlayElement + onSync with grid culling and dots under 4 px: 55 092 polygons in 2.9/0.65/2.0 ms, 8000 in 0.65/0.78/0.24 ms, build 566 ms. A naive single-Path2D layer took 2355/358/248 ms for 55 092. Side finding: Chromium 153 Path2D.closePath() on many subpaths is quadratic (16 000 polygons 9.9 s vs 24 ms when closed with lineTo; scripts/path2d-closepath-probe.mjs).

### H3a: confirmed

osdlabel annotations export to DICOM SR TID 1500 (lengths/areas with UCUM units; polylines/polygons as SCOORD), DICOM SEG from PR #149 masks, and Microscopy Bulk Simple Annotations, via a thin writer; outputs validate with highdicom/pydicom and dciodvfy; round-trip fidelity is high.

10 export cases: SR 2D and 3D on CT, SR 3D on oblique MR, SR 2D on US and SM, SEG on CT (2 frames) and US, ANN 2D float32, 3D float32 and 3D float64. All have dciodvfy (dicom3tools 20260927) 0 errors; the only warnings were inherited from the source data (missing StudyTime/StudyID, DICOMDIR-only; retired PN form) and were filtered. highdicom 0.28.2 + pydicom 3.0.2 read all of them. SR: 6/6 shape types preserved per file, max coordinate error 7.2e-6 px (CT 2D), 1.86e-5 px (US), 4.4e-4 px (SM 2D at 18k px), max measurement relative error 3.7e-15. SEG BINARY exact: SHA-256 equal masks (CT 2011 and 1968 px, US 14478 px). ANN: 2D float32 3.8e-4 px, 3D float32 3.8e-3 px, 3D float64 6.4e-12 px. Build times 1.3-7 ms (first SR call 47.6 ms with JIT warm-up). Sizes: SR 11.4-12.3 KB for 6 shapes, SEG 19.9 KB / 62.8 KB, ANN 5.9-6.3 KB. Coordinate frames: 2D SR SCOORD and ANN 2D are image pixels with (0,0) at the top-left corner of the top-left pixel (osdlabel's convention); 3D SR SCOORD3D is the patient frame of reference via IPP/IOP; ANN 3D is slide mm.

### H3b: confirmed

DICOM written by other tools reads back into osdlabel shapes/masks/measurements, in agreement with highdicom.

5/5 objects highdicom can read agree with our reader. Stony Brook ANN: 55092 POLYGON. Erlangen/MEVIS ANN: 2 RECTANGLE. dcmqi LIDC SEG BINARY: 72 px. Siemens QIBA SEG FRACTIONAL: 45 px at threshold 0.5 x MaxFractionalValue, lossy by design since osdlabel masks are binary. dcmqi LIDC SR: TID 1500 / 1411 with 3 measurements (Volume 160.02 mm3, Diameter 6.377929 mm, Surface area 134.4078 mm2), whose 0 groups with geometry reference a SEG rather than SCOORD. The 6th (QIBA Comprehensive SR, template RPH_0001) is not TID 1500: highdicom fails with an AttributeError and we return 0 groups.

### H4: confirmed

Speaking DICOM requires no change to the existing core packages; DICOM stays an edge adapter.

git diff --stat origin/claude/segmentation-brush-tool over all 13 existing packages and both dev apps is empty: 0 files and 0 lines. Outside packages only pnpm-workspace.yaml (+2: allowBuilds core-js-pure:false, needed only for the dcmjs comparison) and pnpm-lock.yaml (+547) changed. The new packages are leaves: dicom depends on viewer-api only; dicom-wsi on dicom + viewer-api; dicom-export on dicom, annotation, geometry, decoration, mask and viewer-api. The two expressivity gaps (calibration regions; bulk layer) are worked around without a core change, and a production version needs at most one additive optional field (calibrationRegions).

## Measurements

| Measurement                                                             | Value                                                                                                                                                                                                                                                                              | Unit                            | Conditions                                                                                                                                                                    |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| parser correctness vs pydicom (22 attributes)                           | @osdlabel/dicom 103/103; dcmjs 103/103; dicom-parser 102/103 (1 threw: Range-truncated US CEUS header)                                                                                                                                                                             | files                           | Node 22.22, IDC files in apps/poc-dicom/data (fetch script), pydicom 3.0.2 truth                                                                                              |
| IDC header survey                                                       | 400/400 parsed, 0 errors; SM median header 152896 B, max 13122818 B, up to 5 Range requests                                                                                                                                                                                        | instances                       | 40 random instances each of CT/MR/US/DX/CR/MG/XA/PT/NM/SM, 64 KiB initial Range, from the previous agent's --survey run (2026-10-23), summary embedded in representative.json |
| survey: US calibration via SequenceOfUltrasoundRegions                  | 27/40 with regions, 3/40 multi-region, 0/40 multi-calibration; units cm x cm 28, none x none 2                                                                                                                                                                                     | instances                       | IDC random sample                                                                                                                                                             |
| survey: ERMF-corrected spacing                                          | MG 17/40, XA 33/40, CR 1/40, DX 0/40                                                                                                                                                                                                                                               | instances                       | IDC random sample                                                                                                                                                             |
| survey: display metadata prevalence                                     | multi-window CT 32.5%, DX 42.5%, CR 17.5%; VOI LUT Seq CR 27.5%, DX 7.5%; SIGMOID VOI MG 15%; inverted (MONOCHROME1) CR 57.5%, DX 15%                                                                                                                                              | % of instances                  | IDC random sample, 40 per modality                                                                                                                                            |
| header parse median, own / dicom-parser / dcmjs                         | CT(24 files) 0.764/3.587/11.715; MR 0.895/1.765/10.807; MR-implicit 3.855/4.882/47.577; MG 0.447/5.385/14.168; SM-jpeg 0.326/10.048/23.002; SM-j2k 0.288/0.711/9.175; ANN-nuclei 0.219/0.77/53.425; SR-lidc 0.408/3.138/64.119                                                     | ms per role                     | Node 22, 3 reps alternating readers, load 9-18 on 4 cores                                                                                                                     |
| full parse median, own / dicom-parser / dcmjs                           | CT 0.848/10.8/9.286; SM-jpeg 1.025/5.678/10826.0; US-multiframe(26.5 MB) 0.081/0.112/34.897; ANN-nuclei 1.111/0.586/26.285; SR-lidc 3.201/1.192/17.047                                                                                                                             | ms per role                     | as above                                                                                                                                                                      |
| bundle size gzip (raw)                                                  | own readPart10 5.4 (17.0); own ingest 10.5 (31.4); own @osdlabel/dicom 14.2 (41.6); own dicom-wsi incl. dicom 11.5 (34.7); own dicom-export incl. dicom 13.3 (41.5); dicom-parser 7.4 (30.6); dcmjs 193.4 (698.6); openseadragon 66.6 (271.9); codec-openjpeg wasm+glue 99 (308.7) | KB                              | esbuild minified                                                                                                                                                              |
| image->patient/slide transform vs highdicom ImageToReferenceTransformer | CT 0; MR oblique 2.8e-14; SM slide 7.1e-15                                                                                                                                                                                                                                         | mm max \|delta\|, 6 points each | highdicom 0.28.2                                                                                                                                                              |
| WSI JPEG part10 canvas: metadata / first tile / home / zoomA / zoomB    | 226.5 / 67.1 / 863.2 / 456.7 / 593.4                                                                                                                                                                                                                                               | ms (median of 3)                | GTEx SM 17927x6985, 3 levels, 240-px tiles; 40 home tiles, 24/35 zoom tiles; local Vite server; headless Chromium 153 SwiftShader; 1280x800; load 9-18                        |
| WSI JPEG range canvas: metadata / first tile / home / zoomA / zoomB     | 72 / 134.5 / 741.9 / 471.7 / 763.9; 104 requests, 2.93 MB                                                                                                                                                                                                                          | ms; requests; bytes             | HTTP Range on Part 10 files, 256 KiB header read                                                                                                                              |
| WSI JPEG dicomweb canvas: metadata / first tile / home / zoomA / zoomB  | 33 / 256.7 / 1190.4 / 469.5 / 749; 100 requests, 1.55 MB                                                                                                                                                                                                                           | ms                              | emulated WADO-RS (Vite middleware reading frames from disk per request)                                                                                                       |
| WSI JPEG dicomweb canvas +50 ms latency                                 | 81.9 / 257.6 / 1027.5 / 593.2 / 994.9                                                                                                                                                                                                                                              | ms                              | server-injected 50 ms per request                                                                                                                                             |
| WSI JPEG dicomweb webgl drawer                                          | 46.7 / 124.7 / 3876.7 / 8972 / 11850.9; tile fetch median 617, decode median 612.5                                                                                                                                                                                                 | ms                              | SwiftShader WebGL2: CPU-emulated, main-thread saturated; not representative of GPU                                                                                            |
| WSI J2K part10 canvas                                                   | 124.6 / 422.1 / 1947.7 / 538.5 / 574.2; 90 home tiles                                                                                                                                                                                                                              | ms                              | CPTAC SM 17280x19316, 256-px J2K tiles, OpenJPEG WASM in a worker                                                                                                             |
| WSI J2K dicomweb canvas                                                 | 34.6 / 410.4 / 2600.1 / 819.9 / 642.6; 139 requests, 384 KB                                                                                                                                                                                                                        | ms                              | as above                                                                                                                                                                      |
| tile fetch median (p90)                                                 | JPEG part10 0.6 (2.1); range 23.8 (90.3); dicomweb 29.6 (171); +50ms 72.3 (206.4); J2K part10 1.1 (3.2); J2K dicomweb 49.1 (322.6)                                                                                                                                                 | ms                              | local, loaded machine                                                                                                                                                         |
| tile decode median (p90)                                                | JPEG 4.4-14.7 (26-64); J2K end-to-end 11.7-15.9 (73-155); J2K inside worker 5.5-6.8                                                                                                                                                                                                | ms                              | createImageBitmap for JPEG; @cornerstonejs/codec-openjpeg 1.3.6 worker for J2K                                                                                                |
| real network IDC bucket (HTTP Range, Node)                              | metadata 279 ms (5 req, 1.31 MB); sequential frame median 69.3, p90 426.1 (n=8); 24 frames at concurrency 6: wall 450.7, per-frame median 91.8, p90 128.1; total 37 req, 1.75 MB                                                                                                   | ms                              | storage.googleapis.com from sandbox proxy, GTEx base level, no rendering, no CORS                                                                                             |
| SR export fidelity                                                      | 6/6 types per file; max coord error CT-2d 7.2e-6, CT-3d 6.6e-6, MR-3d 2.0e-6, US-2d 1.86e-5, SM-2d 4.4e-4; max measurement rel. error 3.7e-15                                                                                                                                      | px; ratio                       | rect, circle, polygon, line, polyline, point; read back by own reader; highdicom cross-read of planar ROIs 7.2e-6 px                                                          |
| SEG export fidelity                                                     | exact (hash-equal): CT 2011 and 1968 px over 2 frames; US 14478 px                                                                                                                                                                                                                 | pixels                          | BINARY, from @osdlabel/mask snapshots; highdicom get_pixels_by_source_instance                                                                                                |
| ANN export fidelity                                                     | 2D float32 3.8e-4; 3D float32 3.8e-3; 3D float64 6.4e-12                                                                                                                                                                                                                           | px max error                    | GTEx slide, 6 shapes; 3D = slide mm                                                                                                                                           |
| export validation                                                       | 15/15 files: dciodvfy 0 errors, highdicom read OK                                                                                                                                                                                                                                  | files                           | 10 export cases + 5 from the end-to-end Annotator flow; dicom3tools 20260927 wheel; warnings only inherited DICOMDIR/PN-form ones                                             |
| export file sizes                                                       | SR 11412-12274 (6 shapes); SEG 19892 (2 frames 256x256), 62830 (US); ANN 5908-6346                                                                                                                                                                                                 | bytes                           | uncompressed Explicit VR LE                                                                                                                                                   |
| export build time                                                       | SR-2d 47.63 (first call, JIT), SR-3d 3.85, SEG 7.01, ANN 1.25-2.15                                                                                                                                                                                                                 | ms                              | Node 22                                                                                                                                                                       |
| third-party import agreement with highdicom                             | 5/5 agree (ANN 55092 polygons; ANN 2 rectangles; SEG 72 px; SEG FRACTIONAL 45 px at 0.5; SR 3 measurements); 1 non-TID-1500 SR unreadable by both                                                                                                                                  | files                           | dcmqi LIDC, QIBA, Stony Brook, Erlangen/MEVIS objects from IDC                                                                                                                |
| ANN nuclei read into osdlabel geometry                                  | 366-438 ms; 122.7 MB heap; 2336 B per shape; 1538483 vertices                                                                                                                                                                                                                      | ms; MB                          | Node --expose-gc child process                                                                                                                                                |
| bulk: Fabric renderAll forced raster, fit/zoom8/zoom64                  | n=500: 98.7/2.2/2.2; n=2000: 645/6.8/7.0; n=8000: 2309/187/77                                                                                                                                                                                                                      | ms median of 10                 | stock Annotator, each polygon an annotation; headless Chromium software canvas; nuclei 0.2/1.6-1.9/13-15 screen px                                                            |
| bulk: Fabric mount-to-objects and JS heap                               | n=0: 77 ms, 20 MB; 500: 309 ms, 38 MB; 2000: 644 ms, 91 MB; 8000: 3994 ms, 373 MB                                                                                                                                                                                                  | ms; MB                          | same                                                                                                                                                                          |
| bulk: naive Path2D companion layer, forced raster fit/zoom8/zoom64      | n=8000: 266/45/0.3; n=55092: 2355/358/248; build 94 ms / 1611 ms                                                                                                                                                                                                                   | ms                              | single Path2D, closed with lineTo                                                                                                                                             |
| bulk: LOD companion layer (grid + dots < 4 px)                          | n=8000: 0.65/0.78/0.24; n=55092: 2.9/0.65/2.0; build 71 / 566 ms; heap 44 / 156 MB                                                                                                                                                                                                 | ms                              | 256-px grid cells, dots via ImageData below 4 px, Path2D per cell above                                                                                                       |
| bulk: pan frame median (rAF to rAF) fit/zoom8/zoom64                    | none 394/198/154; Fabric 8000 3290/1709/222; layer 55092 2615/636/466; LOD 55092 318/344/192                                                                                                                                                                                       | ms                              | includes OSD software tile redraw; very noisy (load 13-18)                                                                                                                    |
| Chromium Path2D closePath scaling                                       | closePath: 1000 37, 4000 548, 16000 9942; lineTo-close: 6 / 18 / 24                                                                                                                                                                                                                | ms                              | 28-vertex polygons, Chromium 153 headless; scripts/path2d-closepath-probe.mjs                                                                                                 |
| end-to-end annotate flow                                                | 27 images; WSI metadata 36 ms; CT load+render 565 ms (24 slices); DX render 25.9 ms; whole flow 16.5 s                                                                                                                                                                             | ms                              | Playwright-driven stock Annotator                                                                                                                                             |
| code added (diff vs origin/claude/segmentation-brush-tool)              | existing packages 0 files / 0 lines; new: dicom 2986 src + 468 tests, dicom-export 1507 + 198, dicom-wsi 830 + 146, apps/poc-dicom 4497 + 80; 7700 lines JSON (manifests, representative results); pnpm-workspace +2, lock +547                                                    | lines                           | git diff --numstat at 712862c                                                                                                                                                 |
| bench run                                                               | 701.1 s, load avg 9.29 -> 18.51 (1 min) on 4 cores                                                                                                                                                                                                                                 | s                               | --reps 3, python validators present, network probe on                                                                                                                         |

## Recommendation

Make DICOM a set of leaf packages at the edge and keep DICOM-shaped data out of the core. Ingest maps DICOM to plain osdlabel inputs: ImageSource, PixelSpacing, CalibrationRegion, and DICOM-free descriptions of display, timing and plane. A WSI series opens through an OSD custom tile-source object, so the WSI package never imports OpenSeadragon. Export turns plain osdlabel annotations and masks back into SR TID 1500, SEG and ANN. The host keeps the bridge back to DICOM UIDs as a Map<ImageId, DicomImageContext> (a DicomImageIndex helper in @osdlabel/dicom). The reader/writer is in-house: 14 KB gzip, tolerates truncated Range prefixes, and has a writer that dicom-parser lacks, against dcmjs's 193 KB gzip and 5-60x slower parse. Codecs are plugged in by the host (lazy WASM workers). Two pieces of new non-DICOM infrastructure follow from the measurements. First, an optional, additive ImageSource.calibrationRegions, with measurement providers that pick the region containing an annotation. Second, a DICOM-free read-only bulk vector layer on FabricOverlay's existing companion-layer API, because IDC-scale ANN cannot be Fabric objects. Exports default to 2D image coordinates, which round-trip exactly and also work for US/DX without a frame of reference. 3D (SCOORD3D / slide mm, float64 for ANN) is an option wherever a plane exists. CI validates every builder with dciodvfy and highdicom.

### New packages

- @osdlabel/dicom: Part 10 + DICOM JSON read/write, tag dictionary subset, UIDs, and mapping (toImageSources, derivePixelSpacing, toCalibrationRegions, deriveDisplayDefaults, readFrameTiming, readPlaneGeometry/buildStack/imageToPatient, DicomImageIndex); depends on @osdlabel/viewer-api (types only); zero third-party deps
- @osdlabel/dicom-wsi: WSI pyramid (TILED_FULL/SPARSE), FrameSource (Part 10, HTTP Range, DICOMweb WADO-RS), FrameDecoderRegistry (built-in JPEG via createImageBitmap; J2K/HTJ2K/JPEG-LS adapters for host-supplied WASM codecs), createWsiTileSource (OSD protocol as a plain object), wsiImageSource; depends on @osdlabel/dicom, @osdlabel/viewer-api; no openseadragon import
- @osdlabel/dicom-export: SR TID 1500 (2D SCOORD / 3D SCOORD3D, UCUM units), SEG (BINARY write; BINARY/FRACTIONAL read), Microscopy Bulk Simple Annotations (2D/3D, f32/f64) writers and readers; depends on @osdlabel/dicom, @osdlabel/annotation, @osdlabel/geometry, @osdlabel/decoration, @osdlabel/mask, @osdlabel/viewer-api (could later split into dicom-sr / dicom-seg / dicom-ann)
- @osdlabel/bulk-layer (DICOM-free): read-only typed-array vector layer with grid index, LOD (dots below ~4 px), hit-testing and promote-to-annotation; mounts on FabricOverlay.overlayElement + onSync; depends on @osdlabel/annotation (geometry types) and a structural overlay interface (or @osdlabel/fabric-osd types)

### Changes to existing packages

- None were needed for this PoC: 0 lines across all 13 existing packages.
- Production, optional and additive: @osdlabel/viewer-api gains CalibrationRegion/AxisCalibration types and ImageSource.calibrationRegions?: readonly CalibrationRegion[] | undefined (about 40 lines).
- Production, optional: @osdlabel/decoration's createMeasurementProvider uses the region containing an annotation's bounding box and reports per-axis values for non-length axes, or 'not measurable' across regions (the PoC's withCalibrationRegions, about 80 lines). Alternatively ship it as a wrapper in a new package and change nothing.
- Not this PoC's to change, but needed for full DICOM display: true windowing / VOI LUT / MONOCHROME1 for 12-16-bit data (pixel-pipeline PoC); a frame/cine axis (frame-axis PoC); stacks and 3D (volume PoC). The adapter already produces DICOM-free descriptions for all three.

### API sketch

```ts
// @osdlabel/dicom
export interface DicomDataset {
  strings(tag: number): readonly string[] | undefined;
  numbers(tag: number): readonly number[] | undefined;
  sequence(tag: number): readonly DicomDataset[] | undefined;
  bytes(tag: number): Uint8Array | undefined;
}
export function readPart10(bytes: Uint8Array, options?: { readonly untilTag?: number }): Part10File; // { dataset, transferSyntaxUid, pixelData?: PixelDataInfo, truncated: boolean }
export function fromDicomJson(json: DicomJsonDataset): DicomDataset;
export function writePart10(ds: WriteDataset, options: WritePart10Options): Uint8Array;
export function toImageSources(
  instances: readonly DicomDataset[],
  options: {
    readonly tileSource: (ref: DicomFrameRef) => TileSourceSpec;
    readonly imageId?: (ref: DicomFrameRef) => ImageId;
    readonly label?: (ref: DicomFrameRef) => string;
    readonly frames?: 'all' | 'first';
  },
): ImageSource[];
export type SpacingPlane =
  | 'patient'
  | 'detector'
  | 'estimated-patient'
  | 'calibrated'
  | 'scanned-film'
  | 'slide';
export function derivePixelSpacing(
  ds: DicomDataset,
  options?: {
    readonly projection?: 'estimated-patient' | 'detector';
    readonly microscopyUnit?: 'µm' | 'mm';
    readonly frame?: number;
  },
):
  | (DerivedSpacing & {
      readonly alternatives: readonly DerivedSpacing[];
      readonly notes: readonly string[];
    })
  | undefined; // DerivedSpacing = { spacing: PixelSpacing; source; plane: SpacingPlane }
export function toCalibrationRegions(regions: readonly UltrasoundRegion[]): CalibrationRegion[];
export function deriveDisplayDefaults(ds: DicomDataset): DisplayDefaults; // photometric, rescale, modalityLut, windows (with explanations), voiLuts, voiFunction, invert, defaultVoi
export function readFrameTiming(ds: DicomDataset): FrameTiming; // axis: 'single'|'time'|'space'|'label'|'tiles'|'multi'|..., frameStartMs, acquisitionFps, playbackFps
export function readPlaneGeometry(ds: DicomDataset, frame?: number): PlaneGeometry | undefined;
export function buildStack<T>(
  items: readonly T[],
  plane: (t: T) => PlaneGeometry | undefined,
): StackGeometry<T>;
export function imageToPatient(plane: PlaneGeometry, p: Point): Vec3;
export class DicomImageIndex {
  set(id: ImageId, ctx: { readonly ref: ImageRef; readonly source: DicomDataset }): void;
  get(id: ImageId): { readonly ref: ImageRef; readonly source: DicomDataset } | undefined;
}

// @osdlabel/viewer-api (proposed, additive)
export type AxisQuantity = 'length' | 'time' | 'velocity' | 'frequency' | 'other';
export interface AxisCalibration {
  readonly perPixel: number;
  readonly unit: string;
  readonly quantity: AxisQuantity;
}
export interface CalibrationRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly axisX: AxisCalibration;
  readonly axisY: AxisCalibration;
  readonly label?: string | undefined;
}
export interface ImageSource {
  /* existing fields */ readonly calibrationRegions?: readonly CalibrationRegion[] | undefined;
}

// @osdlabel/dicom-wsi
export function describePyramid(instances: readonly PyramidInstance[]): WsiPyramid;
export interface FrameSource {
  frame(
    sopInstanceUid: string,
    frameNumber: number,
    signal?: AbortSignal,
  ): Promise<{ readonly bytes: Uint8Array; readonly transferSyntaxUid: string }>;
}
export function createPart10FrameSource(o: {
  readonly urls: readonly string[];
  readonly fetch?: typeof fetch;
}): FrameSource & { instances(): Promise<PyramidInstance[]> };
export function createRangeFrameSource(o: {
  readonly urls: readonly string[];
  readonly headerBytes?: number;
  readonly fetch?: typeof fetch;
}): FrameSource & { instances(): Promise<PyramidInstance[]> };
export function createDicomWebFrameSource(o: {
  readonly root: string;
  readonly study: string;
  readonly series: string;
  readonly fetch?: typeof fetch;
}): FrameSource & { instances(): Promise<PyramidInstance[]> };
export interface FrameDecoder {
  readonly transferSyntaxes: readonly string[];
  decode(bytes: Uint8Array, info: DecodeInfo, signal?: AbortSignal): Promise<ImageBitmap>;
}
export function createFrameDecoderRegistry(decoders: readonly FrameDecoder[]): FrameDecoderRegistry;
export function createWsiTileSource(o: {
  readonly pyramid: WsiPyramid;
  readonly frames: FrameSource;
  readonly decoders?: FrameDecoderRegistry;
  readonly onTile?: (s: TileStat) => void;
}): WsiTileSourceSpec; // valid ImageSource.tileSource as is
export function wsiImageSource(
  p: WsiPyramid,
  t: WsiTileSourceSpec,
  o?: { readonly label?: string },
): ImageSource;

// @osdlabel/dicom-export
export interface ImageRef {
  readonly studyInstanceUid: string;
  readonly seriesInstanceUid: string;
  readonly sopClassUid: string;
  readonly sopInstanceUid: string;
  readonly frameNumber?: number | undefined;
  readonly rows: number;
  readonly columns: number;
  readonly frameOfReferenceUid?: string | undefined;
  readonly plane?: PlaneGeometry | undefined;
}
export function imageRefFrom(ds: DicomDataset, frameNumber?: number): ImageRef;
export function buildMeasurementReport(o: {
  readonly source?: DicomDataset;
  readonly items: readonly {
    readonly id: string;
    readonly geometry: VectorGeometry;
    readonly label?: string;
    readonly image: ImageRef;
    readonly pixelSpacing?: PixelSpacing;
    readonly finding?: Code;
  }[];
  readonly coordinates?: '2d' | '3d';
}): {
  readonly bytes: Uint8Array;
  readonly sopInstanceUid: string;
  readonly seriesInstanceUid: string;
};
export function buildSegmentation(o: {
  readonly source?: DicomDataset;
  readonly segments: readonly {
    readonly label: string;
    readonly category?: Code;
    readonly type?: Code;
    readonly rgb?: readonly [number, number, number];
    readonly masks: readonly { readonly image: ImageRef; readonly snapshot: MaskSnapshot }[];
  }[];
}): { readonly bytes: Uint8Array; readonly frameCount: number };
export function buildBulkAnnotations(o: {
  readonly image: ImageRef;
  readonly source?: DicomDataset;
  readonly items: readonly {
    readonly geometry: VectorGeometry;
    readonly label: string;
    readonly category?: Code;
    readonly type?: Code;
  }[];
  readonly coordinates?: '2D' | '3D';
  readonly double?: boolean;
}): { readonly bytes: Uint8Array; readonly groups: number };
export function readMeasurementReport(ds: DicomDataset): ImportedSrGroup[]; // { template, label, geometry?: VectorGeometry, measurements: { name, value, unit }[] }
export function readSegmentation(
  ds: DicomDataset,
  pixelData: Uint8Array,
  o?: { readonly fractionalThreshold?: number },
): ImportedSegment[]; // masks: ReadonlyMap<sopInstanceUid, MaskSnapshot>
export function readBulkAnnotations(ds: DicomDataset): ImportedAnnGroup[]; // { label, graphicType, geometries: VectorGeometry[] }

// @osdlabel/bulk-layer (DICOM-free)
export interface BulkLayerOverlay {
  readonly overlayElement: HTMLElement;
  readonly canvas: { readonly viewportTransform: readonly number[] };
  onSync(cb: () => void): () => void;
}
export function createBulkLayer(
  overlay: BulkLayerOverlay,
  groups: readonly {
    readonly label: string;
    readonly polygons: Float32Array;
    readonly offsets: Uint32Array;
    readonly style?: { readonly stroke: string };
  }[],
  o?: { readonly cellSize?: number; readonly dotBelowPx?: number },
): {
  setVisible(v: boolean): void;
  hitTest(p: Point): { readonly group: number; readonly index: number } | undefined;
  geometryOf(group: number, index: number): VectorGeometry;
  destroy(): void;
};
```

### Effort

10.5-15 total. @osdlabel/dicom hardening 2-3: ISO 2022/GB18030 character sets, deflate, a generated full dictionary, DICOM JSON BulkDataURI, fuzzing on ~10k IDC headers. dicom-wsi 2-3: optical paths/ICC, HTJ2K/JPEG-LS codec workers, request batching/caching/auth hooks, WebGL drawer verified on real GPUs. dicom-export 3-4: coded-vocabulary hooks, SEG with mixed source sizes and FRACTIONAL write, SR qualitative evaluations/tracking UIDs, ANN measurements, a STOW-RS example, CI with dciodvfy+highdicom, interop checks with OHIF/Slim/3D Slicer. bulk-layer 2-3. calibrationRegions in viewer-api/decoration 0.5-1. Docs/examples 1. Estimated from the PoC's 10.7k lines (about 6k of them library code) and the gaps listed.

### Risks

- Viewer interop untested. highdicom and dciodvfy accept every output, but OHIF, Slim and 3D Slicer (dcmqi) each consume a different subset of TID 1500/ANN.
- Shape types are recovered from SCOORD by heuristic. DICOM SR has no rectangle, so a closed 4-vertex right-angle polyline comes back as a rectangle, and a 2-point polyline is indistinguishable from a line. A coded or private hint may be needed.
- Coordinate-frame pitfalls. 2D ANN has an origin ambiguity (CP-2411, FRAME vs VOLUME), and float32 2D coordinates err by up to 3.8e-4 px at 18k px. Archival exports should prefer 3D slide coordinates with float64.
- HTTP Range on static hosting depends on offset tables (an empty BOT falls back to a full GET). SM headers reach 13 MB and need up to 5 Range requests (survey max).
- Codec weight and licensing. OpenJPEG WASM is 99 KB gzip and must load lazily in a worker; HTJ2K and JPEG-LS need further WASM builds.
- Bulk annotations beyond the tested 55k. IDC's p75 group is about 441k shapes (per data-manifest.json); this layer is read-only, and editing at that scale needs a different model than Fabric.
- Character sets: only Latin-1 and UTF-8 are decoded today. Big-endian and deflated datasets are rejected.
- The WebGL drawer's behaviour on real GPUs is unmeasured. SwiftShader gave 3.9-17 s per view, which is inconclusive.
- SEG writing requires uniform Rows x Columns across source images and BINARY type only.

## Rejected alternatives

- **dcmjs as the parser/writer base (and its SR/SEG derivation helpers)**: 193.4 KB gzip against 14.2 KB for the whole in-house @osdlabel/dicom. Header parses are 5-60x slower in this bench, and a full read of the 2250-frame JPEG WSI level took 10.8 s. Its naturalized DICOM model would leak DICOM shapes into app code. It also pulls core-js-pure, which needed an allowBuilds exception.
- **dicom-parser for reading plus a separate writer**: Read-only, so SR/SEG/ANN still need a writer and a DICOM JSON reader. It threw on a Range-truncated header (the static-hosting case), and its bundle saving over the in-house reader is about 2 KB gzip (7.4 vs 5.4 KB).
- **Make osdlabel's annotation model DICOM-shaped (SR content tree or ANN groups as the core model)**: Contradicts 'speak DICOM, don't be DICOM'. The PoC shows the plain Geometry/MaskSnapshot model round-trips to SR within 2e-5 px and to SEG exactly, so the core model loses nothing by staying DICOM-free.
- **Convert DICOM WSI to DZI/IIIF server-side**: Duplicates storage, needs a deployed service ('a library, not a system'), and loses native DICOM. The custom OSD tile source opens DICOM frames directly: first tile in 67-257 ms locally, 69 ms median frame latency from IDC's bucket.
- **Import IDC-scale bulk annotations as ordinary Fabric annotations**: Measured: 8000 polygons take 2309 ms per forced-raster frame at fit, 4.0 s to mount and 373 MB of heap, with OSD tile timeouts. The 55k-polygon file cannot be loaded this way.
- **A single Path2D companion layer without LOD**: Still 2355 ms per fit frame at 55k polygons in software raster, and closePath() is quadratic in Chromium 153. Grid culling plus a dot LOD brings it to 2.9 ms or less.
- **Adopt Cornerstone3D/OHIF or Slim's OpenLayers stack for DICOM**: A monolithic rendering pipeline, contrary to best-tool-per-job. Every DICOM capability tested here fits as a leaf package around OSD + Fabric + DOM, with zero core changes.
- **Add DICOM fields (UIDs, frame of reference) to OsdAnnotation or ImageSource**: Unnecessary: a host-side Map<ImageId, DicomImageContext> carried everything export needed in the end-to-end flow. The only proposed core addition is the DICOM-free calibrationRegions.
- **Bundle a DICOMweb client (dicomweb-client) in the library**: The FrameSource interface plus a host-supplied fetch covers WADO-RS (metadata + frames/{n}) in under 100 lines. Transport, auth and caching stay host concerns.

## Architectural stress

Existing files changed: 2; existing lines changed: 549; new lines: 10712.

The 2 existing files changed are workspace config, not packages. pnpm-workspace.yaml gets +2 lines (allowBuilds core-js-pure:false, needed only for the dcmjs comparison) and pnpm-lock.yaml +547. The diff over all 13 existing packages (annotation, viewer-api, geometry, annotation-context, decoration, validation, fabric-annotations, fabric-osd, osdlabel, solid, react, mask, osd-helper) and both dev apps is empty: 0 files, 0 lines. The 10 712 new lines are code: dicom 2986 src+config + 468 tests; dicom-export 1507 + 198; dicom-wsi 830 + 146; apps/poc-dicom 4497 + 80 tests. A further 7700 lines are JSON data (data-manifest.json, survey-manifest.json, results/representative.json). Expressivity gaps were bridged without touching the core: calibration regions via an app-level provider wrapper, the bulk layer via FabricOverlay's existing overlayElement + onSync, and DICOM provenance via a host-side Map<ImageId, DicomImageContext>.

## Reproduce

```sh
pnpm install && pnpm exec turbo run build --filter='./packages/*' && pnpm --filter @osdlabel/poc-dicom setup:python && pnpm --filter @osdlabel/poc-dicom bench -- --reps 3   (fetches about 80 MB of public IDC data on first run via scripts/fetch-data.mjs; writes apps/poc-dicom/results/bench-<stamp>.json and latest.json and prints summary tables. Flags: --no-browser, --no-remote, --no-bulk (skips the slowest section), --survey (400-instance IDC header survey over the network), --headed, --python PATH, --port N. Python validation is optional and is skipped with a note if no venv exists. On a desktop with a real GPU: POC_CHROMIUM="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" pnpm --filter @osdlabel/poc-dicom bench -- --reps 3 --headed. Manual: pnpm --filter @osdlabel/poc-dicom dev, then open http://127.0.0.1:5400/wsi.html?role=sm-jpeg&mode=dicomweb&drawer=webgl, /annotate.html or /bulk.html?n=55092&mode=lod. Representative run committed at apps/poc-dicom/results/representative.json.)
```

## Caveats

- The machine was heavily shared: 1-min load average was 9.3 at the start and 18.5 at the end of the 701 s representative run, on 4 cores. All timings are medians of 3 reps and noisy; counts, bytes, fidelity and validation results do not depend on load.
- No GPU. WebGL2 and Canvas2D run on SwiftShader / software raster, so the WebGL-drawer WSI numbers (3.9-17 s per view) are CPU-emulated and not representative. Canvas-drawer and bulk-layer draw times are CPU raster times and will be lower with GPU canvas.
- Pan frame times (rAF to rAF) include OSD's software tile redraw: the baseline with 0 annotations was 154-394 ms. Forced-raster draw times (with a 1-px getImageData readback) isolate the layer cost, but the readback itself adds a sync point.
- The bulk test uses real IDC polygons, rescaled from a TCGA slide into a 4000x3000-px region of the GTEx slide. Positions are synthetic; median screen sizes per phase are reported (0.24 / 1.9 / 15 px), and visible counts at zoom64 (1516-3820) are an upper bound for a real 40x view.
- 'DICOMweb' is a local emulator (Vite middleware reading frames from disk per request). A +50 ms latency case and a real IDC-bucket Range probe (run from Node, with no rendering and no CORS) bracket real-archive behaviour.
- Time/velocity (M-mode, Doppler) calibration regions are covered by synthetic unit tests only. The random 40-instance US survey contained no multi-calibration image; the CEUS file has two panes with identical calibration.
- Export fidelity was checked against our own expectations plus highdicom's reading and dciodvfy. No clinical viewer (OHIF, Slim, 3D Slicer) was used to open the outputs.
- The dciodvfy warnings filtered as 0 were inherited from the de-identified source data (StudyTime/StudyID missing, which only matters for DICOMDIR, and a retired PN form in the GTEx PatientName). There were no errors.
- The parser bench runs in Node 22, not the browser. The first SR build (47.6 ms) includes JIT warm-up.
- The header survey (400 instances) and its summary come from the previous agent's --survey run on 2026-10-23; this run reused results/survey.json, marked \_from in the JSON.
- The reader decodes only Latin-1 and UTF-8 character sets, and rejects big-endian and deflated transfer syntaxes. SEG writing needs uniform source dimensions and is BINARY only.
- Data: 17 public IDC series/instances (CC BY 4.0 / 3.0, licences and DOIs in data-manifest.json), fetched by a committed script. None is committed.
- The Path2D closePath quadratic finding comes from one run of scripts/path2d-closepath-probe.mjs in Chromium 153 headless.

## Open questions

- Should CalibrationRegion[] become an optional ImageSource field in @osdlabel/viewer-api, with createMeasurementProvider made region-aware? Or should region awareness stay a wrapper provider in a DICOM-free add-on package?
- What should exports default to: 2D image coordinates (exact round trip; also works for US/DX without a frame of reference), or SCOORD3D / 3D slide mm whenever plane geometry exists?
- Who maps osdlabel labels and contexts to coded concepts (SNOMED CT / DCM) for SR findings, SEG categories and ANN types: AnnotationContext metadata, or a host callback at export?
- Should DICOM provenance (referenced SOP/frame) stay host-side, as in the PoC's Map<ImageId, DicomImageContext>, or be persisted with each annotation as an extension field (Annotation<E>)?
- One @osdlabel/dicom-export package, or three (dicom-sr, dicom-seg, dicom-ann) to match the one-thing-well rule?
- Should the library ship a DICOMweb transport (QIDO/WADO/STOW helpers), or only the FrameSource interface with a host-supplied fetch?
- Bulk annotations (IDC p75 about 441k shapes): is a read-only layer with promote-to-annotation enough, or must bulk shapes be editable?
- Is correct DICOM display (windowing of 12-16-bit data, VOI LUT, MONOCHROME1) a prerequisite for a first DICOM release? That ties this work to the pixel-pipeline PoC's timeline.
- Which consumers should we interop-test against first: OHIF, Slim, or 3D Slicer/dcmqi?

## Independent review

A second agent re-ran the benchmark and tried to break the conclusions.

### Blocking findings

- **One of the three "decisive factors" for H1b, and the stated reason for rejecting dicom-parser ("it threw on a Range-truncated header (the static-hosting case)"), comes from a flaw in the test harness, not from dicom-parser.**
  - Evidence: parser-bench.mjs runs its correctness pass as reader.parse(bytes, false), i.e. full mode with no untilTag, on us-ceus, a 262 144-byte header-only Range prefix. It records the throw as the string "[object Object]" (my rerun gives the same 102/103) and never looks at the error. I ran dicom-parser 1.8.21 on the same file. With { untilTag: 'x7fe00010' }, which is the very header mode the bench uses for its own timings, it returns OK: 70 elements, Modality US, FrameTime 111.09528, and both ultrasound regions (PhysicalDeltaX/Y 0.0299234). Even in full mode, the thrown exception carries ex.dataSet: 62 elements with both regions. The script is /tmp/claude-0/-home-user-osdlabel/d2340e79-db4e-595c-a199-55b42694fb93/scratchpad/dicomrev-wf182118/dp-trunc.mjs.
  - Required fix: Run correctness on Range-fetched files in header mode, or read ex.dataSet, and report dicom-parser as 103/103. Remove truncation tolerance from the H1b decisive factors and from the rejected-alternative text. Then justify the in-house reader against 'dicom-parser + in-house writer + in-house DICOM JSON' on what remains: a writer is needed either way, the reader saves about 2 KB gzip (7.4 vs 5.4), and the 2-3 engineer-weeks of reader hardening the estimate budgets covers ground dicom-parser already handles (big endian, deflate through an inflater callback, a decade of field use). H1b may still hold, but it is currently supported partly by an artifact.
- **The bulk-layer half of the 'zero core change' claim (H4, architecture_stress, existing_package_changes: 'None were needed') depends on a test-only hook and a private field. The recommendation omits the binding change a production @osdlabel/bulk-layer needs.**
  - Evidence: bulk-page.tsx reaches the overlay through document.querySelector('.openseadragon-canvas').**osdOverlay and ov.\_viewer.viewport. FabricOverlay sets **osdOverlay only when options.testMode is set (fabric-overlay.ts:408-413, commented 'for E2E test access'), and \_viewer is declared private (fabric-overlay.ts:197). The page renders <Annotator ... testMode/>. ViewerCell has onOverlayReady, but neither Solid's nor React's GridView forwards it (GridView.tsx passes only imageSource/isActive/cellIndex/onActivate), so a host of the stock <Annotator> has no public route to a cell's FabricOverlay.
  - Required fix: Add to existing_package_changes a small additive public hook in @osdlabel/solid and @osdlabel/react, per the binding-parity rule: forward onOverlayReady from Annotator/GridView, or add a companion-layer slot. Alternatively, show the bulk layer running in a host-composed grid of the exported ViewerCell with onOverlayReady and without testMode. Then qualify the H4 and architecture_stress notes accordingly. The DICOM ingest, export and WSI paths do not need this; the claim holds for them.

### Non-blocking findings

- Validation evidence is weaker than presented for SR. dciodvfy checks the IOD, not the TID 1500 template, and highdicom's srread is lenient. I mutated results/export/sr-ct-2d.dcm five ways: root concept replaced by a nonsense code, every Tracking Identifier/UID deleted, the Image Library container removed, measurement-group relationship set to HAS PROPERTIES, and units set to a non-UCUM code. All five gave dciodvfy 0 errors. Only the units case produced warnings, and highdicom srread read every mutant 'OK' with 6 groups. A manual dcsrdump of the real output looks correct: root, observer context, Image Library, TID 1410/1501 groups, UCUM mm/mm2, and an area that checks against the pixel geometry. So conformance is plausible but not tool-verified, and the proposed 'CI validates every builder with dciodvfy and highdicom' would not catch template regressions. Add a template oracle: PixelMed DicomSRValidator, dcmqi tid1500reader, or a structural diff against highdicom-constructed TID 1500 (its constructors validate). Also add a read test with dcmjs/OHIF's MeasurementReport adapter. PixelMed and IDC's DICOMweb proxy both returned 403 from this sandbox, so I could not do this myself.
- 'A level-of-detail layer draws all 55 092 nuclei in 2.9 ms or less' overstates what was measured. At fit and zoom8 the LOD writes 2x2-pixel dots into an ImageData (median nucleus 0.24 and 1.9 px). Polygons are stroked only at zoom64. In this layout that view contains about 13 nuclei; the reported 3820 'visible' are grid-cell candidates within a ±1-cell margin. The worst case for the polygon path never occurs in this test: dense tissue just above the 4 px dot threshold, with on the order of 10^4 polygons on screen. That case decides whether Canvas2D is enough at IDC's p75 of about 441k shapes. The H2c refutation of Fabric is unaffected.
- The heap figures (e.g. Fabric 8000 = 373 MB; my run 384 MB) come from performance.memory.usedJSHeapSize. Chromium was launched without --enable-precise-memory-info, so the value is quantized, and no GC is forced first, so it includes garbage. It is a coarse used-heap figure, not retained size. The Fabric baseline also runs with skipOffscreen:false globally (fabric-overlay.ts:344), so the zoom8/zoom64 Fabric timings draw all 8000 objects when only a few are on screen. The fit-view, mount-time and heap evidence still refute H2c.
- The summary's headline '8000 polygons take 2.3 s per frame' omits the software-raster qualifier that appears in the caveats; with a GPU canvas it would be far lower. The WebGL numbers, by contrast, are correctly labelled as SwiftShader and not presented as GPU performance.
- The summary says 'SR geometry round-trips within 2e-5 px', but the WSI SR 2D case is 4.4e-4 px (float32 at about 18k px), 22 times larger. It is still negligible and is reported correctly in H3a.
- H2 asked for first paint. firstTileMs is OSD's 'tile-loaded' event, when the tile enters the cache, not when it is drawn, and 'home' is fully-loaded rather than drawn. Part 10 mode's 67 ms first tile also excludes the 200-230 ms metadata phase, which downloads the whole 15.9 MB series. The rejected-alternative line 'first tile in 67-257 ms locally' quotes that number.
- The DICOMweb emulator and client were written together. The client takes the transfer syntax from the top-level multipart Content-Type, or from the 00020010 the emulator injects into series metadata, and otherwise falls back to a hard-coded JPEG Baseline (frame-source.ts). Real WADO-RS servers commonly put transfer-syntax only on each part's header and may omit 00020010. On such a server a JPEG 2000 slide would be sent to createImageBitmap and fail. No real-server test was possible here.
- The Range frame source (framesFromBot) assumes one fragment per frame and that Pixel Data is the last element (last frame length = fileSize - 8). It ignores the Extended Offset Table even though its doc comment says 'Basic or Extended', so files with an empty BOT plus an EOT fall back to a full-file GET. The EOT sits before Pixel Data and is already in the header that gets read.
- The real-network probe uses n=8 sequential frames, so its 'p90' is essentially the maximum.
- 'Lint and prettier all clean' does not hold as checked. The three new packages and apps/poc-dicom define no lint script, so `pnpm lint` (turbo lint) never lints them. Linted directly, the TS sources pass, but the app's .mjs scripts have about 50 no-undef errors (browser/Node globals) and one unused variable. The committed data-manifest.json and results/representative.json fail prettier --check.
- The closePath side finding is real but not specific to Path2D. In the same probe, immediate-mode ctx.closePath() with 16 000 subpaths is equally slow (my run: Path2D 8.76 s, immediate 8.80 s, lineTo-close 42 ms).
- H1c cites the projection-radiography ambiguity (detector ImagerPixelSpacing vs ERMF-corrected) as part of the refutation. The proposed CalibrationRegion/AxisCalibration has no plane or basis field, so the proposal does not fix that half. PixelSpacing would need a basis or description (cf. Pixel Spacing Calibration Type/Description) so labels can read 'mm (detector)'. In the real sample, multi-calibration US images were 0/40; the time and velocity axes are covered only by synthetic tests, which the caveats acknowledge.
- On one concern per package: @osdlabel/dicom bundles encoding (Part 10 and DICOM JSON, read and write), mapping, and a CPU rendering stand-in (renderNativeFrame, which the recommendation does not mention). @osdlabel/dicom-export bundles three IODs, each with a reader and writer, and depends on @osdlabel/decoration only for measurement math. The recommendation defers the split to an open question rather than arguing against it. A cleaner cut is encoding vs mapping, sr/seg/ann, and measurement math in @osdlabel/geometry.
- export-annotations.ts puts every brush mask of a series into one segment labelled with the first mask's label, so labels are lost when there are several masks. In the end-to-end SEG, highdicom read it OK, but the mask was not checked for an exact round trip against osdlabel's mask.
- The tile source avoids importing OSD but still depends on OSD 5's ImageJob protocol (downloadTileStart / context.finish(ImageBitmap)) and a getLevelScale override, so it is tied to OSD's version, and OSD's tile-cache API may change in the next major. On the other hand, padded edge frames render correctly: OSD 5.0.1 crops them through getTileBounds(..., isSource) in both drawers.
- My survey rerun today gives 399/400: one PT object now returns HTTP 404 (IDC data churn). Every proportion the report quotes reproduces exactly.

### Claims checked

| Claim                                                                                                       | Verdict    | Note                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Zero lines changed in the 13 existing packages and both dev apps                                            | holds      | `git diff --numstat origin/claude/segmentation-brush-tool origin/claude/poc-dicom` touches only packages/dicom (3454), dicom-export (1705), dicom-wsi (976), apps/poc-dicom (12277), pnpm-lock.yaml (+547) and pnpm-workspace.yaml (+2). The merge base equals the base branch head. |
| architecture_stress: 2 existing files / 549 lines; 10 712 new lines of code plus about 7700 JSON            | holds      | 18 412 new lines minus the three JSON files (4089+3207+404=7700) gives 10 712.                                                                                                                                                                                                       |
| Speaking DICOM needs no core change; the bulk layer also needs none (overlayElement + onSync)               | overstated | True for ingest, WSI and export. The bulk layer uses the testMode-only \_\_osdOverlay hook and the private \_viewer; the stock Annotator exposes no cell overlay.                                                                                                                    |
| @osdlabel/dicom reads 103/103 files correctly vs pydicom (22 attributes)                                    | holds      | Reproduced 103/103; dcmjs also 103/103.                                                                                                                                                                                                                                              |
| dicom-parser 102/103: threw on the Range-truncated CEUS header                                              | wrong      | Harness artifact: full-mode parse of a header-only file. With untilTag it parses all 70 elements including both US regions, and ex.dataSet holds the partial parse otherwise.                                                                                                        |
| Own reader header parse 5-60x faster than dcmjs; bundle 14.2 KB vs 193.4 KB gzip                            | holds      | Bundle sizes reproduced exactly. Header parse is own < dicom-parser < dcmjs on every role; dcmjs full read of sm-jpeg took 4.8 s in my run vs 10.8 s reported.                                                                                                                       |
| 15/15 exports: dciodvfy 0 errors, highdicom reads them                                                      | holds      | Reproduced for all 10 bench cases and 5 end-to-end files.                                                                                                                                                                                                                            |
| Exports validate as SR TID 1500 (validation implies template conformance)                                   | overstated | Neither tool checks the template: five deliberate TID 1500 breaks all gave 0 dciodvfy errors and a clean highdicom read. Manual dcsrdump inspection looks correct.                                                                                                                   |
| SR geometry round-trips within 2e-5 px; measurements rel. error 3.7e-15                                     | overstated | Identical numbers on rerun, but the SM 2D worst case is 4.4e-4 px, not 2e-5.                                                                                                                                                                                                         |
| SEG BINARY round-trip exact                                                                                 | holds      | highdicom hash-equal. I also checked SEG Rows/Columns 256x256 match the CT, references resolve to CT instances, and the FrameOfReferenceUID matches.                                                                                                                                 |
| image->patient/slide matches highdicom ImageToReferenceTransformer within 2.8e-14 mm                        | holds      | Reproduced (0, 2.8e-14, 7.1e-15). Both sides use the corner-origin convention (±0.5 in plane.ts, same as the highdicom docstring), so the check is meaningful.                                                                                                                       |
| Third-party SR/SEG/ANN read back in agreement with highdicom (5/5)                                          | holds      | Reproduced: 55 092 POLYGON, 2 RECTANGLE, SEG 72 px, FRACTIONAL 45 px, 3 SR measurements; the QIBA SR is unreadable by highdicom.                                                                                                                                                     |
| Stock <Annotator> annotates DICOM and exports SR/SEG/ANN end to end                                         | holds      | Real mouse input through Playwright; 5 files, all 0 dciodvfy errors; US line labelled 'L: 10.01 mm'.                                                                                                                                                                                 |
| WSI opens in OSD via a plain-object tile source with 0 failed tiles; JPEG and J2K                           | holds      | My run home-view medians: JPEG part10 684, range 680, dicomweb 762, +50 ms 798 ms; J2K 1595 / 1547 ms; 0 failed tiles. OSD crops padded edge frames itself.                                                                                                                          |
| Measured first paint and tile latency                                                                       | overstated | 'First tile' is the tile-loaded (cache) event, not a paint; part10 first tile excludes the whole-series download.                                                                                                                                                                    |
| WebGL drawer numbers are SwiftShader, not GPU                                                               | holds      | Labelled correctly; my run home 3124 ms with SwiftShader.                                                                                                                                                                                                                            |
| H2c refuted: IDC-scale ANN cannot be Fabric objects                                                         | holds      | My run, Fabric 8000: fit draw 1720 ms, mount 2630 ms, about 384 MB used heap. Raster is software and heap is coarse, but mount and heap growth decide it regardless.                                                                                                                 |
| LOD layer draws all 55 092 nuclei in <=2.9 ms                                                               | overstated | Those are 2x2 dots. Polygons were drawn only in a sparse zoom64 view (about 13 on screen); the dense polygon case was not measured. My run: 0.93 ms at fit.                                                                                                                          |
| Chromium Path2D.closePath() quadratic                                                                       | overstated | Reproduced (16k: 8.76 s vs 42 ms), but immediate-mode ctx.closePath() is equally slow, so it is not Path2D-specific.                                                                                                                                                                 |
| IDC survey: US 27/40 regions, 3 multi-region, 0 multi-calibration; MG ERMF 17/40, XA 33/40; CR invert 57.5% | holds      | Rerun over the network reproduces every proportion; 399/400 today because of one PT 404.                                                                                                                                                                                             |
| H1c: single PixelSpacing cannot express US regions or time/velocity axes                                    | holds      | Holds in principle; CEUS has real dual panes. Time/velocity evidence is synthetic only, and the ERMF ambiguity it cites is not addressed by the proposed calibrationRegions.                                                                                                         |
| 43 unit tests, typecheck, lint and prettier clean                                                           | overstated | Tests: 25+7+7+4, all pass; typecheck passes. The new packages have no lint script, the app .mjs scripts fail ESLint, and two committed JSON files fail Prettier.                                                                                                                     |
| Real IDC bucket Range probe: metadata 279 ms, frame median 69 ms                                            | holds      | My run: metadata 170 ms, sequential median 52 ms (n=8), 24 frames at concurrency 6 in 266 ms.                                                                                                                                                                                        |

### Reviewer's rerun

I followed the bench command at HEAD 712862c: pnpm install, then building the PoC's dependency closure with turbo build --filter=@osdlabel/poc-dicom^... because the sandbox refused the --filter='./packages/\*' glob, then setup:python, then bench --reps 3 --port 5437. It completed in 457.7 s, with 1-minute load 5.8 at the start and 5.2 at the end (lighter than the reported 9.3 to 18.5); Chromium 153.0.8010.12.

- **H1 parsers:** @osdlabel/dicom 103/103, dcmjs 103/103, dicom-parser 102/103 (the same CEUS artifact, error recorded as '[object Object]'). Header parse ms, own / dicom-parser / dcmjs: CT 3.39/6.21/33.25, MR-implicit 2.48/4.02/45.6, SM-jpeg 0.27/0.78/8.83. dcmjs full read of SM-jpeg took 4776 ms. Bundles gzip, identical to the report: own reader 5.4, own package 14.2, dicom-parser 7.4, dcmjs 193.4, codec-openjpeg 99 KB.
- **H3 export:** all 10 cases have dciodvfy 0 errors and read OK in highdicom. Max coordinate error in px: SR CT-2d 7.2e-6, CT-3d 6.6e-6, MR-3d 2.0e-6, US-2d 1.86e-5, SM-2d 4.4e-4. ANN 2D 3.8e-4, 3D f32 3.8e-3, f64 6.4e-12. SEG exact on both. Transform cross-check 0 / 2.8e-14 / 7.1e-15 mm. Interop 5/5 agree with highdicom; the QIBA SR is unreadable by both.
- **H2 WSI** (median of 3; metadata / first tile / home, ms; all 0 failed tiles):
  - JPEG part10: 198 / 68.5 / 684
  - JPEG range: 55 / 104 / 680 (104 requests, 2.93 MB)
  - JPEG dicomweb: 40 / 148 / 762 (100 requests, 1.55 MB)
  - JPEG dicomweb +50 ms: 91 / 165 / 798
  - JPEG dicomweb webgl (SwiftShader): 36 / 134 / 3124
  - J2K part10: 154 / 176 / 1595 (90 tiles; worker decode median 4.5 ms)
  - J2K dicomweb: 38 / 175 / 1547 (139 requests, 384 KB)
- **End-to-end Annotator:** 11.9 s, 27 images, 5 exported files all with dciodvfy 0 errors and read OK by highdicom, US label 'L: 10.01 mm'.
- **Bulk** (fit draw ms, mount ms, heap MB):
  - Fabric 500: 189, 326, 25
  - Fabric 2000: 503, 678, 64
  - Fabric 8000: 1720, 2630, 384
  - Naive layer 55 092: 1718
  - LOD 55 092: 0.93 at fit (55 090 dots at 0.24 px), 0.59 at zoom8, 1.42 at zoom64 (3820 candidates at 15.4 px)
- **Remote IDC bucket:** metadata 170 ms (5 requests, 1.31 MB); sequential frame median 52 ms, p90 63 (n=8); 24 frames at concurrency 6 in 266 ms.

Extra checks:

- The survey rerun reproduces every quoted proportion (399/400 because of one PT 404).
- The closePath probe gives 16k closePath 8.76 s, lineTo 42 ms, immediate-mode closePath 8.80 s.
- Unit tests 43/43 and typecheck pass.

Every count, byte size and fidelity number matches the report; timings are the same order of magnitude and mostly faster at lower load.

### Alternatives the reviewer says were missed

- dicom-parser (header via untilTag, partial parses via ex.dataSet) plus the PoC's own ~250-line writer and DICOM JSON reader. It was rejected for a failure that is a harness artifact, and it would remove most of the budgeted reader-hardening effort (big endian, deflate through an inflater callback, years of field use).
- dcmjs loaded only for export, as a dynamic import rather than in the main bundle, with its MeasurementReport/TID 1500 adapters. That gives OHIF/Cornerstone interop for free, and the report lists viewer interop as its top risk. The 193 KB cost then hits only users who export.
- A WebGL vector layer for bulk annotations (instanced lines or points, as Slim does through OpenLayers WebGL layers, or deck.gl-style rendering) instead of a Canvas2D grid plus dot LOD. This matters for IDC's p75 of about 441k shapes and for dense-tissue views where more than 10^4 polygons are on screen.
- Rendering bulk annotations as a second OSD TiledImage: per-tile rasterisation in a worker with OffscreenCanvas, behind the same custom tile-source pattern the PoC already built. OSD then caches the result and picks the level of detail per pyramid level, with no per-frame vector redraw.
- Enabling Fabric's offscreen culling when the view is not rotated (it is disabled globally today), and a single Fabric Path per annotation group, as fairer Fabric baselines before rejecting Fabric.
- A template-level SR oracle (PixelMed DicomSRValidator, dcmqi tid1500reader, or highdicom's TID 1500 constructors as a reference tree) rather than relying on dciodvfy plus a lenient srread.
- Server-side transcoding or rendered frames for JPEG 2000 slides where the archive supports it (an Accept: image/jpeg frames request), as an alternative to always shipping an OpenJPEG WASM worker.
- Composing a custom grid from the exported ViewerCell with onOverlayReady, which reaches the overlay without testMode and without a core change, rather than using the testMode DOM expando.
