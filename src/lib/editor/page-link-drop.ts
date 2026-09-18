import type { Editor } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { pageLinkIdsIn, requestRangeMove, type MoveBlockRequest } from "./block-move";
import type { BlockNode } from "./block-move";

/**
 * Dropping whole blocks onto a child-page block files them inside that page, via the same move as
 * "Move to page…". Text selections and copy drags (⌥) land beside the link.
 */

const DROP_INTO = "drop-into";

/** On the editor's wrapper while a drop-into is offered — see `editor.css`. */
const DROPPING = "dropping-into-page";

interface Range {
  from: number;
  to: number;
}

/**
 * From the selection the drag handle set; a dragged text selection cuts through paragraphs and
 * matches neither.
 */
function draggedRange(view: EditorView): Range | null {
  const dragging = view.dragging;
  if (!dragging?.move) return null;

  const { doc, selection } = view.state;
  const { from, to } = selection;
  if (from >= to) return null;
  const $from = doc.resolve(from);
  if (!$from.sameParent(doc.resolve(to)) || $from.parent.inlineContent) return null;

  const range = doc.slice(from, to);
  const closed = doc.slice(from, to, true);
  return dragging.slice.eq(range) || dragging.slice.eq(closed) ? { from, to } : null;
}

function pageLinkUnder(event: DragEvent): HTMLElement | null {
  const target = event.target;
  if (!(target instanceof Element)) return null;
  return target.closest<HTMLElement>("[data-page-link]");
}

/** The page a drop here would file the block into, or null if it wouldn't. */
function destinationOf(view: EditorView, el: HTMLElement): string | null {
  const id = el.getAttribute("data-page-id");
  const range = draggedRange(view);
  if (!id || range === null) return null;

  // Not into a page the blocks themselves carry. The workspace checks again against the whole tree.
  const carried = view.state.doc
    .slice(range.from, range.to)
    .content.toJSON() as BlockNode[];
  return carried.some((block) => pageLinkIdsIn(block).includes(id)) ? null : id;
}

function paint(view: EditorView, el: HTMLElement | null): void {
  const wrapper = view.dom.parentElement;
  for (const lit of view.dom.querySelectorAll(`.${DROP_INTO}`)) {
    if (lit !== el) lit.classList.remove(DROP_INTO);
  }
  el?.classList.add(DROP_INTO);
  wrapper?.classList.toggle(DROPPING, el !== null);
}

export function pageLinkDrop(editor: Editor, ask: () => MoveBlockRequest | undefined) {
  return new Plugin({
    key: new PluginKey("pageLinkDrop"),

    // Only `dragend` is certain to arrive.
    view(view) {
      const clear = () => paint(view, null);
      document.addEventListener("dragend", clear, true);
      document.addEventListener("drop", clear, true);
      return {
        destroy() {
          document.removeEventListener("dragend", clear, true);
          document.removeEventListener("drop", clear, true);
          clear();
        },
      };
    },

    props: {
      handleDOMEvents: {
        dragover: (view, event) => {
          const el = pageLinkUnder(event);
          const into = el && destinationOf(view, el) ? el : null;
          paint(view, into);
          if (into && event.dataTransfer) event.dataTransfer.dropEffect = "move";
          // Not handled: what the block lands in is decided at the drop.
          return false;
        },
      },

      handleDrop: (view, event, _slice, moved) => {
        paint(view, null);
        const el = pageLinkUnder(event);
        const target = el && moved ? destinationOf(view, el) : null;
        const range = target === null ? null : draggedRange(view);
        const request = ask();
        if (target === null || range === null || !request) return false;

        // Returning true leaves the source for `requestRangeMove` to take out once the page has it.
        requestRangeMove(editor, range.from, range.to, (blocks, remove) =>
          request(blocks, remove, target),
        );
        return true;
      },
    },
  });
}
