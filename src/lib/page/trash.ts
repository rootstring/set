import type { TrashEntry } from "$lib/types";

/**
 * Plus every deleted context, which is in no live context and would otherwise have nowhere to be
 * restored from.
 */
export function trashInContext(trash: TrashEntry[], context: string): TrashEntry[] {
  return trash.filter((entry) => entry.kind === "context" || entry.context === context);
}
