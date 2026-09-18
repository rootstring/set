<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import { Editor, type Content } from "@tiptap/core";
  import { EditorState, Selection, TextSelection } from "@tiptap/pm/state";
  import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
  import type { EditorView } from "@tiptap/pm/view";
  import type { PageDoc } from "$lib/types";
  import { createExtensions, type EditorSchemaOptions } from "./extensions";
  import type { DragHandleController } from "./drag-handle";
  import { setActiveEditor } from "./active-editor";
  import { docPatch, EXTERNAL_EDIT } from "./doc-diff";
  import { settings } from "$lib/state/settings.svelte";
  import { perf } from "$lib/utils/perf";

  /** Everything the schema takes, plus what only a live editor has. */
  interface Props extends Omit<EditorSchemaOptions, "interactive" | "onDragHandleReady"> {
    content?: PageDoc;
    docId?: string;
    resetKey?: string;
    selection?: { anchor: number; head: number } | null;
    editable?: boolean;
    onChange?: () => void;
  }

  let {
    content,
    docId,
    resetKey,
    selection = null,
    editable = true,
    onChange,
    ...schema
  }: Props = $props();

  const SCROLL_ROOM = 96;

  function storedSelection(
    doc: ProseMirrorNode,
    stored: { anchor: number; head: number } | null | undefined,
  ): Selection | null {
    if (!stored) return null;
    const end = doc.content.size;
    if (stored.anchor > end || stored.head > end) return null;
    try {
      return TextSelection.between(doc.resolve(stored.anchor), doc.resolve(stored.head));
    } catch {
      return null;
    }
  }

  function scrollParent(): HTMLElement | null {
    for (let node = element?.parentElement; node; node = node.parentElement) {
      const overflow = getComputedStyle(node).overflowY;
      if (overflow === "auto" || overflow === "scroll") return node;
    }
    return null;
  }

  function scrollToTop(): void {
    const parent = scrollParent();
    if (parent) parent.scrollTop = 0;
  }

  function scrollToCaret(view: EditorView, pos: number): void {
    const parent = scrollParent();
    if (!parent) return;
    const caret = view.coordsAtPos(pos);
    const top = parent.getBoundingClientRect().top;

    if (caret.top >= top + SCROLL_ROOM && caret.bottom <= top + parent.clientHeight) {
      return;
    }

    parent.scrollTop += caret.top - top - SCROLL_ROOM;
  }

  /**
   * Leaves the caret, scroll and undo history alone. False when the document cannot be applied (a
   * node this build does not know), so the caller replaces wholesale.
   */
  function patchInPlace(next: PageDoc | undefined): boolean {
    if (!editor) return false;
    const { view } = editor;
    try {
      const incoming = view.state.schema.nodeFromJSON(
        next ?? { type: "doc", content: [] },
      );
      const patch = docPatch(view.state.doc, incoming);
      if (!patch) return true;

      view.dispatch(
        view.state.tr
          .replace(patch.from, patch.to, patch.slice)
          .setMeta(EXTERNAL_EDIT, true)
          .setMeta("addToHistory", false),
      );
      return true;
    } catch {
      return false;
    }
  }

  let element: HTMLDivElement;
  let editor: Editor | undefined;

  let stopKeystrokes: (() => void) | undefined;

  let dragHandle: DragHandleController | undefined;

  let lastResetKey: string | undefined;
  let lastDocId: string | undefined;

  let appliedEditable: boolean | undefined;

  $effect(() => {
    if (!element) return;

    untrack(() => {
      lastResetKey = resetKey;
      lastDocId = docId;

      stopKeystrokes = perf.observeKeystrokes(element);

      appliedEditable = editable;
      editor = new Editor({
        element,
        extensions: createExtensions({
          ...schema,
          onDragHandleReady: (controller) => (dragHandle = controller),
        }),
        content: (content ?? undefined) as Content,
        editable,
        editorProps: {
          scrollThreshold: SCROLL_ROOM,
          scrollMargin: SCROLL_ROOM,
        },
        onUpdate: ({ transaction }) => {
          if (transaction.getMeta(EXTERNAL_EDIT)) return;
          onChange?.();

          perf.keystrokeUpdated();
        },
      });

      const restored = storedSelection(editor.state.doc, selection);
      if (restored) {
        const { view } = editor;
        view.dispatch(view.state.tr.setSelection(restored));
        scrollToCaret(view, restored.head);
      }

      setActiveEditor(editor, resetKey ?? null);
    });

    return () => {
      setActiveEditor(null);
      stopKeystrokes?.();
      stopKeystrokes = undefined;
      dragHandle?.reset();
      dragHandle = undefined;
      editor?.destroy();
      editor = undefined;
      appliedEditable = undefined;
    };
  });

  $effect(() => {
    if (!editor) return;
    if (resetKey !== lastResetKey) {
      const samePage = docId != null && docId === lastDocId;
      lastResetKey = resetKey;
      lastDocId = docId;

      // Same page, new contents: patch it in so whoever is typing keeps their caret.
      if (samePage && patchInPlace(content)) {
        setActiveEditor(editor, resetKey ?? null);
        dragHandle?.reset();
        return;
      }

      editor.commands.setContent((content ?? { type: "doc", content: [] }) as Content, {
        emitUpdate: false,
      });

      const { view } = editor;

      const restored = storedSelection(view.state.doc, selection);
      const start = Selection.atStart(view.state.doc);
      view.updateState(
        EditorState.create({
          doc: view.state.doc,
          selection:
            restored ?? (start instanceof TextSelection ? start : view.state.selection),
          storedMarks: view.state.storedMarks,
          plugins: view.state.plugins,
        }),
      );

      if (restored) scrollToCaret(view, restored.head);
      else scrollToTop();

      setActiveEditor(editor, resetKey ?? null);

      dragHandle?.reset();
    }
  });

  $effect(() => {
    if (!editor || editable === appliedEditable) return;
    appliedEditable = editable;
    editor.setEditable(editable, false);
  });

  $effect(() => {
    settings.slashMenu; // track
    editor?.view.dispatch(editor.state.tr);
  });

  onDestroy(() => {
    stopKeystrokes?.();
    editor?.destroy();
  });
</script>

<div class="editor" bind:this={element}></div>

<style>
  .editor {
    width: 100%;

    position: relative;
  }

  .editor :global(.ProseMirror) {
    outline: none;

    padding-bottom: 20vh;
  }

  .editor :global(.ProseMirror .is-empty::before) {
    content: attr(data-placeholder);
    color: var(--text-subtle);
    float: left;
    height: 0;
    pointer-events: none;
  }
</style>
