/**
 * Guarded: missing during SSR, and throws in a private window. A read that cannot happen reads as
 * absent.
 */

export function readLocal(key: string): string | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function readLocalJson(key: string): unknown {
  const raw = readLocal(key);
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export function writeLocalJson(key: string, value: unknown): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // dropped: see above
  }
}
