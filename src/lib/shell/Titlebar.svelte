<script lang="ts">
  import { isTauri } from "@tauri-apps/api/core";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { IS_LINUX } from "$lib/state/settings.svelte";

  // macOS: the native buttons float over this strip. Linux: no native buttons
  // (`set_decorations(false)` in lib.rs), so this bar draws them. Windows: a plain strip below the
  // native title bar.
  const ownButtons = isTauri() && IS_LINUX;

  let maximized = $state(false);

  $effect(() => {
    if (!ownButtons) return;
    const win = getCurrentWindow();
    const read = () => void win.isMaximized().then((on) => (maximized = on));
    read();
    const off = win.onResized(read);
    return () => void off.then((stop) => stop());
  });
</script>

<div class="titlebar" data-tauri-drag-region>
  {#if ownButtons}
    <div class="buttons">
      <button
        type="button"
        class="win-btn"
        title="Minimise"
        aria-label="Minimise"
        onclick={() => void getCurrentWindow().minimize()}
      >
        <svg viewBox="0 0 12 12" aria-hidden="true">
          <line x1="2.5" y1="6" x2="9.5" y2="6" />
        </svg>
      </button>
      <button
        type="button"
        class="win-btn"
        title={maximized ? "Restore" : "Maximise"}
        aria-label={maximized ? "Restore" : "Maximise"}
        onclick={() => void getCurrentWindow().toggleMaximize()}
      >
        <svg viewBox="0 0 12 12" aria-hidden="true">
          {#if maximized}
            <rect x="2.5" y="4" width="5.5" height="5.5" rx="1" />
            <path d="M4.4 4V3a1 1 0 0 1 1-1h3.1a1 1 0 0 1 1 1v3.1a1 1 0 0 1-1 1H8" />
          {:else}
            <rect x="2.5" y="2.5" width="7" height="7" rx="1" />
          {/if}
        </svg>
      </button>
      <button
        type="button"
        class="win-btn close"
        title="Close"
        aria-label="Close"
        onclick={() => void getCurrentWindow().close()}
      >
        <svg viewBox="0 0 12 12" aria-hidden="true">
          <line x1="3" y1="3" x2="9" y2="9" />
          <line x1="9" y1="3" x2="3" y2="9" />
        </svg>
      </button>
    </div>
  {/if}
</div>

<style>
  .titlebar {
    height: 0;
    flex: 0 0 auto;
  }

  :global(html.tauri-macos) .titlebar {
    height: 38px;
  }

  :global(html.tauri-linux) .titlebar,
  :global(html.tauri-windows) .titlebar {
    height: var(--titlebar-height);

    display: flex;
    align-items: center;
    justify-content: flex-end;
  }

  .buttons {
    display: flex;
    align-items: center;
    gap: 2px;

    padding-inline-end: 6px;
  }

  .win-btn {
    width: 24px;
    height: 24px;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: transparent;
    color: var(--text-subtle);

    display: inline-flex;
    align-items: center;
    justify-content: center;

    cursor: default;
  }

  .win-btn svg {
    width: 12px;
    height: 12px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .win-btn:hover {
    background: var(--bg-hover);
    color: var(--text);
  }

  .win-btn:active {
    background: var(--bg-active);
  }

  .win-btn.close:hover {
    background: var(--danger);
    color: #fff;
  }
</style>
