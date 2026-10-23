/**
 * Binary wire format shared by the remote encoder/provider and a server:
 *
 *   [u32 LE header length][header JSON, UTF-8][pad to 4 bytes][blob bytes …]
 *
 * The header lists named blobs (`offset`/`byteLength` relative to the end of
 * the padded header) plus arbitrary JSON metadata. Embeddings travel as
 * float16 by default: half the bytes of float32, and SAM decoders are
 * insensitive to the rounding (the report measures the mask IoU impact).
 */
export type WireDType = 'float32' | 'float16' | 'uint8';

export interface WireBlobHeader {
  readonly name: string;
  readonly dtype: WireDType;
  readonly dims: readonly number[];
  readonly offset: number;
  readonly byteLength: number;
}

export interface WireHeader<TMeta> {
  readonly blobs: readonly WireBlobHeader[];
  readonly meta: TMeta;
}

export interface WireBlob {
  readonly name: string;
  readonly dims: readonly number[];
  readonly data: Float32Array | Uint8Array;
}

// --------------------------------------------------------------- float16 ---

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

export function float32ToFloat16(src: Float32Array): Uint16Array {
  const out = new Uint16Array(src.length);
  for (let i = 0; i < src.length; i++) {
    f32[0] = src[i]!;
    const x = u32[0]!;
    const sign = (x >>> 16) & 0x8000;
    const exp = (x >>> 23) & 0xff;
    let mant = x & 0x7fffff;
    if (exp === 0xff) {
      out[i] = sign | 0x7c00 | (mant ? 0x200 : 0);
      continue;
    }
    const e = exp - 127 + 15;
    if (e >= 0x1f) {
      out[i] = sign | 0x7c00;
    } else if (e <= 0) {
      if (e < -10) {
        out[i] = sign;
      } else {
        mant |= 0x800000;
        const shift = 14 - e;
        let half = mant >> shift;
        if ((mant >> (shift - 1)) & 1) half++; // round half up
        out[i] = sign | half;
      }
    } else {
      let half = sign | (e << 10) | (mant >> 13);
      if (mant & 0x1000) half++; // round to nearest
      out[i] = half;
    }
  }
  return out;
}

export function float16ToFloat32(src: Uint16Array): Float32Array {
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i++) {
    const h = src[i]!;
    const sign = (h & 0x8000) << 16;
    const exp = (h >>> 10) & 0x1f;
    const mant = h & 0x3ff;
    if (exp === 0) {
      out[i] = (sign ? -1 : 1) * mant * 2 ** -24;
      continue;
    }
    if (exp === 0x1f) {
      u32[0] = sign | 0x7f800000 | (mant << 13);
    } else {
      u32[0] = sign | ((exp - 15 + 127) << 23) | (mant << 13);
    }
    out[i] = f32[0]!;
  }
  return out;
}

// --------------------------------------------------------------- framing ---

export function encodeWire<TMeta>(
  blobs: readonly { name: string; dims: readonly number[]; data: Float32Array | Uint8Array; dtype?: WireDType }[],
  meta: TMeta,
): Uint8Array {
  const parts: Uint8Array[] = [];
  const headers: WireBlobHeader[] = [];
  let offset = 0;
  for (const b of blobs) {
    const dtype: WireDType = b.dtype ?? (b.data instanceof Uint8Array ? 'uint8' : 'float32');
    let bytes: Uint8Array;
    if (dtype === 'float16') {
      if (!(b.data instanceof Float32Array)) throw new TypeError('float16 needs float32 input');
      const h = float32ToFloat16(b.data);
      bytes = new Uint8Array(h.buffer, h.byteOffset, h.byteLength);
    } else {
      bytes = new Uint8Array(b.data.buffer, b.data.byteOffset, b.data.byteLength);
    }
    const padded = Math.ceil(bytes.byteLength / 4) * 4;
    headers.push({ name: b.name, dtype, dims: b.dims, offset, byteLength: bytes.byteLength });
    parts.push(bytes);
    if (padded > bytes.byteLength) parts.push(new Uint8Array(padded - bytes.byteLength));
    offset += padded;
  }
  const header = new TextEncoder().encode(JSON.stringify({ blobs: headers, meta } satisfies WireHeader<TMeta>));
  const headerPadded = Math.ceil((4 + header.byteLength) / 4) * 4;
  const out = new Uint8Array(headerPadded + offset);
  new DataView(out.buffer).setUint32(0, header.byteLength, true);
  out.set(header, 4);
  let pos = headerPadded;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.byteLength;
  }
  return out;
}

export function decodeWire<TMeta>(buffer: ArrayBuffer): { blobs: WireBlob[]; meta: TMeta } {
  const view = new DataView(buffer);
  const headerLength = view.getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, headerLength))) as WireHeader<TMeta>;
  const base = Math.ceil((4 + headerLength) / 4) * 4;
  const blobs = header.blobs.map((b): WireBlob => {
    const start = base + b.offset;
    switch (b.dtype) {
      case 'float32':
        return { name: b.name, dims: b.dims, data: new Float32Array(buffer.slice(start, start + b.byteLength)) };
      case 'float16':
        return {
          name: b.name,
          dims: b.dims,
          data: float16ToFloat32(new Uint16Array(buffer.slice(start, start + b.byteLength))),
        };
      case 'uint8':
        return { name: b.name, dims: b.dims, data: new Uint8Array(buffer.slice(start, start + b.byteLength)) };
    }
  });
  return { blobs, meta: header.meta };
}
