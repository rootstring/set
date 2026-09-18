import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Selection } from "@tiptap/pm/state";

let active: Editor | null = null;
let activeKey: string | null = null;

export function docKey(pageId: string | null, docVersion: number): string {
  return `${pageId}#${docVersion}`;
}

export function setActiveEditor(editor: Editor | null, key: string | null = null): void {
  active = editor;
  activeKey = editor ? key : null;
}

export function getActiveEditor(): Editor | null {
  return active;
}

export function getActiveEditorKey(): string | null {
  return activeKey;
}

function bodyTextStart(doc: ProseMirrorNode): Selection | null {
  const first = doc.firstChild;
  if (!first) return null;
  const sel = Selection.findFrom(doc.resolve(0), 1, true);
  return sel && sel.from <= first.nodeSize ? sel : null;
}

const LIST_NODES = new Set(["taskList", "bulletList", "orderedList"]);

function startsWithList(doc: ProseMirrorNode): boolean {
  const first = doc.firstChild;
  return !!first && LIST_NODES.has(first.type.name);
}

export function focusBodyStart(): void {
  const editor = active;
  if (!editor) return;

  const doc = editor.state.doc;
  if (!bodyTextStart(doc) || startsWithList(doc)) {
    editor.commands.insertContentAt(0, { type: "paragraph" });
  }

  const { view } = editor;
  const tr = view.state.tr;
  const sel = bodyTextStart(tr.doc);
  if (sel) tr.setSelection(sel);
  view.dispatch(tr.scrollIntoView());

  view.dom.focus();
}
