<script lang="ts">
  import type { Context } from "$lib/types";
  import Icon from "./Icon.svelte";
  import { dismissible } from "./dismiss.svelte";
  import { dictation } from "$lib/state/dictation.svelte";
  import { settings, formatShortcut } from "$lib/state/settings.svelte";
  import { PAGE_LOCKED } from "$lib/page/lock";

  interface Props {
    pageId: string | null;
    locked: boolean;
    onToggleLock: () => void;
    chrootId: string | null;
    onChroot: (id: string | null) => void;
    contexts: Context[];
    pageContext: string;
    onMoveToContext: (id: string, context: string) => void;
    onDelete: (id: string, anchor: HTMLElement | null) => void;
  }

  let {
    pageId,
    locked,
    onToggleLock,
    chrootId,
    onChroot,
    contexts,
    pageContext,
    onMoveToContext,
    onDelete,
  }: Props = $props();

  let open = $state(false);
  let menuEl = $state<HTMLDivElement>();
  let buttonEl = $state<HTMLButtonElement>();

  let moving = $state(false);

  const destinations = $derived(contexts.filter((c) => c.name !== pageContext));

  function moveTo(name: string): void {
    close();
    if (pageId) onMoveToContext(pageId, name);
  }

  let moveItemEl = $state<HTMLButtonElement>();
  let targetEls = $state<(HTMLButtonElement | undefined)[]>([]);

  let enteredByKey = $state(false);

  function onMoveItemKeydown(event: KeyboardEvent): void {
    if (event.key === "ArrowLeft" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      enteredByKey = true;
      moving = true;
    } else if (event.key === "ArrowRight" || event.key === "Escape") {
      if (!moving) return;
      event.preventDefault();
      event.stopPropagation();
      moving = false;
    }
  }

  function onSubmenuKeydown(event: KeyboardEvent): void {
    const items = targetEls.filter((el): el is HTMLButtonElement => !!el);
    const at = items.findIndex((el) => el === document.activeElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = at + (event.key === "ArrowDown" ? 1 : -1);
      items[((next % items.length) + items.length) % items.length]?.focus();
    } else if (event.key === "ArrowRight" || event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      moving = false;
      moveItemEl?.focus();
    }
  }

  $effect(() => {
    if (moving && enteredByKey) targetEls.find((el) => el)?.focus();
    if (!moving) enteredByKey = false;
  });

  const rooted = $derived(chrootId !== null);

  function close(): void {
    open = false;
    moving = false;
  }

  function toggle(): void {
    open = !open;
  }

  function chroot(): void {
    close();
    if (rooted) onChroot(null);
    else if (pageId) onChroot(pageId);
  }

  function toggleLock(): void {
    close();
    onToggleLock();
  }

  function deletePage(): void {
    const anchor = buttonEl ?? null;
    close();
    if (pageId) onDelete(pageId, anchor);
  }

  function dictate(): void {
    close();
    void dictation.begin();
  }

  dismissible({
    isOpen: () => open,
    anchors: () => [menuEl, buttonEl],
    close,
  });

  $effect(() => {
    pageId;
    close();
  });
</script>

{#if pageId}
  <div class="page-menu">
    <button
      class="control quiet menu-btn"
      class:on={open}
      title="Page actions"
      aria-label="Page actions"
      aria-haspopup="menu"
      aria-expanded={open}
      bind:this={buttonEl}
      onclick={toggle}
      data-testid="page-menu"
    >
      <svg
        viewBox="0 0 16 16"
        width="16"
        height="16"
        fill="currentColor"
        aria-hidden="true"
      >
        <circle cx="3.5" cy="8" r="1.3" />
        <circle cx="8" cy="8" r="1.3" />
        <circle cx="12.5" cy="8" r="1.3" />
      </svg>
    </button>
    {#if open}
      <div class="menu" role="menu" bind:this={menuEl}>
        <button
          type="button"
          class="menu-item"
          role="menuitem"
          title={rooted ? "Change root to top context" : "Change root to this note"}
          onclick={chroot}
          data-testid="page-menu-chroot"
        >
          <span class="menu-icon">
            <Icon name={rooted ? "unchroot" : "chroot"} />
          </span>
          <span class="menu-label">{rooted ? "Un-chroot" : "Chroot"}</span>
          <span class="menu-key">{formatShortcut(settings.chrootShortcut)}</span>
        </button>
        <div class="separator" role="separator"></div>
        <button
          type="button"
          class="menu-item"
          role="menuitem"
          title={locked ? "Let this page be edited again" : "Make this page read-only"}
          onclick={toggleLock}
          data-testid="page-menu-lock"
        >
          <span class="menu-icon"><Icon name={locked ? "lock-open" : "lock"} /></span>
          <span class="menu-label">{locked ? "Unlock page" : "Lock page"}</span>
          <span class="menu-key">{formatShortcut(settings.lockShortcut)}</span>
        </button>
        {#if contexts.length > 1 && destinations.length > 0}
          <div
            class="submenu-host"
            role="none"
            onmouseenter={() => (moving = !locked)}
            onmouseleave={() => (moving = false)}
          >
            <button
              type="button"
              class="menu-item"
              class:submenu-open={moving}
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={moving}
              title={locked
                ? PAGE_LOCKED
                : "Move this page, and its subpages, to another context"}
              disabled={locked}
              bind:this={moveItemEl}
              onclick={() => (moving = true)}
              onkeydown={onMoveItemKeydown}
              data-testid="page-menu-move-context"
            >
              <span class="menu-icon">
                <svg
                  viewBox="0 0 16 16"
                  width="1em"
                  height="1em"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.4"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <path d="M2.5 5.5V3.2h4l1.2 1.6h5.8v8H2.5V9" />
                  <path d="M1 7.25h6" />
                  <path d="M5 5.25L7 7.25 5 9.25" />
                </svg>
              </span>
              <span class="menu-label">Move to context</span>
              <svg
                class="submenu-caret"
                viewBox="0 0 16 16"
                width="10"
                height="10"
                fill="none"
                stroke="currentColor"
                stroke-width="1.6"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path d="M6.5 4L10.5 8 6.5 12" />
              </svg>
            </button>
            {#if moving}
              <div class="submenu-bridge" role="none"></div>
              <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
              <div class="submenu" role="menu" tabindex="-1" onkeydown={onSubmenuKeydown}>
                {#each destinations as context, i (context.name)}
                  <button
                    type="button"
                    class="menu-item"
                    role="menuitem"
                    bind:this={targetEls[i]}
                    onclick={() => moveTo(context.name)}
                    data-testid="page-menu-move-target"
                  >
                    <span class="menu-label">{context.name}</span>
                    <span class="menu-count">{context.pages}</span>
                  </button>
                {/each}
              </div>
            {/if}
          </div>
        {/if}

        {#if dictation.offered}
          <div class="separator" role="separator"></div>
          <button
            type="button"
            class="menu-item"
            role="menuitem"
            title={locked ? PAGE_LOCKED : "Speak to transcribe into this page"}
            disabled={locked || dictation.busy}
            onclick={dictate}
            data-testid="page-menu-dictate"
          >
            <span class="menu-icon"><Icon name="mic" /></span>
            <span class="menu-label">
              {dictation.recording ? "Stop dictating" : "Dictate"}
            </span>
            <span class="menu-key">{formatShortcut(settings.dictateShortcut)}</span>
          </button>
        {/if}

        <div class="separator" role="separator"></div>
        <button
          type="button"
          class="menu-item danger"
          role="menuitem"
          title={locked ? PAGE_LOCKED : "Move this page to Trash"}
          disabled={locked}
          onclick={deletePage}
          data-testid="page-menu-delete"
        >
          <span class="menu-icon"><Icon name="trash" /></span>
          <span class="menu-label">Move to Trash</span>
          <span class="menu-key">
            {formatShortcut(settings.trashPageShortcut)}
          </span>
        </button>
      </div>
    {/if}
  </div>
{/if}

<style>
  .page-menu {
    position: absolute;
    top: 8px;
    right: calc(14px + var(--sbw, 0px));
    z-index: 40;
  }

  :global(html.tauri-macos) .page-menu {
    top: 46px;
  }

  :global(html.tauri-linux) .page-menu,
  :global(html.tauri-windows) .page-menu {
    top: calc(var(--titlebar-height) + 8px);
  }

  .menu-btn {
    width: 28px;
    height: 28px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--text-subtle);
  }

  .menu-btn.on {
    background: var(--accent-soft);
    color: var(--accent-ink);
  }

  .menu {
    position: absolute;
    top: calc(100% + 4px);
    right: 0;
    min-width: 176px;
    padding: 6px;
    background:
      linear-gradient(var(--surface-tint), var(--surface-tint)), var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: 0 8px 24px oklch(0% 0 0 / 0.24);
  }

  .separator {
    height: 1px;
    margin: 5px 2px;
    background: var(--border);
  }

  .menu-item {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    width: 100%;
    padding: 0.45rem 0.65rem;
    border: none;
    border-radius: calc(var(--radius) - 2px);
    background: transparent;
    color: var(--text);
    font: inherit;
    font-size: 0.8125rem;
    text-align: left;
    white-space: nowrap;
    cursor: pointer;
  }

  .menu-item:hover:not(:disabled),
  .menu-item:focus-visible:not(:disabled) {
    background: var(--accent);
    color: var(--on-accent);
    outline: none;
  }

  .menu-item:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .menu-item:hover:not(:disabled) .menu-icon,
  .menu-item:hover:not(:disabled) .menu-key,
  .menu-item:focus-visible:not(:disabled) .menu-icon,
  .menu-item:focus-visible:not(:disabled) .menu-key {
    color: var(--on-accent);
  }

  .menu-item:hover:not(:disabled) .menu-key {
    opacity: 0.75;
  }

  .menu-item.danger:hover:not(:disabled),
  .menu-item.danger:focus-visible:not(:disabled) {
    background: var(--danger);
    color: oklch(100% 0 0);
  }
  .menu-item.danger:hover:not(:disabled) .menu-icon,
  .menu-item.danger:hover:not(:disabled) .menu-key {
    color: oklch(100% 0 0);
  }

  .submenu-host {
    position: relative;
  }

  .menu-item.submenu-open:not(:disabled) {
    background: var(--accent);
    color: var(--on-accent);
  }
  .menu-item.submenu-open:not(:disabled) .menu-icon {
    color: var(--on-accent);
  }

  .submenu {
    position: absolute;
    top: -6px;
    right: calc(100% + 4px);
    min-width: 170px;
    max-width: 240px;

    max-height: min(60vh, 320px);
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 6px;
    background:
      linear-gradient(var(--surface-tint), var(--surface-tint)), var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: 0 8px 24px oklch(0% 0 0 / 0.24);
  }
  .submenu .menu-label {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .submenu-bridge {
    position: absolute;
    top: -6px;
    right: 100%;
    width: 6px;
    height: calc(100% + 12px);
  }

  .submenu .menu-count {
    flex: 0 0 auto;
    padding-left: 1rem;
    color: var(--text-subtle);
    font-size: 0.75rem;
    font-variant-numeric: tabular-nums;
  }
  .submenu .menu-item:hover .menu-count,
  .submenu .menu-item:focus-visible .menu-count {
    color: var(--on-accent);
    opacity: 0.75;
  }

  .submenu-caret {
    flex: 0 0 auto;
    margin-left: 1rem;
    color: var(--text-subtle);
  }
  .menu-item:hover:not(:disabled) .submenu-caret,
  .menu-item:focus-visible:not(:disabled) .submenu-caret,
  .menu-item.submenu-open:not(:disabled) .submenu-caret {
    color: var(--on-accent);
  }

  .menu-icon {
    display: inline-flex;
    flex: 0 0 auto;
    font-size: 0.9375rem;
    color: var(--text-subtle);
  }

  .menu-label {
    flex: 1 1 auto;
  }

  .menu-key {
    flex: 0 0 auto;
    padding-left: 1.5rem;
    color: var(--text-subtle);
    font-size: 0.75rem;

    font-variant-numeric: tabular-nums;
  }
</style>
