import type { Editor } from "@tiptap/core";
import type { Fragment, Node as PMNode } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import type { PageId } from "$lib/types";
import { PAGE_LINK_NODE } from "./page-links";
import { LISTS } from "./lists";

/**
 * A block carries its subpage links and image references with it, or a subpage is filed under a
 * page that no longer shows it.
 */

/** A node of a ProseMirror document as it is stored — `PageDoc`'s shape. */
export interface BlockNode {
  type?: string;
  attrs?: Record<string, unknown>;
  content?: BlockNode[];
  text?: string;
}

function walk(node: BlockNode, visit: (node: BlockNode) => void): void {
  visit(node);
  for (const child of node.content ?? []) walk(child, visit);
}

/** Every subpage the block links to, outermost first. */
export function pageLinkIdsIn(node: BlockNode): PageId[] {
  const ids: PageId[] = [];
  walk(node, (n) => {
    if (n.type !== PAGE_LINK_NODE) return;
    const id = n.attrs?.pageId;
    if (typeof id === "string" && !ids.includes(id)) ids.push(id);
  });
  return ids;
}

/** Every image reference the block shows. */
export function assetRefsIn(node: BlockNode): string[] {
  const refs: string[] = [];
  walk(node, (n) => {
    if (n.type !== "image" && n.type !== "inlineImage") return;
    const src = n.attrs?.src;
    if (typeof src === "string" && src && !refs.includes(src)) refs.push(src);
  });
  return refs;
}

/** A reference the map does not mention is left alone. */
export function withAssetRefs(node: BlockNode, refs: Map<string, string>): BlockNode {
  if (refs.size === 0) return node;
  const rewrite = (n: BlockNode): BlockNode => {
    const src = n.type === "image" || n.type === "inlineImage" ? n.attrs?.src : undefined;
    const next = typeof src === "string" ? refs.get(src) : undefined;
    return {
      ...n,
      ...(next ? { attrs: { ...n.attrs, src: next } } : {}),
      ...(n.content ? { content: n.content.map(rewrite) } : {}),
    };
  };
  return rewrite(node);
}

/**
 * `into` names the destination when the gesture chose one; `anchor` is where the asking panel
 * opens.
 */
export type MoveBlockRequest = (
  blocks: BlockNode[],
  remove: () => void,
  into?: PageId,
  anchor?: DOMRect | null,
) => void;

/** Hand the block at `pos` to whoever knows about pages — see `requestRangeMove`. */
export function requestBlockMove(
  editor: Editor,
  pos: number,
  ask: MoveBlockRequest,
): void {
  const node = editor.state.doc.nodeAt(pos);
  if (node) requestRangeMove(editor, pos, pos + node.nodeSize, ask);
}

/**
 * Removal runs later and finds the blocks again rather than trusting positions. It stays out of
 * undo: bringing them back would make two.
 */
export function requestRangeMove(
  editor: Editor,
  from: number,
  to: number,
  ask: MoveBlockRequest,
): void {
  const { doc } = editor.state;
  const $from = doc.resolve(from);
  if (!$from.sameParent(doc.resolve(to)) || $from.parent.inlineContent) return;
  const snapshot = doc.slice(from, to).content;
  if (snapshot.childCount === 0) return;

  const anchor = blockRect(editor, from);

  ask(
    forTransport($from.parent, snapshot).map((n) => n.toJSON() as BlockNode),
    () => {
      if (editor.isDestroyed) return;
      const { view } = editor;
      const at = findRange(view.state.doc, from, snapshot);
      if (at === null) return;

      // `deleteRange`, so an emptied list goes with its items.
      const tr = view.state.tr.deleteRange(at, at + snapshot.size);
      // Not the mapped range: a selection spanning the hole would be picked up whole next drag.
      tr.setSelection(
        TextSelection.near(tr.doc.resolve(Math.min(at, tr.doc.content.size))),
      );
      view.dispatch(tr.setMeta("addToHistory", false));
    },
    undefined,
    anchor,
  );
}

/**
 * List items travel in a list of their own made from the one they leave, or the paste would drop
 * them.
 */
function forTransport(parent: PMNode, blocks: Fragment): PMNode[] {
  if (LISTS.has(parent.type.name)) return [parent.copy(blocks)];
  const out: PMNode[] = [];
  blocks.forEach((block) => out.push(block));
  return out;
}

/** A node view's block may not be an element; null reads as "centre it". */
function blockRect(editor: Editor, pos: number): DOMRect | null {
  const dom = editor.view.nodeDOM(pos);
  if (dom instanceof HTMLElement && dom.isConnected) {
    const box = dom.getBoundingClientRect();
    if (box.width > 0 || box.height > 0) return box;
  }
  try {
    const at = editor.view.coordsAtPos(pos);
    return new DOMRect(at.left, at.top, 0, Math.max(1, at.bottom - at.top));
  } catch {
    return null;
  }
}

/**
 * Where `blocks` now start: at `pos` if still there, else the first run of siblings matching them.
 */
function findRange(doc: PMNode, pos: number, blocks: Fragment): number | null {
  if (holdsAt(doc, pos, blocks)) return pos;

  const runIn = (parent: PMNode, start: number): number | null => {
    let at = start;
    for (let i = 0; i + blocks.childCount <= parent.childCount; i++) {
      if (holdsAt(doc, at, blocks)) return at;
      at += parent.child(i).nodeSize;
    }
    return null;
  };

  let found = runIn(doc, 0);
  if (found !== null) return found;
  doc.descendants((node, at) => {
    if (found !== null) return false;
    if (!node.isTextblock) found = runIn(node, at + 1);
    return found === null;
  });
  return found;
}

function holdsAt(doc: PMNode, pos: number, blocks: Fragment): boolean {
  const end = pos + blocks.size;
  if (pos < 0 || end > doc.content.size) return false;
  const $pos = doc.resolve(pos);
  if (!$pos.sameParent(doc.resolve(end))) return false;
  return doc.slice(pos, end).content.eq(blocks);
}
