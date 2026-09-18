import type { PageId } from "$lib/types";

export interface TreeNode {
  id: PageId;
  parentId: PageId | null;
}

export function childrenByParent<T extends TreeNode>(
  pages: T[],
): Map<PageId | null, T[]> {
  const map = new Map<PageId | null, T[]>();
  for (const page of pages) {
    const siblings = map.get(page.parentId);
    if (siblings) siblings.push(page);
    else map.set(page.parentId, [page]);
  }
  return map;
}

export function parentsById(pages: TreeNode[]): Map<PageId, PageId | null> {
  return new Map(pages.map((p) => [p.id, p.parentId]));
}

/** `rootId` and every page beneath it. */
export function subtreeIds(pages: TreeNode[], rootId: PageId): Set<PageId> {
  const children = childrenByParent(pages);
  const ids = new Set<PageId>();
  const queue: PageId[] = [rootId];
  while (queue.length) {
    const id = queue.pop()!;
    if (ids.has(id)) continue;
    ids.add(id);
    for (const child of children.get(id) ?? []) queue.push(child.id);
  }
  return ids;
}

/** Guards against a parent cycle, which hand-edited files can produce. */
export function ancestorIds(
  id: PageId,
  parents: Map<PageId, PageId | null>,
  stopAt: PageId | null = null,
): PageId[] {
  const out: PageId[] = [];
  const seen = new Set<PageId>([id]);
  let cur = parents.get(id) ?? null;
  while (cur && cur !== stopAt && !seen.has(cur)) {
    seen.add(cur);
    out.push(cur);
    cur = parents.get(cur) ?? null;
  }
  return out;
}

/**
 * Inside a chroot the trail starts at `rootId`; a page opened from outside keeps its whole trail.
 */
export function trailTo<T extends TreeNode>(
  id: PageId,
  pages: T[],
  rootId: PageId | null = null,
): T[] {
  if (id === rootId) return [];
  const byId = new Map(pages.map((p) => [p.id, p]));
  const ids = ancestorIds(id, parentsById(pages));
  const cut = rootId ? ids.indexOf(rootId) : -1;
  return (cut === -1 ? ids : ids.slice(0, cut + 1))
    .reverse()
    .flatMap((ancestor) => byId.get(ancestor) ?? []);
}

export interface OrderedNode {
  order?: number | undefined;
  createdAt: number;
}

/** Siblings sort by their dragged position, falling back to creation order. */
export function bySiblingOrder(a: OrderedNode, b: OrderedNode): number {
  return (a.order ?? a.createdAt) - (b.order ?? b.createdAt);
}

export function isSelfOrDescendant(
  id: PageId,
  ancestorId: PageId,
  parents: Map<PageId, PageId | null>,
): boolean {
  return id === ancestorId || ancestorIds(id, parents).includes(ancestorId);
}
