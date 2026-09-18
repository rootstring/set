<script lang="ts">
  import type { PageSummary } from "$lib/types";
  import Icon from "$lib/shell/Icon.svelte";
  import { settings, shortcutHint } from "$lib/state/settings.svelte";
  import { askUnlock } from "./lock";
  import { lockNudges } from "$lib/state/lock-nudge.svelte";

  interface Props {
    /** The open page's ancestors, outermost first. */
    trail: PageSummary[];
    /** The open page, which ends the trail. */
    current: PageSummary;
    onOpenPage: (id: string) => void;
    /** Step right, past the floating sidebar button the browser build shows. */
    offset?: boolean;
    /** The open page is read-only, which the trail marks and offers to undo. */
    locked?: boolean;
    onUnlock?: () => void;
  }

  let {
    trail,
    current,
    onOpenPage,
    offset = false,
    locked = false,
    onUnlock = () => {},
  }: Props = $props();

  const lockHint = $derived(shortcutHint(settings.lockShortcut));

  /**
   * Remounted per try so the animation restarts; none on the mount that comes with opening the
   * page.
   */
  let shakes = $state(0);
  $effect(() => {
    const count = lockNudges.count;
    if (locked && count > 0) shakes = count;
  });

  /** Keeps the outermost page and the nearest two. */
  const FOLD_OVER = 3;

  let expanded = $state(false);

  const folded = $derived(!expanded && trail.length > FOLD_OVER);
  const head = $derived(folded ? trail.slice(0, 1) : trail);
  const tail = $derived(folded ? trail.slice(-2) : []);
  const hidden = $derived(folded ? trail.slice(1, -2) : []);

  const titleOf = (page: PageSummary) => page.title.trim() || "Untitled";
</script>

{#snippet crumb(page: PageSummary)}
  <li class="item">
    <button
      type="button"
      class="crumb"
      title="Open “{titleOf(page)}”"
      onclick={() => onOpenPage(page.id)}>{titleOf(page)}</button
    >
    <span class="sep" aria-hidden="true">›</span>
  </li>
{/snippet}

<!-- Names where the page is, so it stays put while the page scrolls. -->
<nav class="breadcrumbs" class:offset aria-label="Breadcrumb" data-testid="breadcrumbs">
  <ol class="list">
    {#each head as page (page.id)}
      {@render crumb(page)}
    {/each}
    {#if folded}
      <li class="item">
        <button
          type="button"
          class="crumb fold"
          title={hidden.map(titleOf).join(" › ")}
          aria-label="Show {hidden.length} more"
          onclick={() => (expanded = true)}>…</button
        >
        <span class="sep" aria-hidden="true">›</span>
      </li>
      {#each tail as page (page.id)}
        {@render crumb(page)}
      {/each}
    {/if}
    <!-- Where you are rather than somewhere to go, so not a button. -->
    <li class="item">
      <span class="crumb here" aria-current="page" title={titleOf(current)}
        >{titleOf(current)}</span
      >
    </li>
    {#if locked}
      <!-- The lock rides beside the page name; the note on the page says more. -->
      <li class="item">
        <button
          type="button"
          class="lock"
          title="Locked. Unlock page{lockHint}"
          aria-label="Unlock page"
          onclick={(e) => askUnlock(e.currentTarget, onUnlock)}
          data-testid="breadcrumb-unlock"
          data-shakes={shakes}
        >
          {#key shakes}
            <span class="lock-icon" class:shake={shakes > 0}><Icon name="lock" /></span>
          {/key}
        </button>
      </li>
    {/if}
  </ol>
</nav>

<style>
  /* Lined up with the page menu (see PageMenu.svelte), and stopping short
     of it. */
  .breadcrumbs {
    position: absolute;
    top: 10px;
    left: 14px;
    z-index: 40;

    box-sizing: border-box;
    max-width: calc(100% - 14px - 28px - 14px - 12px - var(--sbw, 0px));
    padding: 0 0.3rem;
    border-radius: var(--radius);
    /* Text scrolling up under it shouldn't show through. */
    background: var(--editor-bg);

    font-size: 0.8125rem;
    line-height: 1.5rem;
  }
  .breadcrumbs.offset {
    left: 44px;
    max-width: calc(100% - 44px - 28px - 14px - 12px - var(--sbw, 0px));
  }

  :global(html.tauri-macos) .breadcrumbs {
    top: 48px;
  }

  :global(html.tauri-linux) .breadcrumbs,
  :global(html.tauri-windows) .breadcrumbs {
    top: calc(var(--titlebar-height) + 10px);
  }

  .list {
    display: flex;
    align-items: center;
    min-width: 0;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  /* Every crumb gives up width before the line wraps, the nearest last. */
  .item {
    display: flex;
    align-items: center;
    min-width: 0;
    flex: 0 1 auto;
  }
  .item:last-child {
    flex-shrink: 0.4;
  }

  .crumb {
    min-width: 0;
    max-width: 14rem;
    padding: 0 0.3rem;
    margin-inline: -0.05rem;
    border: none;
    border-radius: var(--radius);
    background: transparent;

    font: inherit;
    color: var(--text-subtle);
    cursor: pointer;

    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;

    transition:
      background-color 0.12s ease,
      color 0.12s ease;
  }
  .item:first-child .crumb {
    margin-inline-start: -0.3rem;
  }

  .crumb:not(.here):hover,
  .crumb:not(.here):focus-visible {
    background-color: var(--accent-soft);
    color: var(--accent-ink);
  }

  .here {
    color: var(--text-muted);
    cursor: default;
  }

  .fold {
    flex: 0 0 auto;
  }

  .lock {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    width: 1.25rem;
    height: 1.25rem;
    margin-inline-start: 0.1rem;
    padding: 0;
    border: none;
    border-radius: var(--radius);
    background: transparent;

    font-size: 0.8125rem;
    color: var(--text-subtle);
    cursor: pointer;

    transition:
      background-color 0.12s ease,
      color 0.12s ease;
  }
  .lock:hover,
  .lock:focus-visible {
    background-color: var(--accent-soft);
    color: var(--accent-ink);
  }

  .lock-icon {
    display: inline-flex;
    transform-origin: 50% 80%;
  }
  /* A small shake of the head: quick, a few degrees, and over. */
  .lock-icon.shake {
    animation: lock-shake 0.45s ease-in-out;
  }
  @keyframes lock-shake {
    0%,
    100% {
      transform: rotate(0);
    }
    20% {
      transform: rotate(-9deg);
    }
    45% {
      transform: rotate(7deg);
    }
    70% {
      transform: rotate(-4deg);
    }
    85% {
      transform: rotate(2deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .lock-icon.shake {
      animation: none;
    }
  }

  .sep {
    flex: 0 0 auto;
    padding-inline: 0.1rem;
    color: var(--text-subtle);
    opacity: 0.7;
  }
</style>
