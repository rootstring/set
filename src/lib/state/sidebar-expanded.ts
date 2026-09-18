import type { PageId } from "$lib/types";
import { readLocalJson, writeLocalJson } from "$lib/utils/local-store";

/** Per device. Anything that wants a row open before the sidebar mounts writes here. */

const STORAGE_KEY = "set:sidebar:expanded";

export function loadExpanded(): PageId[] {
  const raw = readLocalJson(STORAGE_KEY);
  return Array.isArray(raw) ? raw.filter((x): x is PageId => typeof x === "string") : [];
}

export function saveExpanded(ids: Iterable<PageId>): void {
  writeLocalJson(STORAGE_KEY, [...ids]);
}

export function expand(id: PageId): void {
  const ids = loadExpanded();
  if (!ids.includes(id)) saveExpanded([...ids, id]);
}
