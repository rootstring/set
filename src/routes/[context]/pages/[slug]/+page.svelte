<script lang="ts">
  import { untrack } from "svelte";
  import { afterNavigate } from "$app/navigation";
  import { PageView } from "$lib/page";
  import { workspace } from "$lib/state/workspace.svelte";

  const page = $derived(workspace.activePage);

  // An out-of-date address is corrected once the page it names is open.
  $effect(() => {
    if (!workspace.activePageId) return;
    untrack(() => workspace.syncUrl());
  });

  // The title is the key a wikilink matches on, so a rename changes the answer.
  $effect(() => {
    workspace.activePageId;
    workspace.activePage?.title;
    untrack(() => workspace.requestBacklinks());
  });

  afterNavigate((nav) => {
    if (nav.type === "enter") return;
    if (workspace.activePage?.title.trim()) return;
    document.querySelector<HTMLTextAreaElement>(".title")?.focus();
  });
</script>

<svelte:head>
  <title>{page?.title.trim() || "Untitled"} · Set</title>
</svelte:head>
{#if page}
  <PageView
    {page}
    docVersion={workspace.activeDocVersion}
    onTitleChange={(title) => workspace.setActiveTitle(title)}
    onDocChange={() => workspace.markDirty()}
    onOpenPage={(id) => workspace.goTo(id)}
    resolveTitle={(id) => workspace.pages.find((p) => p.id === id)?.title}
    resolvePageByTitle={(title) => workspace.pageIdByTitle(title)}
    backlinks={workspace.backlinks}
    onCreateChildPage={() => workspace.createChild(workspace.activePageId)}
    onDeletePage={(id) => workspace.requestDelete(id)}
    onDuplicatePage={(id) => workspace.duplicatePage(id)}
    onMoveBlock={(blocks, remove, into, anchor) =>
      workspace.moveBlockToPage(blocks, remove, into, anchor)}
    resolveAssetUrl={(ref) => workspace.assetUrl(ref)}
    onInsertAsset={(file) => workspace.putAsset(file)}
  />
{:else}
  <div class="loading">Loading…</div>
{/if}

<style>
  .loading {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--text-subtle);
  }
</style>
