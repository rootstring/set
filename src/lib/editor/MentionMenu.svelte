<script lang="ts">
  import type { DateMenuItem } from "./date-format";
  import type { MenuState } from "./suggestion-menu.svelte";
  import Icon from "$lib/shell/Icon.svelte";

  let { menu }: { menu: MenuState<DateMenuItem> } = $props();

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
    class="mention-menu"
    bind:this={listEl}
    style="top: {menu.rect.bottom + 6}px; left: {menu.rect.left}px;"
  >
    {#each menu.items as item, i (item.id)}
      <button
        class="item"
        class:active={i === selected}
        data-index={i}
        onmousedown={(e) => e.preventDefault()}
        onclick={() => choose(i)}
        onmousemove={() => (selected = i)}
      >
        <span class="icon"><Icon name="date" /></span>
        <span class="text">
          <span class="title">{item.label}</span>
          {#if item.sublabel}<span class="subtitle">{item.sublabel}</span>{/if}
        </span>
      </button>
    {/each}
  </div>
{/if}

<style>
  .mention-menu {
    position: fixed;
    z-index: 50;
    width: 220px;
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
    font-size: 17px;
  }

  .text {
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
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
