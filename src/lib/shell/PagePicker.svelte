<script lang="ts">
  import { tick } from "svelte";
  import type { PageSummary } from "$lib/types";
  import Icon from "./Icon.svelte";
  import { rankPages } from "$lib/search";
  import { pagePicker } from "$lib/state/page-picker.svelte";
  import { dismissible } from "./dismiss.svelte";
  import { anchorRect, place } from "./popover";

  interface Props {
    /** Every page. What the panel offers is narrowed by the ask's scope. */
    pages: PageSummary[];
    /** Where a scoped ask looks, and what the chip is named after. */
    activeContext: string;
  }

  let { pages, activeContext }: Props = $props();

  const LIMIT = 50;

  const request = $derived(pagePicker.request);

  let query = $state("");
  let activeIndex = $state(0);

  /** Only an "anywhere" ask can turn this on, and only Tab or the chip does. */
  let allContexts = $state(false);

  let el = $state<HTMLDivElement>();
  let input = $state<HTMLInputElement>();
  let listEl = $state<HTMLElement>();

  let top = $state(0);
  let left = $state(0);
  let caret = $state<number | null>(null);
  let above = $state(false);
  let placed = $state(false);

  const multiContext = $derived(pages.some((p) => p.context !== activeContext));

  /** The chip is worth drawing only when there is somewhere else to go. */
  const canWiden = $derived(request?.scope === "anywhere" && multiContext);

  const inScope = $derived(
    canWiden && allContexts ? pages : pages.filter((p) => p.context === activeContext),
  );

  const candidates = $derived(
    inScope.filter(
      (p) => !request?.exclude.has(p.id) && !(request?.titledOnly && !p.title.trim()),
    ),
  );

  const matches = $derived(rankPages(candidates, query, LIMIT));

  function reposition(): void {
    if (!el) return;
    // Layout metrics, not a bounding rect: the open animation scales the popover.
    const spot = place(el.offsetWidth, el.offsetHeight, anchorRect(request?.anchor));
    top = spot.top;
    left = spot.left;
    caret = spot.caret;
    above = spot.above;
    placed = true;
  }

  // A fresh ask starts at the top, and so does every keystroke that changes
  // what's under it.
  $effect(() => {
    request;
    query;
    activeIndex = 0;
  });

  // And starts where you are, however the last ask was left.
  $effect(() => {
    request;
    allContexts = false;
  });

  let camefrom: HTMLElement | null = null;

  $effect(() => {
    if (!request || !el) {
      camefrom = null;
      placed = false;
      return;
    }
    camefrom ??= document.activeElement as HTMLElement | null;
    query = "";
    reposition();
    // After paint: the popover is `visibility: hidden` until measured.
    void tick().then(() => input?.focus());

    const onScroll = () => reposition();
    window.addEventListener("scroll", onScroll, true);
    return () => window.removeEventListener("scroll", onScroll, true);
  });

  // The list grows as you type; a popover near the bottom has to move.
  $effect(() => {
    matches.length;
    if (request && el) reposition();
  });

  /** Before the answer, so the field is not removed while it holds focus. */
  function handBack(): void {
    if (camefrom?.isConnected) camefrom.focus();
  }

  $effect(() => {
    const row = listEl?.querySelector<HTMLElement>(`[data-i="${activeIndex}"]`);
    row?.scrollIntoView({ block: "nearest" });
  });

  function toggleScope(): void {
    if (!canWiden) return;
    allContexts = !allContexts;
    activeIndex = 0;
  }

  function choose(index: number): void {
    const match = matches[index];
    if (!match) return;
    handBack();
    pagePicker.choose(match.page.id);
  }

  function cancel(): void {
    handBack();
    pagePicker.cancel();
  }

  dismissible({
    isOpen: () => pagePicker.open,
    anchors: () => [el],
    close: cancel,
    escape: (event) => {
      // The editor underneath reads Escape as its own cue.
      event.preventDefault();
      event.stopPropagation();
      cancel();
    },
  });

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === "Tab" && canWiden) {
      event.preventDefault();
      toggleScope();
      input?.focus();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      activeIndex = Math.min(activeIndex + 1, matches.length - 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      activeIndex = Math.max(activeIndex - 1, 0);
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(activeIndex);
    }
  }
</script>

<!-- Beside what asked, not over everything. `dismissible` handles Escape and the press outside. -->
{#if request}
  <div
    bind:this={el}
    class="popover"
    class:above
    class:ready={placed}
    style="top: {top}px; left: {left}px"
    role="dialog"
    tabindex="-1"
    aria-label={request.title}
    onkeydown={onKeydown}
    data-testid="page-picker"
  >
    {#if caret !== null}
      <span class="caret" style="left: {caret}px" aria-hidden="true"></span>
    {/if}
    <div class="search-row">
      <span class="search-icon"><Icon name="search" /></span>
      <input
        bind:this={input}
        bind:value={query}
        class="search"
        type="text"
        placeholder={request.title}
        spellcheck="false"
        autocomplete="off"
        aria-label={request.title}
        aria-controls="picker-results"
      />
      {#if canWiden}
        <button
          type="button"
          class="scope-chip"
          class:wide={allContexts}
          onclick={() => {
            toggleScope();
            // Hand the caret straight back: the next thing is to keep typing.
            input?.focus();
          }}
          data-testid="picker-scope-chip"
        >
          {allContexts ? "All contexts" : activeContext}
        </button>
      {/if}
    </div>
    <div
      class="results"
      bind:this={listEl}
      id="picker-results"
      role="listbox"
      aria-label="Pages"
    >
      {#each matches as match, i (match.page.id)}
        <button
          type="button"
          class="result"
          class:active={i === activeIndex}
          role="option"
          aria-selected={i === activeIndex}
          data-i={i}
          data-testid="picker-result"
          onclick={() => choose(i)}
          onmousemove={() => (activeIndex = i)}
        >
          <span class="result-icon"><Icon name="page" /></span>
          <span class="result-text">
            <span class="result-title">
              {#each match.title as seg}<span class:hit={seg.hit}>{seg.text}</span>{/each}
            </span>
            {#if match.path.some((s) => s.text)}
              <span class="result-path">
                {#each match.path as seg}<span class:hit={seg.hit}>{seg.text}</span
                  >{/each}
              </span>
            {/if}
          </span>
        </button>
      {/each}

      {#if matches.length === 0}
        <div class="empty">
          {#if query.trim()}
            <p class="empty-title">No page called “{query.trim()}”</p>
          {:else}
            <p class="empty-title">{request.emptyTitle}</p>
            <p class="empty-hint">
              {#if candidates.length === 0 && inScope.length > 0}
                {request.scope === "anywhere"
                  ? "Every page here is one this can't point at."
                  : "This is the only page it can't go to."}
              {:else}
                There is no other page in this context yet.
              {/if}
            </p>
          {/if}
        </div>
      {/if}
    </div>

    {#if canWiden}
      <p class="hint" data-testid="picker-tab-hint">
        <kbd>Tab</kbd>
        <span>
          {allContexts ? `Search only “${activeContext}”` : "Search all contexts"}
        </span>
      </p>
    {/if}
  </div>
{/if}

<style>
  .popover {
    --popover-width: 340px;
    display: flex;
    flex-direction: column;
  }

  .search-row {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding-left: 0.7rem;
    border-bottom: 1px solid var(--border);
    overflow: hidden;
  }

  .search-icon {
    display: inline-flex;
    flex: 0 0 auto;
    color: var(--text-subtle);
    font-size: 0.95rem;
  }
  .search-icon :global(svg) {
    display: block;
  }

  .search {
    flex: 1 1 auto;
    min-width: 0;
    border: none;
    background: transparent;
    color: var(--text);
    font: inherit;
    font-size: 0.8125rem;
    padding: 0.55rem 0.7rem 0.55rem 0;
    outline: none;
  }
  .search::placeholder {
    color: var(--text-subtle);
  }

  /* The switcher's chip, since it is the same promise. */
  .scope-chip {
    flex: 0 0 auto;
    max-width: 9rem;
    overflow: hidden;
    margin-right: 0.5rem;
    padding: 0.1rem 0.4rem;
    border: 1px solid transparent;
    border-radius: 999px;
    background: transparent;
    color: var(--text-subtle);
    font: inherit;
    font-size: 0.6875rem;
    white-space: nowrap;
    text-overflow: ellipsis;
    cursor: pointer;
  }

  .scope-chip:hover,
  .scope-chip:focus-visible {
    border-color: var(--border);
    color: var(--text-muted);
    outline: none;
  }

  .scope-chip.wide {
    color: var(--accent-ink);
    border-color: var(--accent-soft);
    background: var(--accent-soft);
  }

  /* Capped and scrolled: one as tall as the workspace would cover the sentence. */
  .results {
    flex: 1 1 auto;
    min-height: 0;
    max-height: 14rem;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 0.3rem;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .result {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.35rem 0.45rem;
    border: none;
    border-radius: var(--radius);
    background: transparent;
    color: var(--text);
    font: inherit;
    text-align: left;
    cursor: pointer;
    scroll-margin: 0.3rem 0;
  }

  .result.active {
    background: var(--accent);
    color: var(--on-accent);
  }
  .result:focus-visible {
    outline: none;
  }
  .result.active .result-icon,
  .result.active .result-path {
    color: var(--on-accent);
  }
  .result.active .result-path {
    opacity: 0.85;
  }

  .result-icon {
    display: inline-flex;
    flex: 0 0 auto;
    font-size: 0.9375rem;
    color: var(--accent);
    transform: translateY(-1px);
  }
  .result-icon :global(svg) {
    display: block;
  }

  .result-text {
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
    min-width: 0;
  }

  .result-title {
    flex: 0 1 auto;
    font-size: 0.8125rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .result-path {
    flex: 0 1 auto;
    color: var(--text-subtle);
    font-size: 0.6875rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .hit {
    font-weight: 700;
  }

  .empty {
    padding: 0.9rem 0.75rem;
    text-align: center;
  }

  .empty-title {
    margin: 0;
    font-size: 0.8125rem;
    color: var(--text-muted);
  }

  .empty-hint {
    margin: 0.3rem 0 0;
    font-size: 0.75rem;
    color: var(--text-subtle);
  }

  /* Tab is the only way to reach another context. */
  .hint {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin: 0;
    padding: 0.35rem 0.7rem;
    border-top: 1px solid var(--border);
    font-size: 0.6875rem;
    color: var(--text-subtle);
  }

  .hint kbd {
    flex: 0 0 auto;
    padding: 0.05rem 0.3rem;
    border: 1px solid var(--border);
    border-radius: calc(var(--radius) * 0.75);
    font: inherit;
    font-size: 0.625rem;
    color: var(--text-muted);
  }

  .hint span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
