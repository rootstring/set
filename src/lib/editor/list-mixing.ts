import { Extension, InputRule } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

function continuationAttrs(list: ProseMirrorNode, index: number) {
  if (list.type.name !== "orderedList") return list.attrs;
  const start = typeof list.attrs.start === "number" ? list.attrs.start : 1;
  return { ...list.attrs, start: start + index };
}

interface Swap {
  from: string;
  toList: string;
  toItem: string;
}

function conversionRule(find: RegExp, swap: Swap) {
  return new InputRule({
    find,
    handler: ({ state, range }) => {
      const tr = state.tr;
      const $from = state.doc.resolve(range.from);

      const itemDepth = $from.depth - 1;
      if (itemDepth < 1) return null;
      const item = $from.node(itemDepth);
      if (item.type.name !== swap.from) return null;

      if (item.childCount !== 1 || !$from.parent.isTextblock) return null;

      if ($from.parent.content.size > range.to - range.from) return null;

      const listDepth = itemDepth - 1;
      const list = $from.node(listDepth);
      const index = $from.index(listDepth);

      const listType = state.schema.nodes[swap.toList];
      const itemType = state.schema.nodes[swap.toItem];
      if (!listType || !itemType) return null;

      const converted = listType.createAndFill(null, itemType.createAndFill());
      if (!converted) return null;

      const above: ProseMirrorNode[] = [];
      const below: ProseMirrorNode[] = [];
      list.forEach((child, _offset, i) => {
        if (i < index) above.push(child);
        else if (i > index) below.push(child);
      });

      const pieces: ProseMirrorNode[] = [];
      if (above.length) pieces.push(list.type.create(list.attrs, above));
      pieces.push(converted);
      if (below.length) {
        pieces.push(list.type.create(continuationAttrs(list, index), below));
      }

      const listStart = $from.before(listDepth);
      const listEnd = $from.after(listDepth);

      const convertedAt = listStart + (above.length ? pieces[0].nodeSize : 0);
      tr.replaceWith(listStart, listEnd, pieces);

      tr.setSelection(TextSelection.near(tr.doc.resolve(convertedAt + 1), 1));
      return undefined;
    },
  });
}

export const ListMixing = Extension.create({
  name: "listMixing",
  addInputRules() {
    return [
      conversionRule(/^([-+*])\s$/, {
        from: "taskItem",
        toList: "bulletList",
        toItem: "listItem",
      }),
      conversionRule(/^\[([ xX]?)\]\s$/, {
        from: "listItem",
        toList: "taskList",
        toItem: "taskItem",
      }),
    ];
  },
});
