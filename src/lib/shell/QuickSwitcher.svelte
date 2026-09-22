<script lang="ts">
  import Icon from "./Icon.svelte";
  import type { Context, PageId, PageSummary } from "$lib/types";
  import { subtreeIds } from "$lib/page/tree";
  import type { ContentMatch, Segment } from "$lib/storage/store";
  import {
    rankPages,
    titleOf,
    pathOf,
    MIN_QUERY_CHARS,
    type TitleMatch,
  } from "$lib/search";
  import {
    settings,
    formatShortcut,
    contextShortcut,
    SETTINGS_SHORTCUT,
    type Theme,
  } from "$lib/state/settings.svelte";
  import { dictation } from "$lib/state/dictation.svelte";

  interface Props {
    pages: PageSummary[];
    searchContent: (
      query: string,
      limit: number,
      only?: readonly PageId[],
    ) => Promise<ContentMatch[]>;
    chrootId: string | null;
    activeContext: string;
    contexts: Context[];
    onSwitchContext: (name: string) => void;
    onSelect: (id: string) => void;
    onClose: () => void;
    activeId: string | null;
    activeLocked: boolean;
    onToggleLock: () => void;
    onChroot: (id: string | null) => void;
    onDeletePage: (id: string, anchor: HTMLElement | null) => void;
    onOpenSettings: () => void;
    onOpenTrash: () => void;
  }

  let {
    pages,
    searchContent,
    chrootId,
    activeContext,
    contexts,
    onSwitchContext,
    onSelect,
    onClose,
    activeId,
    activeLocked,
    onToggleLock,
    onChroot,
    onDeletePage,
    onOpenSettings,
    onOpenTrash,
  }: Props = $props();

  const TITLE_LIMIT = 50;
  const CONTENT_LIMIT = 20;

  const THEME_MODES: { id: Theme; label: string }[] = [
    { id: "light", label: "Light theme" },
    { id: "dark", label: "Dark theme" },
    { id: "system", label: "System theme" },
  ];

  const SEARCH_DEBOUNCE_MS = 90;

  let query = $state("");
  let activeIndex = $state(0);

  let allContexts = $state(false);

  let multiContext = $derived(pages.some((p) => p.context !== activeContext));

  let scopedPages = $derived(
    allContexts ? pages : pages.filter((p) => p.context === activeContext),
  );
  let input = $state<HTMLInputElement>();
  let listEl = $state<HTMLElement>();

  let backdropEl = $state<HTMLElement>();

  let root = $derived(chrootId ? (pages.find((p) => p.id === chrootId) ?? null) : null);

  let inRoot = $derived(root ? subtreeIds(scopedPages, root.id) : null);

  let titleMatches = $derived(
    rankPages(scopedPages, query, TITLE_LIMIT, root?.id ?? null),
  );

  let contentMatches = $state<ContentMatch[]>([]);

  $effect(() => {
    const q = query.trim();
    const shown = new Set(titleMatches.map((m) => m.page.id));
    if (q.length < MIN_QUERY_CHARS) {
      contentMatches = [];
      return;
    }

    // Narrowed before the limit, or pages already listed by title, or in another context, would
    // take up the slots.
    const candidates = scopedPages.map((p) => p.id).filter((id) => !shown.has(id));
    let live = true;
    const timer = setTimeout(async () => {
      const hits = await searchContent(q, CONTENT_LIMIT, candidates);
      if (!live || query.trim() !== q) return;
      contentMatches = hits;
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  });

  let byId = $derived(new Map(pages.map((p) => [p.id, p])));

  type CommandIcon =
    "chroot" | "lock" | "trash" | "mic" | "settings" | "context" | "theme";

  interface Row {
    id: string;
    title: Segment[];
    path?: Segment[];
    snippet?: Segment[];
    icon?: CommandIcon;
    theme?: Theme;
    keyHint?: string;
    danger?: boolean;
    run?: () => void;
  }

  function commandRank(label: string, q: string): number | null {
    const at = label.toLowerCase().indexOf(q);
    if (at < 0) return null;

    const startsWord = at === 0 || /\s/.test(label[at - 1]);
    return (startsWord ? 0 : 1000) + at;
  }

  let rooted = $derived(chrootId !== null);

  let contextRows: Row[] = $derived.by(() => {
    const q = query.trim().toLowerCase();
    if (q.length < MIN_QUERY_CHARS) return [];
    const found: { row: Row; rank: number }[] = [];
    for (const [i, context] of contexts.entries()) {
      if (context.name === activeContext) continue;
      const rank = commandRank(context.name, q);
      if (rank === null) continue;
      found.push({
        row: {
          id: `ctx:${context.name}`,
          title: [{ text: context.name, hit: false }],
          path: [
            {
              text: `${context.pages} ${context.pages === 1 ? "page" : "pages"}`,
              hit: false,
            },
          ],
          icon: "context",
          keyHint: i < 9 ? formatShortcut(contextShortcut(i + 1)) : "",
          run: () => onSwitchContext(context.name),
        },
        rank,
      });
    }
    return found.sort((a, b) => a.rank - b.rank).map((entry) => entry.row);
  });

  let commandRows: Row[] = $derived.by(() => {
    const q = query.trim().toLowerCase();
    if (q.length < MIN_QUERY_CHARS) return [];

    const found: { row: Row; rank: number; seq: number }[] = [];

    const add = (row: Row, label: string, ...also: string[]) => {
      let rank: number | null = null;
      for (const term of [label, ...also]) {
        const at = commandRank(term, q);
        if (at !== null && (rank === null || at < rank)) rank = at;
      }
      if (rank !== null) found.push({ row, rank, seq: found.length });
    };

    if (activeId) {
      const chrootLabel = rooted ? "Un-chroot" : "Chroot";
      add(
        {
          id: "cmd:chroot",
          title: [{ text: chrootLabel, hit: false }],
          icon: "chroot",
          keyHint: formatShortcut(settings.chrootShortcut),
          run: () => onChroot(rooted ? null : activeId),
        },
        chrootLabel,
      );

      const lockLabel = activeLocked ? "Unlock page" : "Lock page";
      add(
        {
          id: "cmd:lock",
          title: [{ text: lockLabel, hit: false }],
          icon: "lock",
          keyHint: formatShortcut(settings.lockShortcut),
          run: onToggleLock,
        },
        lockLabel,
      );

      add(
        {
          id: "cmd:trash-page",
          title: [{ text: "Move to Trash", hit: false }],
          icon: "trash",
          keyHint: formatShortcut(settings.trashPageShortcut),
          danger: true,
          run: () => onDeletePage(activeId, null),
        },
        "Move to Trash",
      );

      if (dictation.offered && !activeLocked && !dictation.busy) {
        const dictateLabel = dictation.recording ? "Stop dictating" : "Dictate";
        add(
          {
            id: "cmd:dictate",
            title: [{ text: dictateLabel, hit: false }],
            icon: "mic",
            keyHint: formatShortcut(settings.dictateShortcut),
            run: () => void dictation.begin(),
          },
          dictateLabel,
        );
      }
    }

    add(
      {
        id: "cmd:settings",
        title: [{ text: "Open Settings", hit: false }],
        icon: "settings",
        keyHint: formatShortcut(SETTINGS_SHORTCUT),
        run: onOpenSettings,
      },
      "Open Settings",
    );
    add(
      {
        id: "cmd:trash",
        title: [{ text: "Open Trash", hit: false }],
        icon: "trash",
        keyHint: formatShortcut(settings.openTrashShortcut),
        run: onOpenTrash,
      },
      "Open Trash",
    );

    for (const mode of THEME_MODES) {
      if (settings.theme === mode.id) continue;
      add(
        {
          id: `cmd:theme-${mode.id}`,
          title: [{ text: mode.label, hit: false }],
          icon: "theme",
          theme: mode.id,
          keyHint:
            mode.id === (settings.isDarkTheme ? "light" : "dark")
              ? formatShortcut(settings.toggleThemeShortcut)
              : "",
          run: () => settings.setTheme(mode.id),
        },
        mode.label,
        "Appearance",
      );
    }

    return found
      .sort((a, b) => a.rank - b.rank || a.seq - b.seq)
      .map((entry) => entry.row);
  });

  let titleRows: Row[] = $derived(
    titleMatches.map((m: TitleMatch) => ({
      id: m.page.id,
      title: m.title,
      path: m.path,
    })),
  );
  let rootTitleCount = $derived(titleMatches.filter((m) => m.inRoot).length);
  let rootTitleRows: Row[] = $derived(titleRows.slice(0, rootTitleCount));
  let otherTitleRows: Row[] = $derived(titleRows.slice(rootTitleCount));

  let contentRows: Row[] = $derived.by(() => {
    const hits = inRoot
      ? [
          ...contentMatches.filter((h) => inRoot.has(h.id)),
          ...contentMatches.filter((h) => !inRoot.has(h.id)),
        ]
      : contentMatches;
    return hits.flatMap((hit) => {
      const page = byId.get(hit.id);

      if (!page) return [];
      return [
        {
          id: hit.id,
          title: [{ text: titleOf(page), hit: false }],
          path: [{ text: pathOf(page, byId, { withContext: allContexts }), hit: false }],
          snippet: hit.snippet,
        },
      ];
    });
  });

  let elsewhereCount = $derived(
    allContexts || !multiContext || query.trim().length === 0
      ? 0
      : rankPages(
          pages.filter((p) => p.context !== activeContext),
          query,
          TITLE_LIMIT,
          null,
        ).length,
  );

  let rows: Row[] = $derived([
    ...commandRows,
    ...contextRows,
    ...titleRows,
    ...contentRows,
  ]);

  const rowDomId = (i: number) => `qs-row-${i}`;

  let contextsOffset = $derived(commandRows.length);

  let pagesOffset = $derived(contextsOffset + contextRows.length);

  $effect(() => {
    query;
    activeIndex = 0;
  });
  $effect(() => {
    if (activeIndex > rows.length - 1) activeIndex = Math.max(0, rows.length - 1);
  });

  $effect(() => {
    input?.focus();
    const reclaim = (event: FocusEvent) => {
      const target = event.target as Node | null;
      if (!input || !target || backdropEl?.contains(target)) return;
      input.focus();
    };
    document.addEventListener("focusin", reclaim);
    return () => document.removeEventListener("focusin", reclaim);
  });

  $effect(() => {
    listEl
      ?.querySelector(`[data-i="${activeIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  });

  function choose(i: number): void {
    const row = rows[i];
    if (!row) return;

    if (row.run) {
      row.run();
      onClose();
    } else {
      onSelect(row.id);
    }
  }

  function toggleScope(): void {
    if (!multiContext) return;
    allContexts = !allContexts;
    activeIndex = 0;
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "Tab") {
      e.preventDefault();
      toggleScope();
      input?.focus();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      activeIndex = Math.min(activeIndex + 1, rows.length - 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      activeIndex = Math.max(activeIndex - 1, 0);
    } else if (e.key === "Home" && rows.length > 0) {
      e.preventDefault();
      activeIndex = 0;
    } else if (e.key === "End" && rows.length > 0) {
      e.preventDefault();
      activeIndex = rows.length - 1;
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(activeIndex);
    }
  }
</script>

{#snippet results(list: Row[], offset: number, kind: "title" | "command" | "context")}
  {#each list as row, i (row.id)}
    {@const index = offset + i}
    <button
      type="button"
      class="result"
      class:command={kind === "command"}
      class:active={index === activeIndex}
      class:danger={row.danger}
      id={rowDomId(index)}
      role="option"
      aria-selected={index === activeIndex}
      data-i={index}
      data-testid="{kind}-result"
      onclick={() => choose(index)}
      onmousemove={() => (activeIndex = index)}
    >
      <span class="result-icon">
        {#if row.icon === "chroot"}
          <Icon name={rooted ? "unchroot" : "chroot"} />
        {:else if row.icon === "lock"}
          <Icon name={activeLocked ? "lock-open" : "lock"} />
        {:else if row.icon === "theme"}
          <Icon name={`theme-${row.theme ?? "system"}`} />
        {:else if row.icon}
          <Icon name={row.icon} />
        {:else}
          <Icon name="page" />
        {/if}
      </span>
      <span class="result-text">
        <span class="result-title">
          {#each row.title as seg}<span class:hit={seg.hit}>{seg.text}</span>{/each}
        </span>
        {#if row.path && row.path.some((s) => s.text)}
          <span class="result-path">
            {#each row.path as seg}<span class:hit={seg.hit}>{seg.text}</span>{/each}
          </span>
        {/if}
      </span>
      {#if row.keyHint}
        <span class="result-key">{row.keyHint}</span>
      {/if}
    </button>
  {/each}
{/snippet}

<div
  class="backdrop"
  bind:this={backdropEl}
  onmousedown={onClose}
  onkeydown={onKeydown}
  role="presentation"
>
  <div
    class="panel"
    onmousedown={(e) => e.stopPropagation()}
    role="dialog"
    aria-modal="true"
    tabindex="-1"
    aria-label="Quick switcher"
  >
    <div class="search-row">
      <span class="search-icon"><Icon name="search" /></span>
      <input
        bind:this={input}
        bind:value={query}
        class="search"
        type="text"
        placeholder="Search pages, text, and commands…"
        spellcheck="false"
        autocomplete="off"
        aria-label="Search pages, text, and commands"
        aria-controls="qs-results"
        aria-activedescendant={rows.length > 0 ? rowDomId(activeIndex) : undefined}
      />
      {#if multiContext}
        <button
          type="button"
          class="scope-chip"
          class:wide={allContexts}
          title={allContexts
            ? "Searching all contexts. Tab or click to search only “" +
              activeContext +
              "”"
            : "Searching “" + activeContext + "”. Tab or click to search all contexts"}
          onclick={() => {
            toggleScope();
            // Hand the caret straight back; the panel's `focusin` reclaim leaves focus alone inside
            // it.
            input?.focus();
          }}
          data-testid="scope-chip"
        >
          {allContexts ? "All contexts" : activeContext}
        </button>
      {/if}
    </div>
    <div
      class="results"
      bind:this={listEl}
      id="qs-results"
      role="listbox"
      aria-label="Results"
      data-testid="switcher-results"
    >
      {#if commandRows.length > 0}
        <p class="section" data-testid="section-commands">Commands</p>
        {@render results(commandRows, 0, "command")}
      {/if}

      {#if contextRows.length > 0}
        <p class="section" data-testid="section-contexts">Contexts</p>
        {@render results(contextRows, contextsOffset, "context")}
      {/if}

      {#if root}
        {#if rootTitleRows.length > 0}
          <p class="section" data-testid="section-in-root">Pages in {titleOf(root)}</p>
          {@render results(rootTitleRows, pagesOffset, "title")}
        {/if}
        {#if otherTitleRows.length > 0}
          <p class="section" data-testid="section-outside-root">
            Pages outside {titleOf(root)}
          </p>
          {@render results(otherTitleRows, pagesOffset + rootTitleCount, "title")}
        {/if}
      {:else if titleRows.length > 0}
        <p class="section" data-testid="section-pages">Pages</p>
        {@render results(titleRows, pagesOffset, "title")}
      {/if}

      {#if contentRows.length > 0}
        <p class="section" data-testid="section-content">Content</p>
        {#each contentRows as row, i (row.id)}
          {@const index = pagesOffset + titleRows.length + i}
          <button
            type="button"
            class="result stacked"
            class:active={index === activeIndex}
            id={rowDomId(index)}
            role="option"
            aria-selected={index === activeIndex}
            data-i={index}
            data-testid="content-result"
            onclick={() => choose(index)}
            onmousemove={() => (activeIndex = index)}
          >
            <span class="result-icon"><Icon name="page" /></span>
            <span class="result-text stacked-text">
              <span class="result-head">
                <span class="result-title">
                  {#each row.title as seg}{seg.text}{/each}
                </span>
                {#if row.path && row.path.some((s) => s.text)}
                  <span class="result-path">
                    {#each row.path as seg}{seg.text}{/each}
                  </span>
                {/if}
              </span>
              <span class="result-snippet" data-testid="snippet">
                {#each row.snippet ?? [] as seg}<span class:hit={seg.hit}>{seg.text}</span
                  >{/each}
              </span>
            </span>
          </button>
        {/each}
      {/if}

      {#if rows.length === 0}
        <div class="empty">
          <span class="empty-icon"><Icon name="search" /></span>
          {#if query.trim()}
            <p class="empty-title">No results for “{query.trim()}”</p>
            <p class="empty-hint">
              {#if allContexts}
                Searched page titles, page text, and commands, in every context.
              {:else}
                Searched page titles, page text, and commands in “{activeContext}”.
              {/if}
            </p>
            {#if !allContexts && multiContext}
              <p class="empty-hint" data-testid="empty-widen">
                {elsewhereCount > 0
                  ? `${elsewhereCount} ${elsewhereCount === 1 ? "page matches" : "pages match"} by title elsewhere. Press Tab to search all contexts.`
                  : "Press Tab to search all contexts."}
              </p>
            {/if}
          {:else}
            <p class="empty-title">No pages yet</p>
            <p class="empty-hint">Pages you create will show up here.</p>
          {/if}
        </div>
      {/if}
    </div>

    <!-- Only worth a line when there is somewhere else to look. -->
    {#if multiContext}
      <p class="hints" data-testid="switcher-tab-hint">
        <kbd>Tab</kbd>
        <span>
          {allContexts ? `Search only “${activeContext}”` : "Search all contexts"}
        </span>
      </p>
    {/if}
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 120;
    display: flex;

    align-items: flex-start;
    justify-content: center;
    padding: min(14vh, 140px) 1rem 1rem;
    background: oklch(0% 0 0 / 0.45);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
  }

  .panel {
    --qs-bar: var(--scrollbar-size);

    width: min(640px, calc(100vw - 2rem));

    height: min(60vh, 520px);
    display: flex;
    flex-direction: column;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: calc(var(--radius) * 2);
    box-shadow: var(--shadow-pop);
    overflow: hidden;
  }

  .search-row {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 0.65rem;

    padding-left: 1.1rem;
    border-bottom: 1px solid var(--border);

    overflow: hidden;
  }

  .scope-chip {
    flex: 0 0 auto;
    max-width: 11rem;
    overflow: hidden;
    margin-right: 0.85rem;
    padding: 0.15rem 0.45rem;
    border: 1px solid transparent;
    border-radius: 999px;
    background: transparent;
    color: var(--text-subtle);
    font: inherit;
    font-size: 0.75rem;
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

  .search-icon {
    display: inline-flex;
    flex: 0 0 auto;
    color: var(--text-subtle);
    font-size: 1.05rem;
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
    font-size: 1.05rem;
    padding: 0.95rem 1rem 0.95rem 0;
    outline: none;
  }
  .search::placeholder {
    color: var(--text-subtle);
  }

  .results {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;

    padding: 0.35rem 0.5rem 0.5rem;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .search-row,
  .results {
    scrollbar-gutter: stable both-edges;
  }

  @supports not (scrollbar-gutter: stable) {
    .results {
      overflow-y: scroll;
      padding-left: calc(0.5rem + var(--qs-bar));
    }
    .search-row {
      padding-left: calc(1.1rem + var(--qs-bar));
    }
  }

  .section {
    flex: 0 0 auto;
    margin: 0.85rem 0 0.2rem;

    padding: 0 0.65rem 0 2.3rem;
    font-size: 0.6875rem;
    font-weight: 600;
    letter-spacing: 0.075em;
    text-transform: uppercase;
    color: var(--text-subtle);

    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .section:first-child {
    margin-top: 0.2rem;
  }

  .result {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 0.65rem;
    width: 100%;
    padding: 0.5rem 0.65rem;
    border: none;
    border-radius: var(--radius);
    background: transparent;
    color: var(--text);
    text-align: left;
    cursor: pointer;

    scroll-margin: 1.75rem 0 0.5rem;
  }

  .result.active {
    background: var(--accent);
    color: var(--on-accent);
  }

  .result:focus-visible {
    outline: none;
  }
  .result.active .result-icon {
    color: var(--on-accent);
  }

  .result.active .result-path,
  .result.active .result-key,
  .result.active .result-snippet {
    color: color-mix(in oklab, var(--on-accent) 88%, transparent);
    opacity: 1;
  }

  .result.stacked {
    align-items: flex-start;
    padding-top: 0.45rem;
    padding-bottom: 0.5rem;
  }

  .result-icon {
    display: inline-flex;
    flex: 0 0 auto;
    font-size: 1rem;

    color: var(--accent);

    transform: translateY(-1px);
  }
  .result.stacked .result-icon {
    transform: translateY(2px);
  }
  .result-icon :global(svg) {
    display: block;
  }

  .result.command:not(.active) .result-icon {
    color: var(--text-muted);
  }

  .result.danger:not(.active) .result-icon {
    color: var(--danger);
  }
  .result.danger.active {
    background: var(--danger);
    color: oklch(100% 0 0);
  }
  .result.danger.active .result-icon,
  .result.danger.active .result-key {
    color: oklch(100% 0 0);
  }
  .result.danger.active .result-key {
    opacity: 0.88;
  }

  .result-text {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    min-width: 0;
    flex: 1 1 auto;
  }
  .stacked-text {
    flex-direction: column;
    align-items: stretch;
    gap: 0.15rem;
  }

  .result-head {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    min-width: 0;
  }

  .result-title {
    flex: 0 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.9375rem;
    line-height: 1.35;
  }

  .result-path {
    flex: 0 8 auto;

    max-width: 42%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.78rem;
    color: var(--text-muted);
  }

  .result-snippet {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.8125rem;
    line-height: 1.45;
    color: var(--text-muted);
  }

  .result-key {
    flex: 0 0 auto;
    padding-left: 0.75rem;
    color: var(--text-subtle);
    font-size: 0.75rem;
    font-variant-numeric: tabular-nums;
  }

  .hit {
    color: var(--accent);
    font-weight: 650;
  }
  .result-snippet .hit {
    background: var(--accent-soft);
    color: var(--accent-ink);
    border-radius: 3px;
    padding: 0.05em 0.15em;

    margin: 0 -0.05em;
  }

  .result.active .hit {
    color: var(--on-accent);
  }
  .result.active .result-snippet .hit {
    background: transparent;
    color: var(--on-accent);
  }
  .result.danger.active .hit {
    color: oklch(100% 0 0);
  }

  .empty {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.15rem;
    padding: 1rem 1.5rem 2.5rem;
    text-align: center;
  }
  .empty-icon {
    display: inline-flex;
    margin-bottom: 0.6rem;
    font-size: 1.5rem;
    color: var(--text-subtle);
    opacity: 0.55;
  }
  .empty-icon :global(svg) {
    display: block;
  }
  .empty-title {
    margin: 0;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.9375rem;
    color: var(--text);
  }
  .hints {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 0.45rem;
    margin: 0;
    padding: 0.4rem 1.1rem;
    border-top: 1px solid var(--border);
    font-size: 0.75rem;
    color: var(--text-subtle);
  }

  .hints kbd {
    flex: 0 0 auto;
    padding: 0.05rem 0.35rem;
    border: 1px solid var(--border);
    border-radius: calc(var(--radius) * 0.75);
    font: inherit;
    font-size: 0.6875rem;
    color: var(--text-muted);
  }

  .hints span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .empty-hint {
    margin: 0;
    font-size: 0.8125rem;
    color: var(--text-muted);
  }

  @media (prefers-reduced-motion: no-preference) {
    .backdrop {
      animation: switcher-fade 110ms ease-out;
    }
    .panel {
      animation: switcher-rise 130ms cubic-bezier(0.2, 0.7, 0.3, 1);
    }
  }
  @keyframes switcher-fade {
    from {
      opacity: 0;
    }
  }
  @keyframes switcher-rise {
    from {
      opacity: 0;
      transform: translateY(-8px) scale(0.985);
    }
  }
</style>
