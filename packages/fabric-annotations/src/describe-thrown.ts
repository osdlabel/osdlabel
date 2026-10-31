/**
 * A thrown value as text, without ever throwing itself. A host's strategy or
 * codec may throw anything: `Object.create(null)`, which `String()` cannot
 * convert; an `Error` whose `message` is not a string or whose getter throws;
 * a revoked `Proxy`, on which even `instanceof` throws. Formatting the cause
 * must not turn a refusal back into an escaping error. Off the barrel.
 */
export function describeThrown(thrown: unknown): string {
  try {
    if (thrown instanceof Error) {
      const message: unknown = thrown.message;
      return typeof message === 'string' ? message : 'an Error with no message';
    }
    if (thrown === undefined) return 'undefined';
    return String(thrown);
  } catch {
    return 'a value with no string form';
  }
}
