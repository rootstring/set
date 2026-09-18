import { confirms } from "$lib/state/confirm.svelte";

/** One wording for every surface that refuses because a page is locked. */
export const PAGE_LOCKED = "Page is locked";

/** Toast id: these refusals replace each other rather than stack up. */
export const LOCK_TOAST = "blocked-by-lock";

/** Every surface that offers to unlock asks the same way. */
export function askUnlock(anchor: HTMLElement | null, onConfirm: () => void): void {
  confirms.ask({
    anchor,
    title: "Unlock page",
    message: "The page can be edited again.",
    confirmLabel: "Unlock",
    danger: false,
    remember: false,
    permanent: false,
    onConfirm,
  });
}
