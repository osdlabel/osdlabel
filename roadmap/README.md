# osdlabel roadmap, October 2026

This folder is the repository copy of a roadmap study for osdlabel: which directions it can take while keeping one concern per package, and in what order. The living version is the doc [osdlabel Roadmap: Strategy & Feasibility](https://claude.ai/artifact/RkjPD8YqHFxcpVV99tHG8x). Comments and answers to its questions go there. This copy was taken on October 24, 2026, and updated on October 25 with the follow-up on #149's mask format, so the study can be linked from issues and pull requests. Where the two disagree, the doc is newer.

The short version: osdlabel should stay an annotation layer over one 2D viewport host, OpenSeadragon, and let each modality plug its pixels in as a leaf package. That means a tile source for DICOM slides, a drawer subclass for 16-bit windowing, and a frame source repainted in place for stacks, video and volume planes. Fabric keeps drawing editable shapes and the DOM keeps drawing decorations. Only true 3D brings a second renderer, Niivue, as an optional cell. The order is a patch this week, one breaking foundation release, then near-term tracks in any order, stacks, video, and options that start when users ask for them.

![A patch this week, one foundation release, then tracks in any order](diagrams/timeline.svg)

## Files

| File                                                   | What it holds                                                                                                                                                                                                            |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [roadmap.md](roadmap.md)                               | The recommendation: the roadmap and its gates, a verdict per direction, questions for the maintainer, the architecture stress map and package graph, each track in detail, maturity fixes, and what was rejected and why |
| [evidence.md](evidence.md)                             | One section per proof of concept: what was built, what was measured, and what the independent review and fix pass changed                                                                                                |
| [plan.md](plan.md)                                     | The hypotheses each proof of concept tested, with their outcome, and the method                                                                                                                                          |
| [landscape.md](landscape.md)                           | Where osdlabel sits among peer viewers and annotation tools: the gap it can fill, who does what, what the field agrees on, and the WebGL context ceiling everyone works around                                           |
| [sources.md](sources.md)                               | Every source the research cited: 347 entries by topic (312 distinct URLs), 22 cited only by the fact-check passes, and 20 from the mask-format follow-up                                                                 |
| [maturity-audit.md](maturity-audit.md)                 | The read-only maturity and polish audit of `main` at e0eba8f behind the roadmap's maturity section                                                                                                                       |
| [diagrams/](diagrams/)                                 | The roadmap timeline and the package graph, as SVG and PNG, rendered from the doc                                                                                                                                        |
| [experiments/web-platform/](experiments/web-platform/) | The browser-platform probes behind the landscape's limits (WebGL contexts, buffer sizes, codecs, video seeking, high bit depth)                                                                                          |
| [experiments/mask-format/](experiments/mask-format/)   | The probes behind the section on #149's mask format: its cap, sparse full-resolution storage, and the review of the resolution spike                                                                                     |

## Branches

Nothing here is merged, and no pull request is open. Each proof-of-concept branch builds on PR #149's head (`claude/segmentation-brush-tool` at 3233d2c, itself on `main` at e0eba8f) and carries a `REPORT.md` with its results, the review's findings and the commands to rerun it.

| Branch                         | Commit  | What it shows                                                                                                                                                              | Report                              |
| ------------------------------ | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `claude/fix-rect-origin`       | e0d2695 | Rectangles paint where their geometry says under Fabric 7; on `main`, meant to ship as a patch (question 17)                                                               | the commit message                  |
| `claude/poc-pixel-pipeline`    | d2d7cb7 | 16-bit window/level as a tile source and drawer subclass, and the WebGL context budget                                                                                     | `apps/poc-pixel-pipeline/REPORT.md` |
| `claude/poc-frame-axis`        | 275c43c | Stacks and cine: a frame axis for pixels, one image ID per slice, an in-place presenter                                                                                    | `apps/poc-frame-axis/REPORT.md`     |
| `claude/poc-video`             | 0616a9a | Frame-accurate WebCodecs decoding, OpenSeadragon drawing each frame, keyframes as ordinary annotations                                                                     | `apps/poc-video/REPORT.md`          |
| `claude/poc-volume`            | 1689530 | Volumes and MPR: CPU reslicing, bricked label maps, reversible plane IDs, a Niivue 3D cell                                                                                 | `apps/poc-volume/REPORT.md`         |
| `claude/poc-dicom`             | 85a3f3f | DICOM ingest, whole-slide tiles over HTTP, DICOMweb or files, and SR, SEG and bulk-annotation export on public data                                                        | `apps/poc-dicom/REPORT.md`          |
| `claude/poc-sam`               | 39579b8 | SAM as a provider contract and a tool, in a worker, on crops of the tile pyramid                                                                                           | `apps/poc-sam/REPORT.md`            |
| `claude/poc-element`           | b766e69 | One custom element for every framework, and one UI contract (tokens, parts, slots) for both bindings                                                                       | `apps/poc-element/REPORT.md`        |
| `claude/spike-mask-resolution` | 70dd415 | A power-of-two downsample on #149's masks, so the brush and SAM can store regions larger than its 64 Mi-pixel cap (question 8). One commit on #149's current head, 58a379f | `SPIKE-REPORT.md`                   |

The package graph shows where each prototype's packages would sit:

![New capabilities land as leaf packages; the core opens a few seams](diagrams/package-graph.svg)

## Rerunning the benchmarks on a real GPU

Every GPU number in the study comes from SwiftShader, a software renderer, on a shared 4-core machine. Seven decisions wait on a run with real hardware (question 16 in [roadmap.md](roadmap.md)). On each branch, run `pnpm install` and build the packages as its `REPORT.md` describes, then:

```sh
git checkout claude/poc-pixel-pipeline && pnpm --filter @osdlabel/poc-pixel-pipeline bench --channel chrome --headed
git checkout claude/poc-frame-axis && pnpm --filter @osdlabel/poc-frame-axis bench --headed --channel chrome
git checkout claude/poc-volume && pnpm --filter @osdlabel/poc-volume bench -- --headed --chromium "/path/to/Google Chrome"
git checkout claude/poc-sam && pnpm --filter @osdlabel/poc-sam fetch-models && pnpm --filter @osdlabel/poc-sam bench -- --chromium "/path/to/Google Chrome" --headed --webgpu-models mobile_sam,sam2_tiny_real
git checkout claude/poc-video && pnpm exec turbo run build --filter=@osdlabel/poc-video^... && pnpm --filter @osdlabel/poc-video bench -- --only h2 --chromium "/path/to/Google Chrome" --headed
```

Results land under each app's `results/` directory. Attach them to a comment on the doc's question 16 and they will be folded into the roadmap.

A rerun on an otherwise idle machine reproduced the SAM numbers, then hit a time limit during video, so the other benchmarks keep their shared-machine timings.
