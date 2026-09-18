<script lang="ts">
  import type { SlashItem } from "./slash-commands";
  import type { MenuState } from "./suggestion-menu.svelte";
  import Icon from "$lib/shell/Icon.svelte";

  let { menu }: { menu: MenuState<SlashItem> } = $props();

  let selected = $state(0);
  let listEl = $state<HTMLDivElement>();

  $effect(() => {
    if (selected >= menu.items.length) selected = 0;
  });

  $effect(() => {
    const el = listEl?.querySelector<HTMLElement>(`[data-index="${selected}"]`);
    el?.scrollIntoView({ block: "nearest" });
  });

  function choose(index: number) {
    const item = menu.items[index];
    if (item) menu.command(item);
  }

  export function onKeyDown(event: KeyboardEvent): boolean {
    const count = menu.items.length;
    if (count === 0) return false;
    if (event.key === "ArrowDown") {
      selected = (selected + 1) % count;
      return true;
    }
    if (event.key === "ArrowUp") {
      selected = (selected - 1 + count) % count;
      return true;
    }
    if (event.key === "Enter") {
      choose(selected);
      return true;
    }
    return false;
  }
</script>

{#if menu.rect}
  <div
    class="slash-menu"
    bind:this={listEl}
    style="top: {menu.rect.bottom + 6}px; left: {menu.rect.left}px;"
  >
    {#if menu.items.length === 0}
      <p class="empty">No matching blocks</p>
    {:else}
      {#each menu.items as item, i (item.title)}
        <button
          class="item"
          class:active={i === selected}
          data-index={i}
          onmousedown={(e) => e.preventDefault()}
          onclick={() => choose(i)}
          onmousemove={() => (selected = i)}
        >
          <span class="icon"><Icon name={item.icon} /></span>
          <span class="text">
            <span class="title">{item.title}</span>
            <span class="subtitle">{item.subtitle}</span>
          </span>
        </button>
      {/each}
    {/if}
  </div>
{/if}

<style>
  .slash-menu {
    position: fixed;
    z-index: 50;
    width: 268px;
    max-height: 320px;
    overflow-y: auto;
    padding: 0.25rem;

    background: linear-gradient(var(--surface-tint), var(--surface-tint)), var(--bg);
    border: 1px solid var(--border);
    border-radius: 10px;
    box-shadow:
      0 4px 12px oklch(0% 0 0 / 0.08),
      0 12px 32px oklch(0% 0 0 / 0.12);
  }

  .empty {
    margin: 0;
    padding: 0.5rem 0.6rem;
    color: var(--text-subtle);
    font-size: 0.85rem;
  }

  .item {
    display: flex;
    align-items: center;
    gap: 0.65rem;
    width: 100%;
    padding: 0.4rem 0.55rem;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--text);
    text-align: left;
    cursor: pointer;
  }

  .item.active {
    background-color: var(--accent-soft);
  }

  .item.active .icon {
    color: var(--accent-ink);
  }
  .item.active .subtitle {
    color: var(--text-muted);
  }

  .icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    width: 22px;
    height: 22px;
    color: var(--accent);
    font-size: 18px;
  }

  .text {
    display: flex;
    flex-direction: column;
    min-width: 0;
    line-height: 1.25;
  }

  .title {
    font-size: 0.875rem;
    font-weight: 500;
  }

  .subtitle {
    font-size: 0.75rem;
    color: var(--text-subtle);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
