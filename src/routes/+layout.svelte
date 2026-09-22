<script lang="ts">
  import "../app.css";
  import { onMount, onDestroy } from "svelte";
  import { isTauri, invoke } from "@tauri-apps/api/core";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import { afterNavigate } from "$app/navigation";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import {
    AppLayout,
    AppContextMenu,
    ExternalChangeDialog,
    MobileNotice,
    OnboardingFlow,
    type SettingsTab,
  } from "$lib/shell";
  import { workspace } from "$lib/state/workspace.svelte";
  import { navHistory } from "$lib/state/history.svelte";
  import { LOCK_TOAST, PAGE_LOCKED } from "$lib/page/lock";
  import { lockNudges } from "$lib/state/lock-nudge.svelte";
  import { sync } from "$lib/state/sync.svelte";
  import { dictation } from "$lib/state/dictation.svelte";
  import { updates } from "$lib/state/updates.svelte";
  import { toasts } from "$lib/state/toasts.svelte";
  import { confirms } from "$lib/state/confirm.svelte";
  import {
    settings,
    matchesShortcut,
    contextShortcut,
    tauriAccelerator,
    IS_MAC,
    IS_LINUX,
    IS_WINDOWS,
    type BindingId,
  } from "$lib/state/settings.svelte";
  import { getActiveEditor } from "$lib/editor/active-editor";
  import { applyScrollbarWidthVar } from "$lib/utils/scrollbar";
  import { installTooltips } from "$lib/shell/tooltips";
  import { openDonate, openFeedback } from "$lib/shell/links";

  let { children, data } = $props();

  // What the back/forward buttons are counted from. See `state/history.svelte`.
  afterNavigate((nav) => navHistory.landed(nav));

  /** How long a quit waits for the pending save before going anyway. */
  const CLOSE_SAVE_GRACE_MS = 2_000;

  /**
   * Linux runs frameless with no menu bar, so everything the menu carried is bound here, as in a
   * browser.
   */
  const nativeMenu = isTauri() && !IS_LINUX;
  const frameless = isTauri() && IS_LINUX;

  const afterMs = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  let settingsOpen = $state(false);

  let settingsTab = $state<SettingsTab | undefined>(undefined);

  function openSettings(tab?: SettingsTab): void {
    settingsTab = tab;
    settingsOpen = true;
  }

  let onboardingOpen = $state(false);
  const onboarding = $derived(
    isTauri() && (onboardingOpen || (settings.settled && settings.onboardedAt === null)),
  );

  // A popover, not a dialog: this lands while settings is open. Dismissing turns the device down.
  $effect(() => {
    const request = sync.pairRequest;
    if (!request) return;
    confirms.ask({
      anchor: null,
      title: "Pair with this device?",
      message:
        `“${request.name}” wants to pair, which gives it all your notes. ` +
        `Allow it only if you just pasted this device's code there.`,
      confirmLabel: "Allow",
      cancelLabel: "Don't allow",
      danger: false,
      remember: false,
      permanent: false,
      onConfirm: () => void sync.answerPair(true),
      onCancel: () => void sync.answerPair(false),
      onDismiss: () => void sync.answerPair(false),
    });
    // The other device stops waiting after a minute or two.
    return () => confirms.cancel();
  });

  function closeOnboarding(): void {
    onboardingOpen = false;
    settings.completeOnboarding();
  }

  let focusMode = $state(false);

  let fullscreenTouched = false;
  $effect(() => {
    const on = focusMode;
    if (!isTauri() || (!fullscreenTouched && !on)) return;
    fullscreenTouched = true;
    void getCurrentWindow()
      .setFullscreen(on)
      .catch(() => {});
  });
  onDestroy(() => {
    if (isTauri() && focusMode) {
      void getCurrentWindow()
        .setFullscreen(false)
        .catch(() => {});
    }
  });

  const overlayOpen = $derived(
    onboarding ||
      settingsOpen ||
      workspace.trashOpen ||
      workspace.quickSwitcherOpen ||
      confirms.open ||
      workspace.pendingExternalChange !== null ||
      dictation.promptOpen ||
      dictation.recording,
  );

  /** A shortcut has no button, so the confirmation borrows the sidebar row or the page menu. */
  function deleteAnchor(id: string): HTMLElement | null {
    return (
      document.querySelector<HTMLElement>(
        `.page-row[data-id="${CSS.escape(id)}"] .delete-btn`,
      ) ?? document.querySelector<HTMLElement>(".page-menu .menu-btn")
    );
  }

  function toggleSidebar(): void {
    settings.setSidebarCollapsed(!settings.sidebarCollapsed);
  }

  const inEditor = () =>
    !!(document.activeElement as HTMLElement | null)?.closest?.(".ProseMirror");

  async function doUndo() {
    const editor = getActiveEditor();
    if (inEditor() && editor?.can().undo()) editor.chain().focus().undo().run();
    else await workspace.undo();
  }

  async function doRedo() {
    const editor = getActiveEditor();
    if (inEditor() && editor?.can().redo()) editor.chain().focus().redo().run();
    else await workspace.redo();
  }

  function insertDictation(text: string): void {
    const editor = getActiveEditor();
    if (!editor) return;
    const { from, empty } = editor.state.selection;
    const before = empty ? editor.state.doc.textBetween(Math.max(0, from - 1), from) : "";
    const lead = before && !/\s/.test(before) ? " " : "";
    editor
      .chain()
      .focus()
      .insertContent(lead + text)
      .run();

    workspace.markDirty();
  }

  function toggleChroot() {
    if (workspace.chrootId) workspace.chroot(null);
    else if (workspace.activePageId) workspace.chroot(workspace.activePageId);
  }

  function toggleTheme(): void {
    settings.setTheme(settings.isDarkTheme ? "light" : "dark");
  }

  function dictate(): void {
    if (workspace.activePage?.locked) {
      toasts.error(PAGE_LOCKED, LOCK_TOAST);
      lockNudges.nudge();
      return;
    }
    void dictation.begin();
  }

  $effect(() => {
    // Asking on Linux makes GTK complain about accelerators for items no longer in an accel group.
    if (!nativeMenu) return;
    const items = [
      { id: "new_page", label: null, shortcut: settings.newPageShortcut },
      { id: "quick_switcher", label: null, shortcut: settings.quickSwitcherShortcut },
      {
        id: "chroot",
        label: workspace.chrootId ? "Un-chroot" : "Chroot",
        shortcut: settings.chrootShortcut,
      },
    ];
    for (const item of items) {
      invoke("set_menu_shortcut", {
        id: item.id,
        label: item.label,
        accelerator: tauriAccelerator(item.shortcut),
      }).catch(() => {});
    }
  });

  // The item says what there is to do; choosing it lands on the Other tab.
  $effect(() => {
    if (!nativeMenu) return;
    const label =
      updates.status === "available" && updates.available
        ? `Update to v${updates.available.version}…`
        : updates.status === "installed"
          ? "Restart to Finish…"
          : "Check for Updates…";
    invoke("set_menu_label", { id: "check_updates", label }).catch(() => {});
  });

  // One notice per launch, since the check runs once per launch. It waits rather than fading.
  let notified: string | null = null;
  $effect(() => {
    if (updates.status !== "available" || !updates.available) return;
    const version = updates.available.version;
    if (notified === version) return;
    notified = version;
    toasts.offer(`Set v${version} is available`, "download", [
      { label: "Remind me later", run: () => {} },
      // The download itself is a button away, on the tab this opens.
      { label: "Download", run: () => openSettings("other") },
    ]);
  });

  /** `menuOwns` marks the two the native menu already fires, or the action would run twice. */
  const SHORTCUTS: { id: BindingId; run: () => void; menuOwns?: boolean }[] = [
    { id: "sidebar", run: toggleSidebar },
    { id: "navBack", run: () => navHistory.back() },
    { id: "navForward", run: () => navHistory.forward() },
    { id: "quickSwitcher", run: () => workspace.openQuickSwitcher() },
    { id: "newPage", run: () => workspace.createPage(), menuOwns: true },
    { id: "chroot", run: toggleChroot, menuOwns: true },
    { id: "newChildPage", run: () => workspace.createPage(workspace.activePageId) },
    { id: "prevSibling", run: () => workspace.goToSibling(-1) },
    { id: "nextSibling", run: () => workspace.goToSibling(1) },
    { id: "focusMode", run: () => (focusMode = !focusMode) },
    { id: "toggleTheme", run: toggleTheme },
    { id: "lock", run: () => workspace.toggleLock() },
    { id: "dictate", run: dictate },
    {
      id: "trashPage",
      run: () => {
        const id = workspace.activePageId;
        if (id) workspace.requestDelete(id, deleteAnchor(id));
      },
    },
    // Last, so a key someone had already given to one of the above keeps it.
    { id: "openTrash", run: () => workspace.openTrash() },
  ];

  onMount(() => {
    if (data.unsupported) return;

    if (isTauri()) document.documentElement.classList.add("tauri");

    if (isTauri() && IS_MAC) document.documentElement.classList.add("tauri-macos");

    if (frameless) document.documentElement.classList.add("tauri-linux");

    if (isTauri() && IS_WINDOWS) {
      document.documentElement.classList.add("tauri-windows");
    }

    applyScrollbarWidthVar();

    const uninstallTooltips = installTooltips();

    settings.init();

    const flush = () => void workspace.flush();
    window.addEventListener("beforeunload", flush);
    window.addEventListener("blur", flush);
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    document.addEventListener("visibilitychange", onVisibility);

    const onKeydown = (e: KeyboardEvent) => {
      if (onboarding) return;
      for (const { id, run, menuOwns } of SHORTCUTS) {
        if (menuOwns && nativeMenu) continue; // the native menu item carries it
        if (!matchesShortcut(e, settings.shortcut(id))) continue;
        e.preventDefault();
        run();
        return;
      }

      if (e.key === "Escape" && focusMode && !overlayOpen) {
        e.preventDefault();
        focusMode = false;
        return;
      }
      const digit = /^Digit([1-9])$/.exec(e.code);
      if (digit && matchesShortcut(e, contextShortcut(Number(digit[1])))) {
        if (overlayOpen) return;
        e.preventDefault();
        const target = settings.orderContexts(workspace.contexts)[Number(digit[1]) - 1];
        if (target) void workspace.switchContext(target.name);
        return;
      }

      if (!((e.metaKey || e.ctrlKey) && !e.altKey)) return;
      const key = e.key.toLowerCase();

      if (frameless && e.code === "KeyR" && !e.shiftKey) {
        e.preventDefault();
        window.location.reload();
        return;
      }
      if (frameless && e.code === "KeyO" && e.shiftKey) {
        e.preventDefault();
        void workspace.openNotesFolder();
        return;
      }
      if (frameless && e.code === "KeyQ" && !e.shiftKey) {
        e.preventDefault();
        void getCurrentWindow().close();
        return;
      }
      if (e.code === "Comma") {
        if (!isTauri() && !e.shiftKey) return;
        e.preventDefault();
        settingsOpen = true;
      } else if (key === "z" && !nativeMenu) {
        const editor = getActiveEditor();
        const editorHandles =
          inEditor() && (e.shiftKey ? editor?.can().redo() : editor?.can().undo());
        if (editorHandles) return;
        e.preventDefault();
        if (e.shiftKey) doRedo();
        else doUndo();
      }
    };
    window.addEventListener("keydown", onKeydown);

    const unlisten: UnlistenFn[] = [];
    if (isTauri()) {
      listen("menu:new-page", () => workspace.createPage()).then((u) => unlisten.push(u));
      listen("menu:quick-switcher", () => workspace.openQuickSwitcher()).then((u) =>
        unlisten.push(u),
      );
      listen("menu:open-notes-folder", () => workspace.openNotesFolder()).then((u) =>
        unlisten.push(u),
      );
      listen("menu:settings", () => (settingsOpen = true)).then((u) => unlisten.push(u));

      listen("menu:setup-guide", () => (onboardingOpen = true)).then((u) =>
        unlisten.push(u),
      );

      const openLink = (open: () => Promise<void>) =>
        open().catch(() => toasts.error("Couldn't open the link."));
      listen("menu:feedback", () => openLink(openFeedback)).then((u) => unlisten.push(u));
      listen("menu:support", () => openLink(openDonate)).then((u) => unlisten.push(u));

      listen("menu:check-updates", () => {
        openSettings("other");
        void updates.check();
      }).then((u) => unlisten.push(u));
      listen("menu:undo", doUndo).then((u) => unlisten.push(u));
      listen("menu:redo", doRedo).then((u) => unlisten.push(u));
      listen("menu:chroot", toggleChroot).then((u) => unlisten.push(u));

      listen("menu:reload", () => window.location.reload()).then((u) => unlisten.push(u));

      // Closing the window ends the process everywhere but macOS, and `beforeunload` never runs for
      // a webview teardown. Hold the close open and let the write finish.
      if (!IS_MAC) {
        getCurrentWindow()
          .onCloseRequested(async () => {
            // Nothing here may hang: the window closes when this resolves.
            try {
              await Promise.race([workspace.flush(), afterMs(CLOSE_SAVE_GRACE_MS)]);
            } catch {
              // a failed save has already raised its own toast
            }
          })
          .then((u) => unlisten.push(u));
      }

      listen("notes:changed", () => workspace.reconcileExternalChange()).then((u) =>
        unlisten.push(u),
      );

      void sync
        .init(
          () => workspace.reloadFromDisk(),
          () => workspace.flush(),
        )
        .then(async () => sync.useNotesFolder(await workspace.notesFolder()));

      void workspace.notesFolder().then((dir) => workspace.pointAgentsAt(dir));

      void dictation.init(insertDictation);

      void updates.init();
    }

    return () => {
      uninstallTooltips();
      window.removeEventListener("beforeunload", flush);
      window.removeEventListener("blur", flush);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("keydown", onKeydown);
      for (const u of unlisten) u();
      sync.destroy();
      dictation.destroy();
      updates.destroy();
    };
  });
</script>

{#if data.unsupported}
  <MobileNotice />
{:else}
  <AppLayout
    pages={workspace.pages}
    contextPages={workspace.contextPages}
    contexts={settings.orderContexts(workspace.contexts)}
    activeContext={workspace.activeContext}
    onSwitchContext={(name) => void workspace.switchContext(name)}
    onCreateContext={(name) => workspace.createContext(name)}
    onMoveToContext={(id, context) => void workspace.moveToContext(id, context)}
    contextSwitchedAt={workspace.contextSwitchedAt}
    activeId={workspace.activePageId}
    onSelect={(id) => workspace.goTo(id)}
    onCreate={() => workspace.createPage()}
    onCreateChild={(parentId) => workspace.createPage(parentId)}
    onDelete={(id, anchor) => workspace.requestDelete(id, anchor)}
    onMove={(id, newParentId, orderedIds) => workspace.move(id, newParentId, orderedIds)}
    trash={workspace.trash}
    loadTrashChildren={(entry) => workspace.trashChildren(entry)}
    trashOpen={workspace.trashOpen}
    onOpenTrash={() => workspace.openTrash()}
    onCloseTrash={() => workspace.closeTrash()}
    onRestore={(id, reveal) => workspace.restorePage(id, reveal)}
    onRestoreContext={(name) => workspace.restoreContext(name)}
    onDeleteForever={(id) => workspace.deleteForever(id)}
    onDeleteContextForever={(name) => workspace.deleteContextForever(name)}
    onClearTrash={(context) => workspace.clearTrash(context)}
    quickSwitcherOpen={workspace.quickSwitcherOpen}
    onOpenQuickSwitcher={() => workspace.openQuickSwitcher()}
    onCloseQuickSwitcher={() => workspace.closeQuickSwitcher()}
    searchContent={(query, limit, only) => workspace.searchContent(query, limit, only)}
    {settingsOpen}
    {settingsTab}
    onOpenSettings={openSettings}
    onCloseSettings={() => (settingsOpen = false)}
    sidebarCollapsed={settings.sidebarCollapsed}
    onToggleSidebar={toggleSidebar}
    chrootId={workspace.chrootId}
    onChroot={(id) => workspace.chroot(id)}
    onToggleLock={(id) => workspace.toggleLock(id)}
    {focusMode}
    lockBlockedBy={workspace.lockBlockedBy}
    breadcrumbs={workspace.breadcrumbs}
  >
    {@render children()}
  </AppLayout>
  {#if workspace.pendingExternalChange}
    <ExternalChangeDialog
      title={workspace.pendingExternalChange.title}
      onChoose={(choice) => workspace.resolveExternalChange(choice)}
    />
  {/if}

  {#if onboarding}
    <OnboardingFlow onDone={closeOnboarding} />
  {/if}

  <AppContextMenu />
{/if}
