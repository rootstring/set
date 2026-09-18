import type { Editor } from "@tiptap/core";
import type { NestedOptions } from "@tiptap/extension-drag-handle";
import type { Node as PMNode } from "@tiptap/pm/model";
import { NodeSelection } from "@tiptap/pm/state";
import { PAGE_LINK_NODE } from "./page-links";
import { COPY_SVG, DUPLICATE_SVG, TRASH_SVG } from "./block-menu";
import { LIST_ITEMS, LISTS } from "./lists";

/** A rule deducts from a base of 1000, and at zero the node is out. */
const EXCLUDE = 1000;

/**
 * Only lists go deeper than the top level: each item gets its own handle. Everything else nested
 * moves with what it sits in.
 */
export const NESTED: NestedOptions = {
  rules: [
    {
      id: "listItemsOnly",
      evaluate: ({ node, depth }) =>
        depth <= 1 || LIST_ITEMS.has(node.type.name) ? 0 : EXCLUDE,
    },
  ],
  // Off: the pointer lives in the left margin (`DragHitArea`), so every candidate reads as near its
  // edge and the deduction would rule out the item under it.
  edgeDetection: "none",
};

const GRIP_SVG =
  '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">' +
  '<circle cx="5.5" cy="4" r="1.1"/><circle cx="10.5" cy="4" r="1.1"/>' +
  '<circle cx="5.5" cy="8" r="1.1"/><circle cx="10.5" cy="8" r="1.1"/>' +
  '<circle cx="5.5" cy="12" r="1.1"/><circle cx="10.5" cy="12" r="1.1"/></svg>';

interface Target {
  pos: number;
  nodeSize: number;
  node: PMNode;
}

interface NodeChange {
  node: PMNode | null;
  editor: Editor;
  pos?: number;
}

export interface DragHandleOptions {
  onDeletePage?: (id: string, anchor: HTMLElement | null) => void;
  onDuplicatePage?: (id: string) => void;
}

export interface DragHandleController {
  render: () => HTMLElement;
  onNodeChange: (change: NodeChange) => void;
  reset: () => void;
}

export function createDragHandle(options: DragHandleOptions = {}): DragHandleController {
  let editor: Editor | null = null;
  let target: Target | null = null;
  let menu: HTMLElement | null = null;
  let handle: HTMLElement | null = null;

  function closeMenu(): void {
    menu?.remove();
    menu = null;
    document.removeEventListener("pointerdown", onDocPointerDown, true);
    document.removeEventListener("keydown", onKeydown, true);
  }

  function onDocPointerDown(event: PointerEvent): void {
    if (menu && !menu.contains(event.target as HTMLElement)) closeMenu();
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      closeMenu();
    }
  }

  function currentTarget(): PMNode | null {
    if (!editor || !target) return null;
    const node = editor.state.doc.nodeAt(target.pos);
    return node?.type === target.node.type ? node : null;
  }

  function copyTarget(): void {
    const current = currentTarget();
    if (editor && target && current) {
      const { state } = editor.view;
      editor.view.dispatch(
        state.tr.setSelection(NodeSelection.create(state.doc, target.pos)),
      );
      editor.view.focus();
      document.execCommand("copy");
    }
    closeMenu();
  }

  function duplicateTarget(): void {
    const current = currentTarget();
    if (editor && target && current) {
      const pageId = current.attrs?.pageId;
      if (
        current.type.name === PAGE_LINK_NODE &&
        typeof pageId === "string" &&
        options.onDuplicatePage
      ) {
        options.onDuplicatePage(pageId);
      } else {
        editor
          .chain()
          .focus()
          .insertContentAt(target.pos + current.nodeSize, current.toJSON())
          .run();
      }
    }
    closeMenu();
  }

  function deleteTarget(): void {
    const current = currentTarget();
    if (editor && target && current) {
      const pageId = current.attrs?.pageId;
      if (current.type.name === PAGE_LINK_NODE && typeof pageId === "string") {
        options.onDeletePage?.(pageId, handle);
      } else {
        // ProseMirror's `deleteRange`, not the editor command: it widens to take an emptied list
        // with the last item.
        const { view } = editor;
        view.dispatch(
          view.state.tr.deleteRange(target.pos, target.pos + current.nodeSize),
        );
        view.focus();
      }
    }
    closeMenu();
  }

  function openMenu(anchor: HTMLElement): void {
    closeMenu();
    if (!target) return;

    const el = document.createElement("div");
    el.className = "block-menu";

    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "block-menu-item";
    copy.innerHTML = `<span class="block-menu-icon">${COPY_SVG}</span><span>Copy</span>`;
    copy.addEventListener("click", copyTarget);
    el.appendChild(copy);

    const dup = document.createElement("button");
    dup.type = "button";
    dup.className = "block-menu-item";
    dup.innerHTML = `<span class="block-menu-icon">${DUPLICATE_SVG}</span><span>Duplicate</span>`;
    dup.addEventListener("click", duplicateTarget);
    el.appendChild(dup);

    const del = document.createElement("button");
    del.type = "button";
    del.className = "block-menu-item danger";
    del.innerHTML = `<span class="block-menu-icon">${TRASH_SVG}</span><span>Delete</span>`;
    del.addEventListener("click", deleteTarget);
    el.appendChild(del);

    document.body.appendChild(el);

    const rect = anchor.getBoundingClientRect();
    const gap = 4;
    const left = rect.left - el.offsetWidth - gap;
    el.style.top = `${rect.top}px`;
    el.style.left = `${left < 8 ? rect.right + gap : left}px`;
    menu = el;

    document.addEventListener("pointerdown", onDocPointerDown, true);
    document.addEventListener("keydown", onKeydown, true);
  }

  function render(): HTMLElement {
    const el = document.createElement("div");

    el.className = "control quiet drag-handle";
    el.setAttribute("aria-hidden", "true");

    el.style.visibility = "hidden";
    el.innerHTML = GRIP_SVG;
    el.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openMenu(el);
    });
    handle = el;
    return el;
  }

  function reset(): void {
    closeMenu();
    editor = null;
    target = null;

    if (handle) handle.style.visibility = "hidden";
  }

  /**
   * Down by half the height difference so a heading or list item does not ride high. Out to the
   * left edge of the top-level block, so it clears list markers.
   */
  function place(): void {
    if (!handle) return;

    const dom = editor && target ? editor.view.nodeDOM(target.pos) : null;
    const box = dom instanceof HTMLElement ? dom : null;
    const name = target?.node.type.name ?? "";
    const item = LIST_ITEMS.has(name);

    let shift = 0;
    if (box && (item || name === "heading")) {
      const line = parseFloat(getComputedStyle(box).lineHeight);
      if (Number.isFinite(line)) shift = Math.max(0, (line - handle.offsetHeight) / 2);
    }

    let gutter = 0;
    if (box && item && editor) {
      let outer: HTMLElement = box;
      while (outer.parentElement && outer.parentElement !== editor.view.dom) {
        outer = outer.parentElement;
      }
      gutter = Math.max(
        0,
        box.getBoundingClientRect().left - outer.getBoundingClientRect().left,
      );
    }

    handle.style.setProperty("--drag-handle-shift", `${shift}px`);
    handle.style.setProperty("--drag-handle-gutter", `${gutter}px`);
  }

  function onNodeChange(change: NodeChange): void {
    if (menu) return;
    editor = change.editor;

    const next =
      change.node && typeof change.pos === "number" && change.pos >= 0
        ? { pos: change.pos, nodeSize: change.node.nodeSize, node: change.node }
        : null;

    // A list is never a hover target (`NESTED` picks its items); one named here means the extension
    // re-read the top-level block after a document change. Taking it would turn a todo's handle
    // into the whole list's. `DragHitArea` re-asks from the pointer a frame later.
    if (next && LISTS.has(next.node.type.name)) {
      target = null;
      return;
    }

    target = next;
    place();
  }

  return { render, onNodeChange, reset };
}
