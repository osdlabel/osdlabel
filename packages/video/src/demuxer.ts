/**
 * The one thing `@osdlabel/video` needs from a container library: the
 * stream's packets in decode order, and a decoder configuration.
 *
 * Kept this small so a container library is an adapter, not a dependency:
 * `@osdlabel/video/mediabunny` implements it over mediabunny (MP4, WebM);
 * an mp4box.js or DICOM-encapsulated-video adapter would implement the same
 * three members. Only the mediabunny adapter exists and has been measured.
 */
export interface DemuxedPacket {
  /** Presentation timestamp, integer microseconds. */
  readonly timestampUs: number;
  /** Duration, microseconds (0 when the container does not say). */
  readonly durationUs: number;
  /** A packet decoding can start from. */
  readonly key: boolean;
}

export interface Demuxer {
  /** What `VideoDecoder.configure` needs, including `description` (avcC/hvcC) when the codec has one. */
  readonly decoderConfig: VideoDecoderConfig;
  readonly displayWidth: number;
  readonly displayHeight: number;
  /** Every packet of the video track, in decode order. */
  readonly packets: readonly DemuxedPacket[];
  /** Encoded chunk of decode-order packet `j`. */
  chunk(j: number): EncodedVideoChunk;
  /** Release the container's resources. */
  close(): void;
}
