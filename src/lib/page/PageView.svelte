<script lang="ts">
  import type { Page, PageSummary } from "$lib/types";
  import Backlinks from "./Backlinks.svelte";
  import { Editor, focusBodyStart } from "$lib/editor";
  import type { MoveBlockRequest } from "$lib/editor/block-move";
  import { docKey } from "$lib/editor/active-editor";
  import { viewState } from "$lib/state/view-state";
  import { settings } from "$lib/state/settings.svelte";
  import { lockNudges } from "$lib/state/lock-nudge.svelte";
  import {
    createDateMentionField,
    type DateMentionController,
  } from "$lib/editor/title-mention.svelte";

  interface Props {
    page: Page;
    docVersion: number;
    onTitleChange: (title: string) => void;
    onDocChange: () => void;
    onOpenPage: (id: string) => void;
    resolveTitle: (id: string) => string | undefined;
    resolvePageByTitle?: (title: string) => string | undefined;
    /** The pages whose body points here with a `[[wikilink]]`. */
    backlinks?: PageSummary[];
    onCreateChildPage: () => Promise<PageSummary>;
    onDeletePage: (id: string, anchor: HTMLElement | null) => void;
    onDuplicatePage: (id: string) => void;
    onMoveBlock: MoveBlockRequest;
    resolveAssetUrl: (ref: string) => Promise<string | null>;
    onInsertAsset: (file: File) => Promise<string | null>;
  }

  let {
    page,
    docVersion,
    onTitleChange,
    onDocChange,
    onOpenPage,
    resolveTitle,
    resolvePageByTitle,
    backlinks = [],
    onCreateChildPage,
    onDeletePage,
    onDuplicatePage,
    onMoveBlock,
    resolveAssetUrl,
    onInsertAsset,
  }: Props = $props();

  let titleEl = $state<HTMLTextAreaElement>();

  let dateMention: DateMentionController | undefined;
  $effect(() => {
    if (!titleEl) return;
    dateMention = createDateMentionField(titleEl);
    return () => dateMention?.destroy();
  });

  const caret = $derived(viewState.caretFor(page.id));

  function autosizeTitle() {
    const el = titleEl;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }

  $effect(() => {
    page.id;
    page.title;
    settings.fontSize;
    settings.bodyFont;
    autosizeTitle();
  });

  $effect(() => {
    document.fonts?.ready.then(autosizeTitle);
  });

  /**
   * Only keys that would have written something, and only when meant for the page, not a dialog
   * over it.
   */
  function onKeydownLocked(event: KeyboardEvent): void {
    if (!page.locked || event.metaKey || event.ctrlKey || event.altKey) return;
    const writes =
      event.key.length === 1 || ["Enter", "Backspace", "Delete"].includes(event.key);
    if (!writes) return;
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const forPage =
      target === document.body || target === titleEl || !!target.closest(".ProseMirror");
    if (forPage) lockNudges.nudge();
  }

  function handleTitleInput(event: Event) {
    onTitleChange((event.currentTarget as HTMLTextAreaElement).value);
    autosizeTitle();
    dateMention?.onInput();
  }

  function handleTitleKeydown(event: KeyboardEvent) {
    if (dateMention?.onKeydown(event)) return;
    if (event.key === "Enter") {
      event.preventDefault();
      focusBodyStart();
    }
  }
</script>

<svelte:window onkeydown={onKeydownLocked} />

<article class="page">
  <textarea
    class="title"
    rows="1"
    placeholder="Untitled"
    readonly={page.locked}
    bind:this={titleEl}
    value={page.title}
    oninput={handleTitleInput}
    onkeydown={handleTitleKeydown}></textarea>
  {#if backlinks.length > 0}
    <Backlinks pages={backlinks} {onOpenPage} />
  {/if}
  <Editor
    content={page.doc}
    docId={page.id}
    resetKey={docKey(page.id, docVersion)}
    selection={caret}
    editable={!page.locked}
    placeholder="Write something"
    onChange={onDocChange}
    {onOpenPage}
    {resolveTitle}
    {resolvePageByTitle}
    {onCreateChildPage}
    {onDeletePage}
    {onDuplicatePage}
    {onMoveBlock}
    {resolveAssetUrl}
    {onInsertAsset}
  />
</article>

<style>
  .page {
    padding: var(--sidebar-header-height) 0 0;
  }

  .title {
    display: block;

    box-sizing: border-box;
    width: calc(var(--reading-column) + 4px);
    padding-inline: 2px;
    margin-inline: auto;
    border: none;
    outline: none;
    resize: none;
    background: transparent;
    color: var(--text);

    font-family: var(--font-body);
    font-size: calc(var(--editor-font-size) * 1.875);
    font-weight: 700;
    line-height: 1.2;
    margin-bottom: 0.5rem;
    /* The backlink row carries its own gap to the body below it. */

    padding-block: 0.08em;
    overflow: hidden;
  }

  .title::placeholder {
    color: var(--text-subtle);
  }

  .title[readonly] {
    cursor: default;
  }
</style>
