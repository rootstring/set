<script lang="ts">
  import type { PageSummary } from "$lib/types";
  import Icon from "$lib/shell/Icon.svelte";
  import { dismissible } from "$lib/shell/dismiss.svelte";
  import { anchorRect, place } from "$lib/shell/popover";

  interface Props {
    pages: PageSummary[];
    onOpenPage: (id: string) => void;
  }

  let { pages, onOpenPage }: Props = $props();

  /** Past this the rest go behind a count. */
  const INLINE = 3;

  const shown = $derived(pages.slice(0, INLINE));
  const hidden = $derived(pages.length - shown.length);

  const titleOf = (page: PageSummary) => page.title.trim() || "Untitled";

  let open = $state(false);
  let moreButton = $state<HTMLButtonElement>();
  let popover = $state<HTMLDivElement>();

  let top = $state(0);
  let left = $state(0);
  let caret = $state<number | null>(null);
  let above = $state(false);
  let placed = $state(false);

  function reposition(): void {
    if (!popover) return;
    // Layout metrics, not a bounding rect: the open animation scales the popover.
    const spot = place(popover.offsetWidth, popover.offsetHeight, anchorRect(moreButton));
    top = spot.top;
    left = spot.left;
    caret = spot.caret;
    above = spot.above;
    placed = true;
  }

  $effect(() => {
    if (!open || !popover) {
      placed = false;
      return;
    }
    reposition();
    popover.querySelector<HTMLElement>("button")?.focus();

    const onScroll = () => reposition();
    window.addEventListener("scroll", onScroll, true);
    return () => window.removeEventListener("scroll", onScroll, true);
  });

  // A linking page can be renamed or trashed while the list is up.
  $effect(() => {
    if (pages.length === 0) open = false;
  });

  dismissible({
    isOpen: () => open,
    anchors: () => [popover, moreButton],
    close: () => (open = false),
    escape: (event) => {
      event.preventDefault();
      event.stopPropagation();
      open = false;
      moreButton?.focus();
    },
  });

  function go(id: string): void {
    open = false;
    onOpenPage(id);
  }
</script>

<!-- Under the title, one line at any count. -->
<nav class="backlinks" aria-label="Linked from">
  <span class="label">Linked from</span>
  {#each shown as source (source.id)}
    <button type="button" class="chip" onclick={() => go(source.id)}>
      <span class="chip-icon"><Icon name="page" /></span>
      <span class="chip-title">{titleOf(source)}</span>
    </button>
  {/each}
  {#if hidden > 0}
    <button
      type="button"
      class="chip more"
      bind:this={moreButton}
      aria-expanded={open}
      aria-label="{hidden} more {hidden === 1 ? 'page links' : 'pages link'} here"
      onclick={() => (open = !open)}
    >
      +{hidden}
    </button>
  {/if}
</nav>

{#if open}
  <div
    bind:this={popover}
    class="popover"
    class:above
    class:ready={placed}
    style="top: {top}px; left: {left}px"
    role="dialog"
    aria-label="Pages that link here"
  >
    {#if caret !== null}
      <span class="caret" style="left: {caret}px" aria-hidden="true"></span>
    {/if}
    <p class="popover-title">Linked from <span class="count">{pages.length}</span></p>
    <!-- Capped and scrolled: a page everything points at. -->
    <ul class="list">
      {#each pages as source (source.id)}
        <li>
          <button type="button" class="row" onclick={() => go(source.id)}>
            <span class="row-icon"><Icon name="page" /></span>
            <span class="row-title">{titleOf(source)}</span>
          </button>
        </li>
      {/each}
    </ul>
  </div>
{/if}

<style>
  .backlinks {
    display: flex;
    align-items: center;
    gap: 0.3rem;

    box-sizing: border-box;
    width: var(--reading-column);
    margin: 0 auto 0.6rem;

    font-size: 0.75rem;
    line-height: 1.4;
  }

  .label {
    flex: 0 0 auto;
    margin-inline-end: 0.1rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--text-subtle);
  }

  /* Noticed second, so no border or fill until pointed at. */
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;

    /* Shrinkable, so three long titles share the line instead of pushing the
       count off the end of it. */
    min-width: 0;
    flex: 0 1 auto;

    padding: 0.1rem 0.3rem;
    margin-inline: -0.05rem;
    border: none;
    border-radius: var(--radius);
    background: transparent;

    font: inherit;
    color: var(--text-muted);
    cursor: pointer;
    transition:
      background-color 0.12s ease,
      color 0.12s ease;
  }

  .chip:hover,
  .chip:focus-visible {
    background-color: var(--accent-soft);
    color: var(--accent-ink);
  }

  .chip-icon {
    display: inline-flex;
    flex: 0 0 auto;
    font-size: 0.875rem;
  }

  .chip-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .more {
    flex: 0 0 auto;
    font-variant-numeric: tabular-nums;
  }

  .popover {
    --popover-width: 240px;
    padding: 0.4rem;
  }

  .popover-title {
    margin: 0.15rem 0.35rem 0.35rem;
    font-size: 0.6875rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--text-subtle);
  }

  .count {
    font-variant-numeric: tabular-nums;
    letter-spacing: 0;
    opacity: 0.75;
  }

  .list {
    max-height: 13.5rem;
    overflow-y: auto;
    overscroll-behavior: contain;

    list-style: none;
    margin: 0;
    padding: 0;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    width: 100%;

    padding: 0.3rem 0.35rem;
    border: none;
    border-radius: var(--radius);
    background: transparent;

    font: inherit;
    font-size: 0.8125rem;
    text-align: start;
    color: var(--text);
    cursor: pointer;
  }

  .row:hover,
  .row:focus-visible {
    background-color: var(--accent-soft);
    color: var(--accent-ink);
  }

  .row-icon {
    display: inline-flex;
    flex: 0 0 auto;
    font-size: 0.9375rem;
    color: var(--accent);
  }

  .row:hover .row-icon,
  .row:focus-visible .row-icon {
    color: var(--accent-ink);
  }

  .row-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
