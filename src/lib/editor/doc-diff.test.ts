import { describe, expect, it } from "vitest";
import { Schema, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";

import { docPatch } from "./doc-diff";

/** Paragraphs and text are all doc-diff looks at. */
const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "text*" },
    text: {},
  },
});

function doc(...paragraphs: string[]): ProseMirrorNode {
  return schema.node(
    "doc",
    null,
    paragraphs.map((text) =>
      schema.node("paragraph", null, text ? [schema.text(text)] : []),
    ),
  );
}

/** Where the caret ends up after `next` is patched in over `current`. */
function caretAfter(
  current: ProseMirrorNode,
  next: ProseMirrorNode,
  caret: number,
): number {
  let state = EditorState.create({ doc: current });
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, caret)));
  const patch = docPatch(state.doc, next);
  if (!patch) return state.selection.head;
  const tr = state.tr.replace(patch.from, patch.to, patch.slice);
  return state.apply(tr).selection.head;
}

describe("docPatch", () => {
  it("finds nothing to do when the document is unchanged", () => {
    expect(docPatch(doc("one", "two"), doc("one", "two"))).toBeNull();
  });

  it("produces a document identical to the one asked for", () => {
    const pairs: [ProseMirrorNode, ProseMirrorNode][] = [
      [doc("one", "two"), doc("one", "two", "three")],
      [doc("one", "two", "three"), doc("one", "three")],
      [doc("one", "two"), doc("one", "changed")],
      [doc("one"), doc("")],
      [doc(""), doc("first words")],
      [doc("a", "b", "c"), doc("c", "b", "a")],
      [doc("same", "same"), doc("same")],
    ];

    for (const [current, next] of pairs) {
      const patch = docPatch(current, next);
      expect(patch, `${current.textContent} -> ${next.textContent}`).not.toBeNull();

      const state = EditorState.create({ doc: current });
      const after = state.apply(state.tr.replace(patch!.from, patch!.to, patch!.slice));
      expect(after.doc.toJSON()).toEqual(next.toJSON());
    }
  });

  it("touches only the paragraph that actually changed", () => {
    const current = doc("first", "second", "third");
    const patch = docPatch(current, doc("first", "SECOND", "third"))!;

    // A patch past the middle paragraph would be the whole-document replacement this exists to
    // avoid.
    expect(patch.from).toBeGreaterThan(6);
    expect(patch.to).toBeLessThan(current.content.size - 6);
  });

  it("leaves a caret above the change exactly where it was", () => {
    const current = doc("first", "second", "third");
    const next = doc("first", "second", "third and more");

    expect(caretAfter(current, next, 3)).toBe(3);
  });

  it("carries a caret below the change along with the text it sits in", () => {
    const current = doc("first", "second", "third");
    const next = doc("first", "second is much longer now", "third");

    const caret = current.content.size - 2; // "thir|d" in the last paragraph
    const moved = caretAfter(current, next, caret);

    expect(moved).not.toBe(caret); // the text above it got longer
    expect(next.textBetween(moved - 4, moved + 1)).toBe("third");
  });

  it("survives a deletion that removes the text the caret was in", () => {
    const current = doc("first", "doomed", "third");
    const next = doc("first", "third");

    const caret = 10; // inside "doomed"
    const moved = caretAfter(current, next, caret);

    expect(moved).toBeGreaterThan(0);
    expect(moved).toBeLessThanOrEqual(next.content.size);
  });

  it("handles a repeated line, where the two scans cross over", () => {
    const current = doc("same", "same", "same");
    const next = doc("same", "same");

    const patch = docPatch(current, next)!;
    expect(patch.to).toBeGreaterThanOrEqual(patch.from);

    const state = EditorState.create({ doc: current });
    const after = state.apply(state.tr.replace(patch.from, patch.to, patch.slice));
    expect(after.doc.toJSON()).toEqual(next.toJSON());
  });
});
