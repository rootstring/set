import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

const todoRollupKey = new PluginKey<DecorationSet>("todoRollup");

function childItems(item: ProseMirrorNode): ProseMirrorNode[] {
  const out: ProseMirrorNode[] = [];
  item.forEach((child) => {
    if (child.type.name !== "taskList") return;
    child.forEach((grandchild) => {
      if (grandchild.type.name === "taskItem") out.push(grandchild);
    });
  });
  return out;
}

function hasCheckedDescendant(item: ProseMirrorNode): boolean {
  let found = false;
  item.descendants((node) => {
    if (found) return false;
    if (node.type.name === "taskItem" && node.attrs.checked) {
      found = true;
      return false;
    }
    return true;
  });
  return found;
}

function buildDecorations(doc: ProseMirrorNode): DecorationSet {
  const decorations: Decoration[] = [];

  doc.descendants((node, pos) => {
    if (node.type.name !== "taskItem") return true;

    const children = childItems(node);

    if (children.length === 0) return true;

    const total = children.length;
    const done = children.filter((child) => child.attrs.checked).length;

    const progress =
      done === total
        ? "all"
        : done > 0 || hasCheckedDescendant(node)
          ? "partial"
          : "none";

    decorations.push(
      Decoration.node(pos, pos + node.nodeSize, {
        "data-done": String(done),
        "data-total": String(total),
        "data-progress": progress,
      }),
    );

    const first = node.firstChild;
    if (first && first.isTextblock) {
      const endOfFirstLine = pos + 1 + first.nodeSize - 1;
      decorations.push(
        Decoration.widget(
          endOfFirstLine,
          () => {
            const el = document.createElement("span");
            el.className = "task-count";
            el.textContent = `${done}/${total}`;

            el.contentEditable = "false";
            el.setAttribute("aria-label", `${done} of ${total} done`);
            return el;
          },
          { side: 1, ignoreSelection: true, key: `todo-count-${done}-${total}` },
        ),
      );
    }

    return true;
  });

  return DecorationSet.create(doc, decorations);
}

export const TodoRollup = Extension.create({
  name: "todoRollup",
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: todoRollupKey,
        state: {
          init: (_, { doc }) => buildDecorations(doc),
          apply: (tr, value) => (tr.docChanged ? buildDecorations(tr.doc) : value),
        },
        props: {
          decorations(state) {
            return todoRollupKey.getState(state);
          },
        },
      }),
    ];
  },
});
