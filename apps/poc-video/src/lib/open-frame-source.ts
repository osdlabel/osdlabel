import { WebCodecsFrameSource } from '@osdlabel/video';
import type { FrameSourceOptions } from '@osdlabel/video';
import { MediabunnyDemuxer } from '@osdlabel/video/mediabunny';

/** Demux `url` with the mediabunny adapter and open a WebCodecs frame source on it. */
export async function openFrameSource(
  url: string,
  options: FrameSourceOptions,
): Promise<{ source: WebCodecsFrameSource; demuxer: MediabunnyDemuxer }> {
  const demuxer = await MediabunnyDemuxer.open(url);
  return { source: await WebCodecsFrameSource.create(demuxer, options), demuxer };
}
