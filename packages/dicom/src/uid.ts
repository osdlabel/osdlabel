/**
 * A new DICOM UID under the `2.25` root (PS3.5 B.2): the decimal form of a
 * random UUID. Needs no registered org root, which is what a library emitting
 * DICOM on behalf of arbitrary hosts wants.
 */
export function createUid(): string {
  const hex = crypto.randomUUID().replace(/-/g, '');
  return `2.25.${BigInt(`0x${hex}`).toString()}`;
}

/** DICOM DA (YYYYMMDD) and TM (HHMMSS.ffffff) for a date, in UTC. */
export function dicomDateTime(d: Date = new Date()): {
  readonly date: string;
  readonly time: string;
} {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return {
    date: `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`,
    time: `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}.${p(d.getUTCMilliseconds(), 3)}000`,
  };
}
