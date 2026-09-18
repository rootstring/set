import { Extension } from "@tiptap/core";
import type { Node as PMNode, ResolvedPos } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { LISTS } from "./lists";

const DRAGGING_CLASS = "dragging-block";

/** On the editor's wrapper while the pointer is nowhere near the handle's column. */
const AWAY_CLASS = "away-from-handle";

/**
 * Out into the margin and in over the first word or two; elsewhere the handle tracks the block but
 * stays hidden.
 */
const NEAR = { out: 64, in: 36 };

/** The left edge of the text column: where the first block with a box begins. */
function columnLeft(view: EditorView): number {
  for (let el = view.dom.firstElementChild; el; el = el.nextElementSibling) {
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return rect.left;
  }
  return view.dom.getBoundingClientRect().left;
}

/** A node's DOM box, if it has one on screen. */
function rectOf(view: EditorView, pos: number): DOMRect | null {
  const dom = view.nodeDOM(pos);
  return dom instanceof HTMLElement ? dom.getBoundingClientRect() : null;
}

interface Child {
  node: PMNode;
  pos: number;
}

/** How far a row `y` is from a box: nothing when it runs through it. */
function away(rect: DOMRect, y: number): number {
  return y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
}

/** Of these, the one on the row `y` runs through, or the nearest to it. */
function nearest(view: EditorView, children: Child[], y: number): Child | null {
  let best: { child: Child; away: number } | null = null;
  for (const child of children) {
    const rect = rectOf(view, child.pos);
    if (!rect) continue;
    const gap = away(rect, y);
    if (!best || gap < best.away) best = { child, away: gap };
  }
  return best?.child ?? null;
}

/** The two nodes either side of a position. */
function beside($pos: ResolvedPos): Child[] {
  const out: Child[] = [];
  if ($pos.nodeBefore)
    out.push({ node: $pos.nodeBefore, pos: $pos.pos - $pos.nodeBefore.nodeSize });
  if ($pos.nodeAfter) out.push({ node: $pos.nodeAfter, pos: $pos.pos });
  return out;
}

/** Every child of `parent`, which starts at `start`. */
function childrenOf(parent: PMNode, start: number): Child[] {
  const out: Child[] = [];
  let pos = start;
  parent.forEach((node) => {
    out.push({ node, pos });
    pos += node.nodeSize;
  });
  return out;
}

/**
 * A pointer in a list's gutter resolves between items, and the extension only looks upward from
 * there, where the list is ruled out. This finds the item on that row and gives back an x inside
 * its text. Null when no correction is needed.
 */
export function intoListItem(view: EditorView, x: number, y: number): number | null {
  // Into the text column first, the way the extension will.
  const first = view.dom.firstElementChild?.getBoundingClientRect();
  const left = first ? Math.max(x, first.left + 5) : x;

  const found = view.posAtCoords({ left, top: y });
  if (!found) return null;
  const $pos = view.state.doc.resolve(found.pos);
  if (!LISTS.has($pos.parent.type.name)) return null;

  let item = nearest(view, beside($pos), y);
  for (let depth = 0; item && depth < 16; depth += 1) {
    // Inside the item: its first line, or a list of its own further down.
    const part = nearest(view, childrenOf(item.node, item.pos + 1), y);
    if (!part) return null;
    if (!LISTS.has(part.node.type.name)) {
      const rect = rectOf(view, part.pos);
      return rect ? rect.left + 1 : null;
    }
    item = nearest(view, childrenOf(part.node, part.pos + 1), y);
  }
  return null;
}

export const DragHitArea = Extension.create({
  name: "dragHitArea",
  priority: 200,
  addProseMirrorPlugins() {
    /** Set while a corrected mousemove is on its way through, so it isn't corrected again. */
    let redirecting = false;

    const send = (view: EditorView, x: number, y: number): void => {
      view.dom.dispatchEvent(
        new MouseEvent("mousemove", {
          clientX: x,
          clientY: y,
          bubbles: true,
        }),
      );
    };

    return [
      new Plugin({
        key: new PluginKey("dragHitArea"),
        view(view) {
          const wrapper = view.dom.parentElement;

          /** Where the pointer last was, in the editor's own terms. */
          let at: { x: number; y: number } | null = null;

          const clampX = (x: number): number => {
            const rect = view.dom.getBoundingClientRect();
            return Math.min(Math.max(x, rect.left + 1), rect.right - 1);
          };

          const nudge = (): void => {
            if (!at) return;
            send(view, at.x, at.y);
          };

          /** Not while a drag is on, nor while the handle's menu is open. */
          const gate = (x: number): void => {
            if (!wrapper || wrapper.classList.contains(DRAGGING_CLASS)) return;
            if (document.querySelector(".block-menu")) return;
            const col = columnLeft(view);
            const near = x >= col - NEAR.out && x <= col + NEAR.in;
            wrapper.classList.toggle(AWAY_CLASS, !near);
          };

          const onMouseMove = (event: MouseEvent) => {
            at = { x: clampX(event.clientX), y: event.clientY };
            gate(event.clientX);
            if (view.dom.contains(event.target as Node)) return;
            nudge();
          };

          const onMouseLeave = () => (at = null);

          const startDrag = () => wrapper?.classList.add(DRAGGING_CLASS);
          const endDrag = () => wrapper?.classList.remove(DRAGGING_CLASS);

          // Bubbled, so it sees the handle beside the editor too.
          wrapper?.addEventListener("mousemove", onMouseMove);
          wrapper?.addEventListener("mouseleave", onMouseLeave);
          document.addEventListener("dragstart", startDrag, true);
          document.addEventListener("dragend", endDrag, true);

          return {
            /**
             * On a document change the extension re-reads the top-level block, which for a list is
             * the whole list; ask again from the pointer's position.
             */
            update(_view, prev) {
              if (view.state.doc.eq(prev.doc)) return;
              if (wrapper?.classList.contains(DRAGGING_CLASS)) return;
              nudge();
            },
            destroy() {
              wrapper?.removeEventListener("mousemove", onMouseMove);
              wrapper?.removeEventListener("mouseleave", onMouseLeave);
              document.removeEventListener("dragstart", startDrag, true);
              document.removeEventListener("dragend", endDrag, true);
              endDrag();
              wrapper?.classList.remove(AWAY_CLASS);
            },
          };
        },
        props: {
          handleDOMEvents: {
            /**
             * Ahead of the drag handle's handler: a hover between list items is re-sent from inside
             * the item on that row.
             */
            mousemove: (view, event) => {
              if (redirecting) return false;
              const x = intoListItem(view, event.clientX, event.clientY);
              if (x === null) return false;
              redirecting = true;
              try {
                send(view, x, event.clientY);
              } finally {
                redirecting = false;
              }
              return true;
            },
            mouseleave: (view, event) => {
              const to = (event as MouseEvent).relatedTarget as Node | null;
              return !!to && !!view.dom.parentElement?.contains(to);
            },
          },
        },
      }),
    ];
  },
});
