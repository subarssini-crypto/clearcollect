/**
 * In-memory sliding-window limiter, keyed by an arbitrary string (an email
 * address, or "*" for a global budget). Process-local: it resets on restart
 * and is not shared between server instances, which suits this single-server
 * demo. Keys are never client-chosen IPs (X-Forwarded-For is spoofable).
 */

const MAX_KEYS = 10_000;

export interface Limiter {
  /** Seconds until `key` may try again, or 0. */
  retryAfter(key: string, now?: number): number;
  record(key: string, now?: number): void;
  reset(key?: string): void;
}

export function createLimiter({ max, windowMs }: { max: number; windowMs: number }): Limiter {
  const hits = new Map<string, number[]>();

  function recent(key: string, now: number): number[] {
    const list = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (list.length) hits.set(key, list);
    else hits.delete(key);
    return list;
  }

  return {
    retryAfter(key, now = Date.now()) {
      const list = recent(key, now);
      if (list.length < max) return 0;
      return Math.max(1, Math.ceil((list[0] + windowMs - now) / 1000));
    },
    record(key, now = Date.now()) {
      if (!hits.has(key) && hits.size >= MAX_KEYS) {
        // Drop the oldest key so memory stays bounded.
        const oldest = hits.keys().next().value;
        if (oldest !== undefined) hits.delete(oldest);
      }
      hits.set(key, [...recent(key, now), now]);
    },
    reset(key) {
      if (key === undefined) hits.clear();
      else hits.delete(key);
    },
  };
}
