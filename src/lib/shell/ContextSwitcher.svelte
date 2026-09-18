<script lang="ts">
  import type { Context } from "$lib/types";
  import Icon from "./Icon.svelte";
  import { dismissible } from "./dismiss.svelte";
  import { contextShortcut, formatShortcut } from "$lib/state/settings.svelte";
  import { checkContextName } from "./context-name";

  interface Props {
    contexts: Context[];
    active: string;
    onSwitch: (name: string) => void;
    /** Left out where the menu only picks between contexts, as in the trash. */
    onCreate?: (name: string) => Promise<string | null>;
    onManage?: () => void;
    compact?: boolean;
    /** The ⌘1–9 (⌥⌘1–9 in a browser) hints, which only switch the context the app is actually in. */
    keys?: boolean;
    /** Says what the menu switches, where the name alone doesn't. */
    label?: string;
    switchedAt?: number;
  }

  let {
    contexts,
    active,
    onSwitch,
    onCreate,
    onManage,
    switchedAt = 0,
    compact = false,
    keys = true,
    label,
  }: Props = $props();

  let open = $state(false);
  let menuEl = $state<HTMLDivElement>();
  let buttonEl = $state<HTMLButtonElement>();

  let menuTop = $state(0);
  let menuLeft = $state(0);
  let menuWidth = $state(0);

  const MENU_MIN_WIDTH = 248;

  let naming = $state(false);
  let draft = $state("");
  let inputEl = $state<HTMLInputElement>();

  const verdict = $derived(
    checkContextName(
      draft,
      contexts.map((c) => c.name),
    ),
  );

  const KEYED = 9;

  let rowEls = $state<(HTMLButtonElement | undefined)[]>([]);

  function close(restoreFocus = false): void {
    open = false;
    naming = false;
    draft = "";

    if (restoreFocus) buttonEl?.focus();
  }

  function toggle(): void {
    if (open) {
      close();
      return;
    }
    const box = buttonEl?.getBoundingClientRect();

    menuTop = (box?.bottom ?? 0) + 6;
    menuLeft = box?.left ?? 0;

    menuWidth = Math.max(box?.width ?? 0, MENU_MIN_WIDTH);
    open = true;
  }

  function pick(name: string): void {
    close();
    if (name !== active) onSwitch(name);
  }

  function beginNaming(): void {
    naming = true;
    draft = "";
  }

  async function commitName(): Promise<void> {
    if (!verdict.ok || !onCreate) return;
    const wanted = verdict.name;
    close();

    await onCreate(wanted);
  }

  function onDraftKeydown(event: KeyboardEvent): void {
    if (event.key === "Enter") {
      event.preventDefault();
      void commitName();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      naming = false;
      draft = "";
    }

    event.stopPropagation();
  }

  $effect(() => {
    if (naming) inputEl?.focus();
  });

  function liveRows(): HTMLButtonElement[] {
    return rowEls.filter((el): el is HTMLButtonElement => !!el);
  }

  function focusRow(i: number): void {
    const rows = liveRows();
    if (rows.length === 0) return;
    rows[((i % rows.length) + rows.length) % rows.length]?.focus();
  }

  function currentRow(): number {
    return liveRows().findIndex((el) => el === document.activeElement);
  }

  function onMenuKeydown(event: KeyboardEvent): void {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusRow(currentRow() + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusRow(currentRow() - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusRow(0);
    } else if (event.key === "End") {
      event.preventDefault();
      focusRow(rowEls.length - 1);
    } else if (event.key === "Tab") {
      close();
    }
  }

  $effect(() => {
    if (!open || naming) return;
    const at = contexts.findIndex((c) => c.name === active);
    focusRow(at === -1 ? 0 : at);
  });

  let flashing = $state(false);
  $effect(() => {
    if (!switchedAt) return; // the initial value: nothing has switched yet
    switchedAt;
    flashing = true;
    const timer = setTimeout(() => (flashing = false), 900);
    return () => clearTimeout(timer);
  });

  dismissible({
    isOpen: () => open,
    anchors: () => [menuEl, buttonEl],
    close: () => close(),
    escape: (event) => {
      if (naming) return;

      // A dialog around us reads Escape as "close me" otherwise.
      event.stopPropagation();
      close(true);
    },
  });
</script>

<div class="switcher" class:compact>
  <button
    class="context-btn"
    class:on={open}
    class:flash={flashing}
    aria-haspopup="menu"
    aria-expanded={open}
    aria-label={label}
    bind:this={buttonEl}
    onclick={toggle}
    data-testid="context-switcher"
  >
    <span class="context-name">{active}</span>
    <svg
      class="caret"
      viewBox="0 0 16 16"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M4 6l4 4 4-4" />
    </svg>
  </button>
  {#if open}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      class="menu"
      role="menu"
      tabindex="-1"
      style="top: {menuTop}px; left: {menuLeft}px; width: {menuWidth}px"
      bind:this={menuEl}
      onkeydown={onMenuKeydown}
    >
      <div class="menu-list">
        {#each contexts as context, i (context.name)}
          <button
            type="button"
            class="menu-item"
            class:current={context.name === active}
            role="menuitemradio"
            aria-checked={context.name === active}
            bind:this={rowEls[i]}
            onclick={() => pick(context.name)}
            data-testid="context-option"
          >
            <span class="menu-tick" aria-hidden="true">
              {#if context.name === active}<Icon name="check" />{/if}
            </span>
            <span class="menu-label">{context.name}</span>
            {#if keys}
              <span class="menu-key">
                {i < KEYED ? formatShortcut(contextShortcut(i + 1)) : ""}
              </span>
            {/if}
          </button>
        {/each}
      </div>
      {#if onCreate || onManage}
        <div class="separator" role="separator"></div>
      {/if}
      {#if naming}
        <div class="menu-row">
          <span class="menu-tick" aria-hidden="true"><Icon name="plus" /></span>
          <input
            class="name-input"
            type="text"
            placeholder="Context name"
            aria-label="New context name"
            aria-invalid={!!verdict.error}
            aria-describedby="context-new-note"
            bind:value={draft}
            bind:this={inputEl}
            onkeydown={onDraftKeydown}
            data-testid="context-name-input"
          />
        </div>
        <p
          class="name-note"
          class:bad={!!verdict.error}
          id="context-new-note"
          role="status"
          data-testid="context-name-note"
        >
          {verdict.error ?? verdict.note ?? ""}
        </p>
      {:else if onCreate || onManage}
        <div class="menu-actions">
          {#if onCreate}
            <button
              type="button"
              class="menu-action"
              role="menuitem"
              title="New context"
              aria-label="New context"
              bind:this={rowEls[contexts.length]}
              onclick={beginNaming}
              data-testid="context-new"
            >
              <Icon name="plus" />
            </button>
          {/if}
          {#if onManage}
            <button
              type="button"
              class="menu-action"
              role="menuitem"
              title="Manage contexts"
              aria-label="Manage contexts"
              bind:this={rowEls[contexts.length + 1]}
              onclick={() => {
                close();
                onManage();
              }}
              data-testid="context-manage"
            >
              <Icon name="settings" />
            </button>
          {/if}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .switcher {
    position: relative;
    flex: 1 1 auto;
    min-width: 0;
  }
  .switcher.compact {
    flex: 0 1 auto;
    min-width: 5rem;
  }

  .context-btn {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    width: 100%;

    height: 26px;
    padding: 0 4px 0 6px;

    text-align: left;

    border: 1px solid transparent;
    border-radius: var(--radius);
    background: transparent;
    color: var(--text);
    font: inherit;
    font-size: 0.9375rem;
    font-weight: 600;
    letter-spacing: -0.01em;
    cursor: pointer;
  }

  .context-btn:hover,
  .context-btn:focus-visible {
    background: var(--accent);
    color: var(--on-accent);
    outline: none;
  }

  .context-btn.on,
  .context-btn.on:hover,
  .context-btn.on:focus-visible {
    background: var(--accent-soft);
    color: var(--accent-ink);
    outline: none;
  }

  .context-name {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .caret {
    flex: 0 0 auto;
    margin-left: auto;
    color: currentColor;
    opacity: 0.55;
  }
  .context-btn:hover .caret,
  .context-btn:focus-visible .caret,
  .context-btn.on .caret {
    opacity: 1;
  }

  .context-btn.flash {
    animation: context-flash 0.9s ease-out;
  }
  @keyframes context-flash {
    0%,
    60% {
      border-color: transparent;
      background: var(--accent-soft);
      color: var(--accent-ink);
    }
    100% {
      border-color: transparent;
      background: transparent;
      color: var(--text);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .context-btn.flash {
      animation: none;
    }
  }

  .menu {
    position: fixed;
    z-index: 50;

    padding: 5px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: calc(var(--radius) + 2px);

    box-shadow: var(--shadow-pop);
  }
  .menu:focus {
    outline: none;
  }

  .menu-list {
    display: flex;
    flex-direction: column;

    gap: 3px;
    max-height: calc(9 * 2rem + 8 * 3px);
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  .separator {
    height: 1px;
    margin: 5px 6px;
    background: var(--border);
  }

  .menu-item,
  .menu-row {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    width: 100%;

    min-height: 2rem;
    padding: 0.3rem 0.5rem;
    border: none;
    border-radius: var(--radius);
    background: transparent;
    color: var(--text);
    font: inherit;
    font-size: 0.8125rem;
    text-align: left;
    cursor: pointer;
  }

  .menu-item:hover,
  .menu-item:focus-visible {
    background: var(--accent-soft);
    outline: none;
  }

  .menu-item.current {
    background: var(--accent);
    color: var(--on-accent);
  }
  .menu-item.current .menu-label {
    font-weight: 600;
  }
  .menu-item.current .menu-key {
    color: var(--on-accent);
  }
  .menu-item.current .menu-key {
    opacity: 0.75;
  }

  .menu-item.current:hover,
  .menu-item.current:focus-visible {
    background: var(--accent);
    color: var(--on-accent);
  }
  .menu-item.current:hover .menu-key,
  .menu-item.current:focus-visible .menu-key {
    color: var(--on-accent);
  }

  .menu-tick {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    width: 1em;
    font-size: 0.875rem;
    color: var(--text-subtle);
  }

  .menu-item.current .menu-tick {
    color: var(--on-accent);
  }

  .menu-label {
    flex: 1 1 auto;

    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .menu-key {
    flex: 0 0 auto;
    min-width: 2rem;
    padding-left: 0.75rem;
    color: var(--text-subtle);
    font-size: 0.75rem;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  .menu-row {
    cursor: default;
  }

  .name-input {
    flex: 1 1 auto;
    min-width: 0;
    padding: 0;
    border: none;
    background: transparent;
    color: var(--text);
    font: inherit;
    font-size: 0.8125rem;
  }
  .name-input:focus {
    outline: none;
  }
  .name-input::placeholder {
    color: var(--text-subtle);
  }

  .name-note {
    min-height: 1.1rem;
    margin: 0;
    padding: 0 0.5rem 0.15rem calc(0.5rem + 1em + 0.55rem);
    color: var(--text-subtle);
    font-size: 0.6875rem;
    line-height: 1.1rem;
  }
  .name-note.bad {
    color: var(--danger);
  }

  .menu-actions {
    display: flex;
    gap: 4px;
  }
  .menu-action {
    flex: 1 1 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;

    min-height: 1.4rem;
    padding: 0.1rem 0.5rem;
    font-size: 0.75rem;
    border: none;
    border-radius: var(--radius);
    background: transparent;

    color: var(--text-muted);
    font: inherit;
    cursor: pointer;
  }

  .menu-action:hover,
  .menu-action:focus-visible {
    background: var(--accent);
    color: var(--on-accent);
    outline: none;
  }
</style>
