<script lang="ts">
  import { untrack } from "svelte";
  import Icon from "./Icon.svelte";
  import ContextSwitcher from "./ContextSwitcher.svelte";
  import type { Context, TrashEntry, TrashedPage } from "$lib/types";
  import { trashInContext } from "$lib/page/trash";
  import { askPermanent, confirms } from "$lib/state/confirm.svelte";

  interface Props {
    trash: TrashEntry[];
    contexts: Context[];
    activeContext: string;
    loadChildren: (entry: TrashEntry) => Promise<TrashedPage[]>;
    onRestore: (id: string, reveal: boolean) => void;
    onRestoreContext: (name: string) => void;
    onDeleteForever: (id: string) => void;
    onDeleteContextForever: (name: string) => void;
    onClearTrash: (context: string) => void;
    onClose: () => void;
  }

  let {
    trash,
    contexts,
    activeContext,
    loadChildren,
    onRestore,
    onRestoreContext,
    onDeleteForever,
    onDeleteContextForever,
    onClearTrash,
    onClose,
  }: Props = $props();

  // Stays where you take it, until that context goes away under it.
  let picked = $state<string | null>(null);

  const scope = $derived(
    picked && contexts.some((c) => c.name === picked) ? picked : activeContext,
  );

  const visible = $derived(trashInContext(trash, scope));

  const BRANCH_LIMIT = 50;

  let expanded = $state<string[]>([]);
  let loaded = $state<Record<string, TrashEntry[]>>({});

  let shown = $state<Record<string, number>>({});

  const isOpen = (key: string) => expanded.includes(key);

  function inside(entry: TrashEntry): number {
    return entry.kind === "page" ? entry.descendants : entry.pages;
  }

  async function toggle(entry: TrashEntry): Promise<void> {
    const key = keyOf(entry);
    if (isOpen(key)) {
      expanded = expanded.filter((k) => k !== key);
      return;
    }
    expanded = [...expanded, key];
    if (!loaded[key]) loaded = { ...loaded, [key]: await loadChildren(entry) };
  }

  $effect(() => {
    trash;
    untrack(() => void reload());
  });

  async function reload(): Promise<void> {
    const next: Record<string, TrashEntry[]> = {};
    const visit = async (list: TrashEntry[]): Promise<void> => {
      for (const entry of list) {
        const key = keyOf(entry);
        if (!isOpen(key)) continue;
        const kids = await loadChildren(entry);
        next[key] = kids;
        await visit(kids);
      }
    };
    await visit(trash);
    loaded = next;

    expanded = expanded.filter((key) => key in next);
  }

  function keyOf(entry: TrashEntry): string {
    return entry.kind === "page" ? `p:${entry.id}` : `c:${entry.name}`;
  }

  function title(entry: TrashEntry): string {
    return entry.kind === "page" ? entry.title.trim() || "Untitled" : entry.name;
  }

  function weight(entry: TrashEntry): number {
    return entry.kind === "page" ? entry.descendants + 1 : entry.pages;
  }

  function pages(n: number): string {
    return `${n} ${n === 1 ? "page" : "pages"}`;
  }

  function detail(entry: TrashEntry, depth: number): string {
    const held = inside(entry);
    if (depth > 0) return held > 0 ? `${pages(held)} inside` : "";
    const parts: string[] = [];
    const ago = when(entry.trashedAt);
    if (ago) parts.push(`Deleted ${ago}`);
    if (entry.kind === "context") {
      parts.push(entry.pages ? `context with ${pages(entry.pages)}` : "empty context");
    } else if (entry.descendants > 0) {
      parts.push(`${pages(entry.descendants)} inside`);
    }
    return parts.join(" · ");
  }

  function restoreHint(entry: TrashEntry, depth: number): string {
    if (depth === 0 || entry.kind !== "page") return "Restore";
    return `Restore to the top of “${entry.context}”`;
  }

  let total = $derived(visible.reduce((sum, entry) => sum + weight(entry), 0));

  /** Pages the scope is hiding: the reason an empty trash can look wrong. */
  let elsewhere = $derived.by(() => {
    const shown = new Set(visible);
    return trash.reduce((sum, entry) => sum + (shown.has(entry) ? 0 : weight(entry)), 0);
  });

  let deadContexts = $derived(visible.filter((entry) => entry.kind === "context").length);

  const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const DIVISIONS: [number, Intl.RelativeTimeFormatUnit][] = [
    [60, "seconds"],
    [60, "minutes"],
    [24, "hours"],
    [7, "days"],
    [4.34524, "weeks"],
    [12, "months"],
    [Number.POSITIVE_INFINITY, "years"],
  ];

  function when(trashedAt: number): string {
    if (!trashedAt) return "";
    let value = (trashedAt - Date.now()) / 1000;
    for (const [amount, unit] of DIVISIONS) {
      if (Math.abs(value) < amount) return relative.format(Math.round(value), unit);
      value /= amount;
    }
    return "";
  }

  function purgeMessage(entry: TrashEntry): string {
    const name = `“${title(entry)}”`;
    const inside = entry.kind === "context" ? entry.pages : entry.descendants;
    return inside > 0
      ? `${name} and the ${pages(inside)} in it are deleted for good.`
      : `${name} is deleted for good.`;
  }

  function clearMessage(): string {
    const parts: string[] = [];
    if (total > 0) parts.push(pages(total));
    if (deadContexts > 0) {
      parts.push(
        deadContexts === 1 ? "1 deleted context" : `${deadContexts} deleted contexts`,
      );
    }
    return `Deletes ${parts.length ? parts.join(" and ") : "everything here"} for good.`;
  }

  function purge(entry: TrashEntry, anchor: HTMLElement): void {
    askPermanent({
      anchor,
      title: "Delete forever",
      message: purgeMessage(entry),
      confirmLabel: "Delete forever",
      onConfirm: () => {
        if (entry.kind === "page") onDeleteForever(entry.id);
        else onDeleteContextForever(entry.name);
      },
    });
  }

  function clear(anchor: HTMLElement): void {
    askPermanent({
      anchor,
      title: "Empty trash",
      message: clearMessage(),
      confirmLabel: "Empty trash",
      onConfirm: () => onClearTrash(scope),
    });
  }

  function restore(entry: TrashEntry, depth: number): void {
    if (entry.kind === "page") onRestore(entry.id, depth === 0);
    else onRestoreContext(entry.name);
  }
</script>

<svelte:window onkeydown={(e) => e.key === "Escape" && !confirms.open && onClose()} />
<div class="backdrop">
  <div class="panel" role="dialog" aria-modal="true" aria-label="Trash">
    <header class="head">
      <h2 class="title">Trash</h2>
      <div class="scope">
        <ContextSwitcher
          {contexts}
          active={scope}
          onSwitch={(name) => (picked = name)}
          label="Trash for “{scope}”. Switch context"
          keys={false}
          compact
        />
      </div>
      <div class="head-actions">
        {#if visible.length > 0}
          <button
            class="control quiet head-btn danger"
            onclick={(e) => clear(e.currentTarget)}
          >
            Empty
          </button>
        {/if}
        <button
          class="control quiet head-btn close danger"
          onclick={onClose}
          aria-label="Close trash"><Icon name="close" /></button
        >
      </div>
    </header>
    {#if visible.length === 0}
      <p class="empty">
        {trash.length === 0 ? "Trash is empty." : `Nothing deleted in “${scope}”.`}
        {#if elsewhere > 0}
          <span class="empty-hint">
            {pages(elsewhere)}
            {elsewhere === 1 ? "is" : "are"} in the trash of another context.
          </span>
        {/if}
      </p>
    {:else}
      <ul class="list">
        {@render branch(visible, 0, "")}
      </ul>
    {/if}
  </div>
</div>
{#snippet branch(list: TrashEntry[], depth: number, key: string)}
  {@const limit = shown[key] ?? BRANCH_LIMIT}
  {#each list.slice(0, limit) as entry (keyOf(entry))}
    {@const rowKey = keyOf(entry)}
    {@const open = isOpen(rowKey)}
    {@const opens = inside(entry) > 0}
    <li>
      <div
        class="item"
        style="--depth: {Math.min(depth, 5)}"
        data-testid="trash-item"
        data-depth={depth}
      >
        {#if opens}
          <button
            class="twisty"
            class:open
            title={open ? "Collapse" : "Expand"}
            aria-expanded={open}
            aria-label="{open ? 'Collapse' : 'Expand'} “{title(entry)}”"
            onclick={() => void toggle(entry)}
          >
            <svg viewBox="0 0 16 16" width="1em" height="1em" aria-hidden="true">
              <path
                d="M6 4l4 4-4 4"
                fill="none"
                stroke="currentColor"
                stroke-width="1.6"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </button>
        {:else}
          <span class="twisty-spacer"></span>
        {/if}

        <span class="kind" aria-hidden="true">
          {#if entry.kind === "context"}<Icon name="context" />{:else}<Icon
              name="page"
            />{/if}
        </span>
        <div class="meta">
          <span class="name">{title(entry)}</span>
          {#if detail(entry, depth)}
            <span class="sub">{detail(entry, depth)}</span>
          {/if}
        </div>
        <div class="row-actions">
          <button
            class="control quiet icon-btn"
            title={restoreHint(entry, depth)}
            aria-label="Restore “{title(entry)}”"
            onclick={() => restore(entry, depth)}
          >
            <Icon name="restore" />
          </button>
          <button
            class="control quiet icon-btn danger"
            title="Delete forever"
            aria-label="Delete “{title(entry)}” forever"
            onclick={(e) => purge(entry, e.currentTarget)}
          >
            <Icon name="trash" />
          </button>
        </div>
      </div>
      {#if open && (loaded[rowKey]?.length ?? 0) > 0}
        <ul>
          {@render branch(loaded[rowKey], depth + 1, rowKey)}
        </ul>
      {/if}
    </li>
  {/each}
  {#if list.length > limit}
    <li class="more-row" style="--depth: {Math.min(depth, 5)}">
      <button
        class="control quiet more"
        onclick={() => (shown = { ...shown, [key]: limit + BRANCH_LIMIT })}
      >
        Show {list.length - limit} more
      </button>
    </li>
  {/if}
{/snippet}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 90;
    display: flex;
    align-items: center;
    justify-content: center;
    background: oklch(0% 0 0 / 0.45);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
  }

  .panel {
    width: min(460px, calc(100vw - 2rem));
    max-height: min(70vh, 640px);
    display: flex;
    flex-direction: column;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: calc(var(--radius) * 2);
    box-shadow: var(--shadow-pop);
  }

  .head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 1rem 1.25rem;
    border-bottom: 1px solid var(--border);
  }

  .title {
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
    color: var(--text);
  }

  .scope {
    display: flex;
    min-width: 0;
    margin-right: auto;
  }

  .head-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .head-btn {
    height: 1.75rem;
    font: inherit;
    font-size: 0.9rem;

    padding: 0 0.7rem;
  }
  .close {
    width: 1.75rem;
    padding: 0;
    font-size: 0.8rem;
  }

  .empty {
    margin: 0;
    padding: 2rem 1.25rem;
    text-align: center;
    color: var(--text-subtle);
    font-size: 0.9rem;
  }

  .empty-hint {
    display: block;
    margin-top: 0.35rem;
    font-size: 0.8rem;
    opacity: 0.8;
  }

  .list {
    list-style: none;
    margin: 0;
    padding: 0.5rem;
    overflow-y: auto;
  }

  .list :global(ul) {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  /* Laid out like a sidebar row (twisty, page icon, title) with the detail
     line tucked under the title, and the icon and twisty on the title's line. */
  .item {
    --line: 1.4rem;
    display: flex;
    align-items: flex-start;
    gap: 2px;
    padding: 0.35rem 0.6rem 0.35rem 0.3rem;
    border-radius: var(--radius);

    padding-left: calc(0.3rem + var(--depth) * 0.75rem);
  }
  .item:hover {
    background: var(--bg-hover);
  }

  .twisty,
  .twisty-spacer {
    flex: 0 0 auto;
    width: 18px;
    height: var(--line);
  }
  .twisty {
    display: flex;
    align-items: center;
    justify-content: center;
    border: none;
    background: transparent;
    padding: 0;
    color: var(--text-subtle);
    cursor: pointer;
    border-radius: var(--radius);
  }
  .twisty svg {
    transition: transform 0.12s ease;
  }
  .twisty.open svg {
    transform: rotate(90deg);
  }
  .twisty:hover {
    color: var(--text);
  }

  .more-row {
    padding-left: calc(0.3rem + var(--depth) * 0.75rem + 20px);
  }
  .more {
    font: inherit;
    font-size: 0.8rem;
    height: 1.6rem;
    padding: 0 0.5rem;
    color: var(--text-subtle);
  }

  .kind {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    height: var(--line);
    margin: 0 0.55rem 0 0.45rem;
    font-size: 1rem;
    color: var(--accent);
    transform: translateY(-1px);
  }
  .kind :global(svg) {
    display: block;
  }

  .meta {
    display: flex;
    flex-direction: column;
    min-width: 0;
    margin-right: auto;
  }
  .name {
    font-size: 0.9rem;
    line-height: var(--line);
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sub {
    font-size: 0.75rem;
    color: var(--text-subtle);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .row-actions {
    display: flex;
    gap: 0.4rem;
    flex: 0 0 auto;
    align-self: center;
  }

  .icon-btn {
    width: 28px;
    height: 28px;
    font-size: 16px;
  }
</style>
