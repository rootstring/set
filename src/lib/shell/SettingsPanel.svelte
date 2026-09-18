<script module lang="ts">
  export type SettingsTab =
    "appearance" | "storage" | "sync" | "other" | "contexts" | "shortcuts";
</script>

<script lang="ts">
  import { isTauri } from "@tauri-apps/api/core";
  import Icon from "./Icon.svelte";
  import { openDonate, openDownload, openFeedback, openSource } from "./links";

  import { confirms } from "$lib/state/confirm.svelte";
  import { settings } from "$lib/state/settings.svelte";
  import { updates } from "$lib/state/updates.svelte";
  import { workspace } from "$lib/state/workspace.svelte";
  import AppearanceTab from "./settings/AppearanceTab.svelte";
  import ContextsTab from "./settings/ContextsTab.svelte";
  import DataTab from "./settings/DataTab.svelte";
  import OtherTab from "./settings/OtherTab.svelte";
  import PagePreview from "./settings/PagePreview.svelte";
  import ShortcutsTab from "./settings/ShortcutsTab.svelte";
  import StorageTab from "./settings/StorageTab.svelte";
  import SyncTab from "./settings/SyncTab.svelte";
  import type { FlashTone, TabContext } from "./settings/shared";

  interface Props {
    onClose: () => void;
    initialTab?: SettingsTab;
  }

  let { onClose, initialTab }: Props = $props();

  const desktop = isTauri();

  const TABS: { id: SettingsTab; label: string }[] = [
    { id: "appearance", label: "Appearance" },
    { id: "shortcuts", label: "Shortcuts" },
    { id: "contexts", label: "Contexts" },
    { id: "storage", label: "Storage" },
    ...(desktop
      ? ([
          { id: "sync", label: "Sync" },
          { id: "other", label: "Other" },
        ] as const)
      : []),
  ];

  // A tab absent on this platform, or unknown, opens the first tab.
  // svelte-ignore state_referenced_locally
  let tab = $state<SettingsTab>(
    initialTab && TABS.some((t) => t.id === initialTab) ? initialTab : TABS[0].id,
  );

  let status = $state<{ text: string; tone: FlashTone }>({ text: "", tone: "info" });

  function flash(message: string, tone: FlashTone = "info"): void {
    status = { text: message, tone };
    setTimeout(() => {
      if (status.text === message) status = { text: "", tone: "info" };
    }, 4000);
  }

  const ctx: TabContext = {
    // The same popover the deletes use; no dialog on top of a dialog.
    confirm: (request) =>
      confirms.ask({
        anchor: request.anchor ?? null,
        title: request.title,
        message: request.message,
        confirmLabel: request.confirmLabel,
        cancelLabel: request.cancelLabel,
        danger: request.danger,
        remember: false,
        permanent: false,
        onConfirm: () => request.onConfirm(),
        onCancel: request.onCancel,
        // Where Cancel itself does something, dismissing must not do it by accident.
        onDismiss: () => {},
      }),
    flash,
    close: () => onClose(),
  };

  void workspace;

  // A pointer to the update section on the Other tab.
  const updateNote = $derived.by(() => {
    if (!updates.ready) return "";
    if (updates.status === "available" && updates.available)
      return `Update to v${updates.available.version}`;
    if (updates.status === "downloading") {
      const fraction = updates.fraction;
      return fraction === null
        ? "Downloading…"
        : `Downloading… ${Math.round(fraction * 100)}%`;
    }
    if (updates.status === "installed") return "Restart to finish";
    return "";
  });

  function openLink(open: () => Promise<void>): void {
    open().catch(() => flash("Couldn't open the link", "warn"));
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      // The popover answers Escape itself; this panel isn't what's on top.
      if (confirms.open) return;
      e.preventDefault();
      onClose();
    }
  }

  function onTabKeydown(e: KeyboardEvent): void {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const i = TABS.findIndex((t) => t.id === tab);
    tab = TABS[(i + step + TABS.length) % TABS.length].id;
  }
</script>

<svelte:window onkeydown={onKeydown} />
<div class="backdrop" onmousedown={onClose} role="presentation">
  <div
    class="panel"
    onmousedown={(e) => e.stopPropagation()}
    role="dialog"
    aria-modal="true"
    aria-label="Settings"
    tabindex="-1"
  >
    <header class="head">
      <div class="tabs" role="tablist" aria-label="Settings sections">
        {#each TABS as t (t.id)}
          <button
            type="button"
            role="tab"
            class="tab"
            aria-selected={tab === t.id}
            aria-controls="settings-panel-{t.id}"
            tabindex={tab === t.id ? 0 : -1}
            data-testid="settings-tab-{t.id}"
            onclick={() => (tab = t.id)}
            onkeydown={onTabKeydown}
          >
            {t.label}
          </button>
        {/each}
      </div>
      <div class="head-end">
        <button
          type="button"
          class="control quiet close danger"
          aria-label="Close"
          onclick={onClose}
        >
          <Icon name="close" />
        </button>
      </div>
    </header>
    <div class="body" class:with-preview={tab === "appearance"}>
      <div
        class="col"
        id="settings-panel-{tab}"
        role="tabpanel"
        aria-label={TABS.find((t) => t.id === tab)?.label}
      >
        {#key tab}
          <div class="tab-in">
            {#if tab === "appearance"}
              <AppearanceTab {ctx} />
            {:else if tab === "storage"}
              {#if desktop}
                <StorageTab {ctx} />
              {:else}
                <DataTab {ctx} />
              {/if}
            {:else if tab === "sync"}
              <SyncTab {ctx} />
            {:else if tab === "other"}
              <OtherTab {ctx} />
            {:else if tab === "contexts"}
              <ContextsTab {ctx} />
            {:else}
              <ShortcutsTab {ctx} />
            {/if}
          </div>
        {/key}
      </div>
      <aside
        class="preview-col"
        class:shown={tab === "appearance"}
        aria-hidden={tab !== "appearance"}
      >
        <PagePreview />
      </aside>
    </div>
    <footer class="foot">
      <span class="version">Set (beta) v{settings.appVersion}</span>
      <span class="status" class:warn={status.tone === "warn"} aria-live="polite"
        >{status.text}</span
      >
      <!-- Nothing at all: an empty span still takes a gap out of the row. -->
      {#if !desktop}
        <!-- The browser build is always current, so it offers the app instead. -->
        <span class="update">
          <button
            type="button"
            class="link"
            data-testid="settings-download"
            onclick={() => openLink(openDownload)}>Download for Desktop</button
          >
        </span>
      {:else if updateNote}
        <span class="update" aria-live="polite">
          {#if updates.status === "downloading"}
            <span class="update-note">{updateNote}</span>
          {:else}
            <button
              type="button"
              class="link update-link"
              data-testid="settings-update"
              onclick={() => (tab = "other")}>{updateNote}</button
            >
          {/if}
        </span>
      {/if}
      <nav class="links" aria-label="Feedback, source code and support">
        <button
          type="button"
          class="link"
          data-testid="settings-feedback"
          onclick={() => openLink(openFeedback)}>Feedback</button
        >
        <button
          type="button"
          class="link"
          data-testid="settings-source"
          onclick={() => openLink(openSource)}>Source code</button
        >
        <button
          type="button"
          class="link"
          data-testid="settings-support-set"
          onclick={() => openLink(openDonate)}>Support Set</button
        >
      </nav>
    </footer>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 130;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1rem;
    background: oklch(0% 0 0 / 0.45);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
  }

  .panel {
    --preview-w: 20rem;
    --gutter: 1.25rem;
    width: min(940px, calc(100vw - 2rem));
    height: min(84vh, 700px);
    display: flex;
    flex-direction: column;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: calc(var(--radius) * 2);
    box-shadow: var(--shadow-pop);
    overflow: hidden;
  }

  .head {
    flex: 0 0 auto;
    display: flex;
    align-items: stretch;
    gap: 1rem;
    padding: 0 var(--gutter);
    border-bottom: 1px solid var(--border);
  }

  .tabs {
    flex: 1;
    display: flex;
    align-items: stretch;

    gap: 1.75rem;
  }
  .tab {
    display: inline-flex;
    align-items: center;
    border: none;
    background: none;

    margin-bottom: -1px;
    border-bottom: 2px solid transparent;

    padding: 1.3rem 0 1.15rem;
    color: var(--text-muted);
    font: inherit;
    font-size: 0.95rem;
    font-weight: 500;
    line-height: 1;
    white-space: nowrap;
    cursor: pointer;
    transition:
      color 0.15s ease,
      border-color 0.15s ease;
  }
  .tab:hover {
    color: var(--text);
  }
  .tab[aria-selected="true"] {
    color: var(--text);
    font-weight: 600;
    border-bottom-color: var(--accent);
  }

  .tab:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -3px;
    border-radius: 4px;
  }

  .head-end {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
  }

  .close {
    width: 1.6rem;
    height: 1.6rem;
    font-size: 0.85rem;
  }

  .body {
    position: relative;
    flex: 1 1 auto;
    min-height: 0;
  }

  .col {
    box-sizing: border-box;
    height: 100%;
    overflow-y: auto;
    padding: 1.1rem var(--gutter) 1.4rem;
    transition: padding-right 0.34s cubic-bezier(0.22, 0.8, 0.2, 1);
  }
  .body.with-preview .col {
    padding-right: calc(var(--preview-w) + var(--gutter) * 2 + var(--sbw, 0px));
  }

  .preview-col {
    position: absolute;
    top: 0;
    bottom: 0;
    right: calc(var(--gutter) + var(--sbw, 0px));
    width: var(--preview-w);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1.1rem 0 1.4rem;
    box-sizing: border-box;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.2s ease;
  }
  .preview-col.shown {
    opacity: 1;
    pointer-events: auto;
  }

  .tab-in {
    animation: tab-in 0.24s cubic-bezier(0.22, 0.8, 0.2, 1) both;
  }
  @keyframes tab-in {
    from {
      opacity: 0;
      transform: translateY(6px);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .preview-col,
    .col {
      transition: none;
    }
    .tab-in {
      animation: none;
    }
  }

  .foot {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 0.6rem var(--gutter);
    border-top: 1px solid var(--border);
  }
  .version {
    font-size: 0.75rem;
    color: var(--text-subtle);
    font-variant-numeric: tabular-nums;
  }
  .update {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }
  .update-note {
    font-size: 0.75rem;
    color: var(--text-subtle);
  }
  /* Doubled so it outranks `.link`. */
  .link.update-link {
    color: var(--accent);
    font-weight: 500;
  }
  .status {
    flex: 1;
    min-width: 0;
    font-size: 0.78rem;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .status.warn {
    color: var(--warning);
    font-weight: 500;
  }
  .links {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 1rem;
  }
  .link {
    border: none;
    background: none;
    padding: 0;
    font: inherit;
    font-size: 0.78rem;
    color: var(--text-muted);
    cursor: pointer;
    transition: color 0.15s ease;
  }
  .link:hover {
    color: var(--text);
  }
  .link:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
    border-radius: 3px;
  }

  @media (max-width: 720px) {
    .preview-col.shown {
      opacity: 0;
      pointer-events: none;
    }
    .body.with-preview .col {
      padding-right: var(--gutter);
    }
  }
</style>
