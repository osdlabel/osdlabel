/**
 * Small binary helpers shared by the mask codecs. Kept dependency-free and
 * environment-neutral: `btoa` / `atob` exist in browsers and in Node 16+.
 */

/** Chunked to avoid blowing the argument limit on large masks. */
const CHUNK = 0x8000;

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  // `atob` throws a DOMException on a bad alphabet. Every other decode failure
  // in this package is a RangeError, and callers catch that shape; letting one
  // path throw something else means a corrupt payload escapes the handler.
  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    throw new RangeError('Mask counts are not valid base64');
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Unsigned LEB128: 7 payload bits per byte, high bit marks "more to come".
 *
 * Arithmetic is done with division rather than bit operators because
 * JavaScript's bitwise operators coerce to 32 bits, which would silently
 * truncate a run longer than 2^32 — and {@link decodeVarints} does not
 * truncate, so the pair would stop round-tripping.
 */
export function encodeVarints(values: readonly number[]): Uint8Array {
  const out: number[] = [];
  for (const value of values) {
    if (!Number.isInteger(value) || value < 0) {
      throw new RangeError(`Varints encode non-negative integers, got ${value}`);
    }
    let remaining = value;
    do {
      const byte = remaining % 0x80;
      remaining = Math.floor(remaining / 0x80);
      out.push(remaining !== 0 ? byte | 0x80 : byte);
    } while (remaining !== 0);
  }
  return Uint8Array.from(out);
}

export function decodeVarints(bytes: Uint8Array): number[] {
  const values: number[] = [];
  let current = 0;
  let shift = 0;
  for (const byte of bytes) {
    if (shift > MAX_VARINT_SHIFT) {
      throw new RangeError('Varint exceeds the safe integer range');
    }
    current += (byte & 0x7f) * Math.pow(2, shift);
    if ((byte & 0x80) === 0) {
      // The shift bound is coarse — the top group can still carry the value
      // past 2^53, where it stops being exact. Check the result itself.
      if (!Number.isSafeInteger(current)) {
        throw new RangeError('Varint exceeds the safe integer range');
      }
      values.push(current);
      current = 0;
      shift = 0;
    } else {
      shift += 7;
    }
  }
  // A trailing continuation bit means the stream was cut short; dropping the
  // partial value silently would turn corruption into a plausible-looking mask.
  if (shift !== 0) throw new RangeError('Varint stream ended mid-value');
  return values;
}

/** Beyond this a varint can no longer be represented exactly as a double. */
const MAX_VARINT_SHIFT = 49;
