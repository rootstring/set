<script lang="ts">
  import Icon from "./Icon.svelte";
  import { navHistory } from "$lib/state/history.svelte";
  import { settings, shortcutHint } from "$lib/state/settings.svelte";

  /**
   * Fixed, not laid out in a column: the strip belongs to the sidebar while open and to the main
   * column once not. Lined up against the sidebar's right edge; with the sidebar away it moves
   * left, clear of the window buttons.
   */

  interface Props {
    sidebarCollapsed: boolean;
    onToggleSidebar: () => void;
  }

  let { sidebarCollapsed, onToggleSidebar }: Props = $props();

  const sidebarHint = $derived(shortcutHint(settings.sidebarShortcut));
  const backHint = $derived(shortcutHint(settings.navBackShortcut));
  const forwardHint = $derived(shortcutHint(settings.navForwardShortcut));
</script>

<!-- The gaps drag the window; the buttons are their own targets. -->
<div class="window-nav" class:detached={sidebarCollapsed} data-tauri-drag-region>
  <div class="steps">
    <button
      type="button"
      class="control quiet nav-btn"
      title="Back{backHint}"
      aria-label="Back"
      data-testid="window-nav-back"
      disabled={!navHistory.canGoBack}
      onclick={() => navHistory.back()}
    >
      <Icon name="back" />
    </button>
    <button
      type="button"
      class="control quiet nav-btn"
      title="Forward{forwardHint}"
      aria-label="Forward"
      data-testid="window-nav-forward"
      disabled={!navHistory.canGoForward}
      onclick={() => navHistory.forward()}
    >
      <Icon name="forward" />
    </button>
  </div>
  <button
    type="button"
    class="control quiet nav-btn"
    title="{sidebarCollapsed ? 'Show' : 'Hide'} sidebar{sidebarHint}"
    aria-label="{sidebarCollapsed ? 'Show' : 'Hide'} sidebar"
    data-testid="window-nav-sidebar"
    onclick={onToggleSidebar}
  >
    <Icon name="sidebar" />
  </button>
</div>

<style>
  .window-nav {
    position: fixed;
    top: 0;
    left: 0;
    z-index: 50;

    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;

    /* Right-aligned across exactly the sidebar, border included. */
    width: var(--sidebar-width);
    height: var(--titlebar-height);
    padding-inline-end: 8px;
  }

  /* No sidebar to sit at the edge of: back to the left of the strip, past
     whatever the system draws there. */
  .window-nav.detached {
    width: auto;
    justify-content: flex-start;
    padding-inline: 8px;
  }

  :global(html.tauri-macos) .window-nav {
    height: 38px;
  }

  /* Clear of the traffic lights, which the system draws over this strip. */
  :global(html.tauri-macos) .window-nav.detached {
    padding-inline-start: 78px;
  }

  .steps {
    display: flex;
    align-items: center;
    gap: 2px;
  }

  .nav-btn {
    width: 28px;
    height: 28px;
    font-size: 1rem;
  }

  /* Nowhere to go, rather than refused. */
  .nav-btn:disabled {
    opacity: 0.35;
    cursor: default;
  }
  .nav-btn:disabled:hover {
    background: transparent;
    border-color: transparent;
    color: var(--text-muted);
  }
</style>
