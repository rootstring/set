import { Extension } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";

export const ListBackspace = Extension.create({
  name: "listBackspace",
  priority: 1000,
  addKeyboardShortcuts() {
    return {
      Backspace: () => {
        const { state } = this.editor;
        const { $from, empty } = state.selection;

        if (!empty || $from.parentOffset !== 0) return false;
        if (!$from.parent.isTextblock || $from.parent.content.size !== 0) return false;

        const liDepth = $from.depth - 1;
        if (liDepth < 1) return false;
        const li = $from.node(liDepth);
        const liName = li.type.name;
        if (liName !== "listItem" && liName !== "taskItem") return false;

        if (li.childCount !== 1) return false;

        const listDepth = liDepth - 1;
        if (listDepth < 0) return false;
        const list = $from.node(listDepth);
        const index = $from.index(listDepth);

        if (list.childCount === 1) return false;

        const liStart = $from.before(liDepth);
        const liEnd = $from.after(liDepth);

        return this.editor.commands.command(({ tr, dispatch }) => {
          if (!dispatch) return true;
          tr.delete(liStart, liEnd);

          const bias = index > 0 ? -1 : 1;
          tr.setSelection(TextSelection.near(tr.doc.resolve(liStart), bias));
          return true;
        });
      },
    };
  },
});
