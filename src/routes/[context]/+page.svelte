<script lang="ts">
  import { workspace } from "$lib/state/workspace.svelte";
  import { settings, formatShortcut } from "$lib/state/settings.svelte";

  /** Where you land with no page to show. */
  const named = $derived(workspace.contexts.length > 1);

  const shortcut = $derived(
    settings.newPageShortcut ? formatShortcut(settings.newPageShortcut) : "",
  );
</script>

<svelte:head>
  <title>Set</title>
</svelte:head>

<div class="empty">
  <h1>
    {#if named}
      Nothing in “{workspace.activeContext}” yet
    {:else}
      No pages yet
    {/if}
  </h1>
  <button
    class="control primary"
    data-testid="empty-new-page"
    onclick={() => workspace.createPage()}
  >
    New page
    {#if shortcut}<kbd>{shortcut}</kbd>{/if}
  </button>
</div>

<style>
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.55rem;
    height: 100%;
    padding: 0 1.5rem 3rem;
    box-sizing: border-box;
    text-align: center;
  }

  h1 {
    margin: 0;
    font-size: 1.05rem;
    font-weight: 600;
    color: var(--text);
  }

  button {
    gap: 0.5rem;
    padding: 0.4rem 0.8rem;
    font-size: 0.85rem;
  }

  kbd {
    font: inherit;
    font-size: 0.75rem;
    opacity: 0.75;
  }
</style>
