// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { Editor, type JSONContent } from "@tiptap/core";
import { createExtensions } from "./extensions";
import { requestBlockMove, requestRangeMove, type BlockNode } from "./block-move";
import { LIST_ITEMS } from "./lists";

/** What leaves a list has to arrive somewhere a list item is allowed, with its own nesting only. */

function editorWith(doc: JSONContent): Editor {
  return new Editor({
    extensions: createExtensions({ interactive: false }),
    content: doc,
  });
}

const item = (text: string, extra: JSONContent[] = []) => ({
  type: "listItem",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }, ...extra],
});

const todo = (text: string, checked = false, extra: JSONContent[] = []) => ({
  type: "taskItem",
  attrs: { checked },
  content: [{ type: "paragraph", content: [{ type: "text", text }] }, ...extra],
});

/** Where the item whose first line reads `text` begins. */
function posOf(editor: Editor, text: string): number {
  let found = -1;
  editor.state.doc.descendants((node, pos) => {
    if (found >= 0) return false;
    if (LIST_ITEMS.has(node.type.name) && node.firstChild?.textContent === text) {
      found = pos;
    }
    return found < 0;
  });
  if (found < 0) throw new Error(`no list item reads "${text}"`);
  return found;
}

/** What `Move to page` would hand over for the block at `pos`, and the undo. */
function moved(editor: Editor, pos: number): { block: BlockNode; remove: () => void } {
  let captured: { block: BlockNode; remove: () => void } | null = null;
  requestBlockMove(editor, pos, (blocks, remove) => {
    expect(blocks).toHaveLength(1);
    captured = { block: blocks[0], remove };
  });
  if (!captured) throw new Error("nothing was offered for the move");
  return captured;
}

/** What a drop of the blocks between `from` and `to` would hand over. */
function movedRange(
  editor: Editor,
  from: number,
  to: number,
): { blocks: BlockNode[]; remove: () => void } {
  let captured: { blocks: BlockNode[]; remove: () => void } | null = null;
  requestRangeMove(editor, from, to, (blocks, remove) => (captured = { blocks, remove }));
  if (!captured) throw new Error("nothing was offered for the move");
  return captured;
}

const text = (node: BlockNode): string =>
  (node.text ?? "") + (node.content ?? []).map(text).join("");

describe("a list item filed on another page", () => {
  it("travels inside a list of its own, which is the only place it can land", () => {
    const editor = editorWith({
      type: "doc",
      content: [{ type: "bulletList", content: [item("one"), item("two")] }],
    });

    const { block } = moved(editor, posOf(editor, "two"));

    expect(block.type).toBe("bulletList");
    expect(block.content).toHaveLength(1);
    expect(block.content?.[0].type).toBe("listItem");
    expect(text(block)).toBe("two");
    editor.destroy();
  });

  it("keeps the kind of list it came out of, so a todo lands as a todo", () => {
    const editor = editorWith({
      type: "doc",
      content: [{ type: "taskList", content: [todo("ship it", true)] }],
    });

    const { block } = moved(editor, posOf(editor, "ship it"));

    expect(block.type).toBe("taskList");
    expect(block.content?.[0].type).toBe("taskItem");
    expect(block.content?.[0].attrs?.checked).toBe(true);
    editor.destroy();
  });

  it("carries the whole document it makes, not the page it left", () => {
    const editor = editorWith({
      type: "doc",
      content: [{ type: "bulletList", content: [item("one"), item("two")] }],
    });

    const { block } = moved(editor, posOf(editor, "two"));
    const landed = editor.state.schema.nodeFromJSON({
      type: "doc",
      content: [block],
    });

    expect(() => landed.check()).not.toThrow();
    expect(landed.textContent).toBe("two");
    editor.destroy();
  });

  it("takes everything nested under it and none of its siblings", () => {
    const editor = editorWith({
      type: "doc",
      content: [
        {
          type: "taskList",
          content: [
            todo("parent", false, [
              { type: "taskList", content: [todo("child"), todo("other child")] },
            ]),
            todo("sibling"),
          ],
        },
      ],
    });

    const { block } = moved(editor, posOf(editor, "parent"));

    expect(text(block)).toBe("parentchildother child");
    expect(text(block)).not.toContain("sibling");
    editor.destroy();
  });

  it("leaves a child where it is when the child is the one moving", () => {
    const editor = editorWith({
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [item("parent", [{ type: "bulletList", content: [item("child")] }])],
        },
      ],
    });

    const { block, remove } = moved(editor, posOf(editor, "child"));
    expect(text(block)).toBe("child");

    remove();
    expect(editor.state.doc.textContent).toBe("parent");
    editor.destroy();
  });

  it("takes the emptied list with the last item off it", () => {
    const editor = editorWith({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "before" }] },
        { type: "bulletList", content: [item("only")] },
        { type: "paragraph", content: [{ type: "text", text: "after" }] },
      ],
    });

    moved(editor, posOf(editor, "only")).remove();

    const kinds: string[] = [];
    editor.state.doc.forEach((node) => kinds.push(node.type.name));
    expect(kinds).toEqual(["paragraph", "paragraph"]);
    expect(() => editor.state.doc.check()).not.toThrow();
    editor.destroy();
  });

  it("still travels as itself when it isn't a list item at all", () => {
    const editor = editorWith({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "plain" }] }],
    });

    const { block } = moved(editor, 0);
    expect(block.type).toBe("paragraph");
    editor.destroy();
  });
});

describe("several blocks filed on another page", () => {
  const para = (t: string) => ({
    type: "paragraph",
    content: [{ type: "text", text: t }],
  });

  it("travel as themselves, in order, and leave together", () => {
    const editor = editorWith({
      type: "doc",
      content: [para("keep"), para("one"), para("two"), para("stay")],
    });
    const { doc } = editor.state;
    const from = doc.child(0).nodeSize;
    const to = from + doc.child(1).nodeSize + doc.child(2).nodeSize;

    const { blocks, remove } = movedRange(editor, from, to);
    expect(blocks.map(text)).toEqual(["one", "two"]);

    // The page moved on while the destination was being written.
    editor.commands.insertContentAt(0, para("new"));
    remove();
    const left: string[] = [];
    editor.state.doc.forEach((n) => left.push(n.textContent));
    expect(left).toEqual(["new", "keep", "stay"]);
    editor.destroy();
  });

  it("list items travel inside one list of their kind", () => {
    const editor = editorWith({
      type: "doc",
      content: [{ type: "taskList", content: [todo("a"), todo("b"), todo("c")] }],
    });
    const from = posOf(editor, "a");
    const to = posOf(editor, "c");

    const { blocks } = movedRange(editor, from, to);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("taskList");
    expect(blocks[0].content?.map(text)).toEqual(["a", "b"]);
    editor.destroy();
  });

  it("offers nothing for a range that isn't whole sibling blocks", () => {
    const editor = editorWith({ type: "doc", content: [para("one"), para("two")] });
    let offered = false;
    requestRangeMove(editor, 2, 7, () => (offered = true));
    expect(offered).toBe(false);
    editor.destroy();
  });
});
