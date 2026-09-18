import { goto, replaceState } from "$app/navigation";
import { navHistory } from "./history.svelte";

/**
 * Through the URL parser, since the browser escapes a little differently from `encodeURIComponent`.
 */
function isCurrent(path: string): boolean {
  if (typeof location === "undefined") return false;
  return new URL(path, location.href).pathname === location.pathname;
}

/** Landing where you already are replaces rather than pushes. */
async function navigate(
  path: string,
  opts: { replace?: boolean; reload?: boolean },
): Promise<void> {
  const replace = (opts.replace ?? false) || isCurrent(path);
  if (!replace) {
    await goto(path, { invalidateAll: opts.reload ?? false });
    return;
  }
  navHistory.willReplace();
  try {
    await goto(path, { replaceState: true, invalidateAll: opts.reload ?? false });
  } finally {
    navHistory.clearReplace();
  }
}

export function goToPage(
  path: string,
  opts: { replace?: boolean; reload?: boolean } = {},
): Promise<void> {
  return navigate(path, opts);
}

/** The context's last page, or its empty state. */
export function goToContext(
  path: string,
  opts: { replace?: boolean } = {},
): Promise<void> {
  return navigate(path, { replace: opts.replace, reload: true });
}

/** Correct the address in place — a renamed page, a renamed context. */
export function canonicalizeUrl(path: string): void {
  if (typeof location === "undefined" || isCurrent(path)) return;
  try {
    replaceState(path, {});
  } catch {
    // the router isn't ready, and the URL here is cosmetic
  }
}
