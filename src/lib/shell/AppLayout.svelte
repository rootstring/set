<script lang="ts">
  import type { Snippet } from "svelte";
  import type { Context, PageSummary, TrashEntry, TrashedPage } from "$lib/types";
  import type { ContentMatch } from "$lib/storage/store";
  import Titlebar from "./Titlebar.svelte";
  import ResizeGrips from "./ResizeGrips.svelte";
  import Icon from "./Icon.svelte";
  import Sidebar from "./Sidebar.svelte";
  import WindowNav from "./WindowNav.svelte";
  import ConfirmPopover from "./ConfirmPopover.svelte";
  import PagePicker from "./PagePicker.svelte";
  import LinkDialog from "./LinkDialog.svelte";
  import MathDialog from "./MathDialog.svelte";
  import TrashView from "./TrashView.svelte";
  import QuickSwitcher from "./QuickSwitcher.svelte";
  import PageMenu from "./PageMenu.svelte";
  import SettingsPanel, { type SettingsTab } from "./SettingsPanel.svelte";
  import DictationBar from "./DictationBar.svelte";
  import Toaster from "./Toaster.svelte";
  import Breadcrumbs from "$lib/page/Breadcrumbs.svelte";
  import { trashInContext } from "$lib/page/trash";
  import { settings, shortcutHint, IS_LINUX } from "$lib/state/settings.svelte";
  import { isTauri } from "@tauri-apps/api/core";
  import { toasts } from "$lib/state/toasts.svelte";

  /** An overlay that throws while drawing would stay "open" with nothing on screen. */
  function overlayFailed(what: string, close: () => void): (error: unknown) => void {
    return (error) => {
      console.error(error);
      close();
      toasts.error(`Something went wrong showing ${what}.`);
    };
  }

  // Frameless on Linux: the window has no border to drag. See Titlebar.svelte.
  const frameless = isTauri() && IS_LINUX;

  /**
   * The desktop app has a top strip for the toggle; a browser tab keeps it in the sidebar header.
   */
  const windowNav = isTauri();

  const sidebarHint = $derived(shortcutHint(settings.sidebarShortcut));

  interface Props {
    pages: PageSummary[];
    contextPages: PageSummary[];
    contexts: Context[];
    activeContext: string;
    onSwitchContext: (name: string) => void;
    onCreateContext: (name: string) => Promise<string | null>;
    onMoveToContext: (id: string, context: string) => void;
    contextSwitchedAt: number;
    activeId: string | null;
    onSelect: (id: string) => void;
    onCreate: () => void;
    onCreateChild: (parentId: string) => void;
    onDelete: (id: string, anchor: HTMLElement | null) => void;
    onMove: (id: string, newParentId: string | null, orderedIds: string[]) => void;
    trash: TrashEntry[];
    loadTrashChildren: (entry: TrashEntry) => Promise<TrashedPage[]>;
    trashOpen: boolean;
    onOpenTrash: () => void;
    onCloseTrash: () => void;
    onRestore: (id: string, reveal: boolean) => void;
    onRestoreContext: (name: string) => void;
    onDeleteForever: (id: string) => void;
    onDeleteContextForever: (name: string) => void;
    onClearTrash: (context: string) => void;
    quickSwitcherOpen: boolean;
    onOpenQuickSwitcher: () => void;
    onCloseQuickSwitcher: () => void;
    searchContent: (query: string, limit: number) => Promise<ContentMatch[]>;
    settingsOpen: boolean;
    onOpenSettings: (tab?: SettingsTab) => void;
    settingsTab?: SettingsTab;
    onCloseSettings: () => void;
    sidebarCollapsed: boolean;
    onToggleSidebar: () => void;
    chrootId: string | null;
    onChroot: (id: string | null) => void;
    /** The open page's, unless the sidebar names another. */
    onToggleLock: (id?: string) => void;
    lockBlockedBy: Map<string, string>;
    focusMode: boolean;
    /** The open page's ancestors, outermost first. */
    breadcrumbs: PageSummary[];
    children: Snippet;
  }

  let {
    pages,
    contextPages,
    contexts,
    activeContext,
    onSwitchContext,
    onCreateContext,
    onMoveToContext,
    contextSwitchedAt,
    activeId,
    onSelect,
    onCreate,
    onCreateChild,
    onDelete,
    onMove,
    trash,
    loadTrashChildren,
    trashOpen,
    onOpenTrash,
    onCloseTrash,
    onRestore,
    onRestoreContext,
    onDeleteForever,
    onDeleteContextForever,
    onClearTrash,
    quickSwitcherOpen,
    onOpenQuickSwitcher,
    onCloseQuickSwitcher,
    searchContent,
    settingsOpen,
    onOpenSettings,
    settingsTab,
    onCloseSettings,
    sidebarCollapsed,
    onToggleSidebar,
    chrootId,
    onChroot,
    onToggleLock,
    lockBlockedBy,
    focusMode,
    breadcrumbs,
    children,
  }: Props = $props();

  const activeSummary = $derived(pages.find((p) => p.id === activeId) ?? null);
  const activeLocked = $derived(activeSummary?.locked ?? false);

  const scopedTrash = $derived(trashInContext(trash, activeContext));

  const activePageContext = $derived(
    pages.find((p) => p.id === activeId)?.context ?? activeContext,
  );
</script>

<div class="app">
  {#if !sidebarCollapsed && !focusMode}
    <Sidebar
      pages={contextPages}
      {activeId}
      {onSelect}
      {onCreate}
      {onCreateChild}
      onDelete={(page, anchor) => onDelete(page.id, anchor)}
      {onMove}
      onOpenSearch={onOpenQuickSwitcher}
      {onOpenTrash}
      {onOpenSettings}
      onToggleCollapse={onToggleSidebar}
      showCollapse={!windowNav}
      trashCount={scopedTrash.length}
      {chrootId}
      {onChroot}
      {contexts}
      {activeContext}
      {onSwitchContext}
      {onCreateContext}
      onManageContexts={() => onOpenSettings("contexts")}
      {contextSwitchedAt}
      {lockBlockedBy}
    />
  {/if}
  <div class="main">
    <Titlebar />
    {#if !focusMode && activeSummary}
      <!-- Keyed so a fold opened on one page is shut again on the next. -->
      {#key activeId}
        <Breadcrumbs
          trail={breadcrumbs}
          current={activeSummary}
          onOpenPage={onSelect}
          offset={sidebarCollapsed && !windowNav}
          locked={activeLocked}
          onUnlock={() => onToggleLock()}
        />
      {/key}
    {/if}
    {#if !focusMode}
      <PageMenu
        pageId={activeId}
        locked={activeLocked}
        {onToggleLock}
        {chrootId}
        {onChroot}
        {contexts}
        pageContext={activePageContext}
        {onMoveToContext}
        {onDelete}
      />
    {/if}
    <div class="content selectable">
      {@render children()}
    </div>
  </div>
</div>
{#if windowNav && !focusMode}
  <WindowNav {sidebarCollapsed} {onToggleSidebar} />
{/if}

{#if sidebarCollapsed && !focusMode && !windowNav}
  <button
    class="control quiet sidebar-reopen"
    title="Show sidebar{sidebarHint}"
    aria-label="Show sidebar"
    onclick={onToggleSidebar}
  >
    <Icon name="sidebar" />
  </button>
{/if}

{#if trashOpen}
  <svelte:boundary onerror={overlayFailed("the trash", onCloseTrash)}>
    <TrashView
      {trash}
      {contexts}
      {activeContext}
      loadChildren={loadTrashChildren}
      {onRestore}
      {onRestoreContext}
      {onDeleteForever}
      {onDeleteContextForever}
      {onClearTrash}
      onClose={onCloseTrash}
    />
  </svelte:boundary>
{/if}

{#if quickSwitcherOpen}
  <svelte:boundary onerror={overlayFailed("search", onCloseQuickSwitcher)}>
    <QuickSwitcher
      {pages}
      {searchContent}
      {chrootId}
      {activeContext}
      {contexts}
      {onSwitchContext}
      onSelect={(id) => {
        onSelect(id);
        onCloseQuickSwitcher();
      }}
      onClose={onCloseQuickSwitcher}
      {activeId}
      {activeLocked}
      {onToggleLock}
      {onChroot}
      onDeletePage={onDelete}
      {onOpenSettings}
      {onOpenTrash}
    />
  </svelte:boundary>
{/if}

{#if settingsOpen}
  <svelte:boundary onerror={overlayFailed("settings", onCloseSettings)}>
    <SettingsPanel onClose={onCloseSettings} initialTab={settingsTab} />
  </svelte:boundary>
{/if}

<DictationBar />
<ConfirmPopover />
<PagePicker {pages} {activeContext} />
<LinkDialog />
<MathDialog />
<Toaster />

{#if frameless}
  <ResizeGrips />
{/if}

<style>
  .app {
    display: flex;
    height: 100vh;
    width: 100vw;
    overflow: hidden;
  }

  .main {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    min-width: 0;
    height: 100%;

    position: relative;

    background: var(--editor-bg);
  }

  .content {
    flex: 1 1 auto;
    overflow-y: auto;

    scrollbar-gutter: stable both-edges;
  }

  @supports not (scrollbar-gutter: stable) {
    .content {
      overflow-y: scroll;
      padding-left: var(--sbw, 0px);
    }
  }

  /* Browser-only, and there the app starts at the top of the tab. */
  .sidebar-reopen {
    position: fixed;
    top: 8px;
    left: 8px;
    z-index: 50;
    width: 28px;
    height: 28px;
  }
</style>
