import type { PageDoc, PageId } from "$lib/types";

export const PAGE_LINK_NODE = "pageLink";

interface DocNode {
  type?: string;
  attrs?: Record<string, unknown>;
  content?: DocNode[];
}

export function stripPageLinks(doc: PageDoc, ids: Set<PageId>): PageDoc | null {
  if (ids.size === 0) return null;
  let changed = false;
  const walk = (nodes: DocNode[]): DocNode[] => {
    const out: DocNode[] = [];
    for (const node of nodes) {
      if (node?.type === PAGE_LINK_NODE && ids.has(node.attrs?.pageId as PageId)) {
        changed = true;
        continue;
      }
      out.push(
        Array.isArray(node?.content) ? { ...node, content: walk(node.content) } : node,
      );
    }
    return out;
  };
  const content = walk((doc.content as DocNode[] | undefined) ?? []);
  return changed ? { ...doc, content } : null;
}

export function hasPageLink(doc: PageDoc, id: PageId): boolean {
  const walk = (nodes: DocNode[]): boolean =>
    nodes.some(
      (node) =>
        (node?.type === PAGE_LINK_NODE && node.attrs?.pageId === id) ||
        (Array.isArray(node?.content) && walk(node.content)),
    );
  return walk((doc.content as DocNode[] | undefined) ?? []);
}

export function remapPageLinks(doc: PageDoc, remap: Map<PageId, PageId>): PageDoc {
  if (remap.size === 0) return doc;
  const walk = (nodes: DocNode[]): DocNode[] =>
    nodes.map((node) => {
      if (node?.type === PAGE_LINK_NODE) {
        const to = remap.get(node.attrs?.pageId as PageId);
        return to ? { ...node, attrs: { ...node.attrs, pageId: to } } : node;
      }
      return Array.isArray(node?.content)
        ? { ...node, content: walk(node.content) }
        : node;
    });
  return { ...doc, content: walk((doc.content as DocNode[] | undefined) ?? []) };
}

export function appendPageLink(doc: PageDoc, id: PageId, title: string): PageDoc {
  return {
    ...doc,
    content: [
      ...(doc.content ?? []),
      { type: PAGE_LINK_NODE, attrs: { pageId: id, title } },
    ],
  };
}
