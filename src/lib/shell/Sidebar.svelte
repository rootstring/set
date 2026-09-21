<script lang="ts">
  import { untrack } from "svelte";
  import Icon from "./Icon.svelte";
  import { SvelteSet } from "svelte/reactivity";
  import type { Context, PageSummary } from "$lib/types";
  import {
    ancestorIds,
    childrenByParent,
    isSelfOrDescendant,
    parentsById,
  } from "$lib/page/tree";
  import ContextSwitcher from "./ContextSwitcher.svelte";
  import {
    settings,
    formatShortcut,
    shortcutHint,
    clampSidebarWidth,
    SETTINGS_SHORTCUT,
    SIDEBAR_WIDTH_MIN,
    SIDEBAR_WIDTH_MAX,
    SIDEBAR_WIDTH_DEFAULT,
  } from "$lib/state/settings.svelte";
  import { updates } from "$lib/state/updates.svelte";
  import { perf } from "$lib/utils/perf";
  import { loadExpanded, saveExpanded } from "$lib/state/sidebar-expanded";
  import { PAGE_LOCKED } from "$lib/page/lock";
  import { dismissDragHandle } from "$lib/editor/drag-handle";

  /** What the toast said, for after it has been answered or turned off. */
  const updateWaiting = $derived(
    updates.status === "available" || updates.status === "installed",
  );

  const hideHint = $derived(shortcutHint(settings.sidebarShortcut));
  const unchrootHint = $derived(shortcutHint(settings.chrootShortcut));
  const newPageHint = $derived(shortcutHint(settings.newPageShortcut));
  const newChildPageHint = $derived(shortcutHint(settings.newChildPageShortcut));
  const trashPageHint = $derived(shortcutHint(settings.trashPageShortcut));
  const openTrashHint = $derived(shortcutHint(settings.openTrashShortcut));
  const settingsHint = shortcutHint(SETTINGS_SHORTCUT);

  interface Props {
    pages: PageSummary[];
    activeId: string | null;
    onSelect: (id: string) => void;
    onCreate: () => void;
    onCreateChild: (parentId: string) => void;
    onDelete: (page: PageSummary, anchor: HTMLElement | null) => void;
    onMove: (id: string, newParentId: string | null, orderedIds: string[]) => void;
    onOpenSearch: () => void;
    onOpenTrash: () => void;
    onOpenSettings: () => void;
    onToggleCollapse: () => void;
    /**
     * False in the desktop app, where the toggle sits in the window's top strip
     * (`WindowNav.svelte`).
     */
    showCollapse: boolean;
    trashCount: number;
    chrootId: string | null;
    onChroot: (id: string | null) => void;
    contexts: Context[];
    activeContext: string;
    onSwitchContext: (name: string) => void;
    onCreateContext: (name: string) => Promise<string | null>;
    onManageContexts: () => void;
    contextSwitchedAt: number;
    lockBlockedBy: Map<string, string>;
  }

  let {
    pages,
    activeId,
    onSelect,
    onCreate,
    onCreateChild,
    onDelete,
    onMove,
    onOpenSearch,
    onOpenTrash,
    onOpenSettings,
    onToggleCollapse,
    showCollapse,
    trashCount,
    chrootId,
    onChroot,
    contexts,
    activeContext,
    onSwitchContext,
    onCreateContext,
    onManageContexts,
    contextSwitchedAt,
    lockBlockedBy,
  }: Props = $props();

  const chrootPage = $derived(
    chrootId ? (pages.find((p) => p.id === chrootId) ?? null) : null,
  );

  const expanded = new SvelteSet<string>(loadExpanded());

  function persist(): void {
    saveExpanded(expanded);
  }

  let children = $derived(childrenByParent(pages));
  let parentOf = $derived(parentsById(pages));

  $effect(() => {
    const id = activeId;
    const parents = parentOf;
    const root = chrootId;
    untrack(() => {
      if (!id) return;
      const ancestors = ancestorIds(id, parents, root);
      let changed = false;
      for (const ancestor of ancestors) {
        if (expanded.has(ancestor)) continue;
        expanded.add(ancestor);
        changed = true;
      }
      if (changed) persist();
    });
  });

  interface Row {
    page: PageSummary;
    depth: number;
    hasChildren: boolean;
    isOpen: boolean;
  }

  let rows = $derived.by(() => {
    const out: Row[] = [];
    const walk = (parentId: string | null, depth: number) => {
      for (const page of children.get(parentId) ?? []) {
        const hasChildren = (children.get(page.id)?.length ?? 0) > 0;
        const isOpen = hasChildren && expanded.has(page.id);
        out.push({ page, depth, hasChildren, isOpen });
        if (isOpen) walk(page.id, depth + 1);
      }
    };
    walk(chrootId, 0);
    return out;
  });

  const ROW_GAP = 4;
  const DEFAULT_ROW_H = 29 + ROW_GAP; // corrected by measurement below
  const OVERSCAN = 6;
  let rowH = $state(DEFAULT_ROW_H);
  let scrollTop = $state(0);
  let viewportH = $state(0);

  function onScroll(): void {
    scrollTop = navEl?.scrollTop ?? 0;
  }

  $effect(() => {
    rows.length; // re-measure when the list first fills (or its size changes)
    const el = navEl?.querySelector<HTMLElement>(".page-row");
    if (!el) return;
    const measured = el.offsetHeight + ROW_GAP;
    if (measured > 1 && Math.abs(measured - rowH) > 0.5) rowH = measured;
  });

  let startIndex = $derived(Math.max(0, Math.floor(scrollTop / rowH) - OVERSCAN));
  let endIndex = $derived(
    Math.min(rows.length, Math.ceil((scrollTop + viewportH) / rowH) + OVERSCAN),
  );

  let visibleRows = $derived.by(() => {
    const out: { row: Row; index: number }[] = [];
    for (let i = startIndex; i < endIndex; i++) out.push({ row: rows[i], index: i });

    if (dragId !== null) {
      const di = rows.findIndex((r) => r.page.id === dragId);
      if (di !== -1 && (di < startIndex || di >= endIndex)) {
        out.push({ row: rows[di], index: di });
      }
    }
    return out;
  });

  $effect(() => {
    rows;
    perf.startPaint("sidebar-render");
  });

  $effect(() => {
    const id = activeId;
    untrack(() => {
      if (!id) return;
      requestAnimationFrame(() => {
        const el = navEl;
        if (!el) return;
        const idx = rows.findIndex((r) => r.page.id === id);
        if (idx === -1) return;
        const top = idx * rowH;
        const bottom = top + rowH;
        if (top < el.scrollTop) el.scrollTop = top;
        else if (bottom > el.scrollTop + el.clientHeight) {
          el.scrollTop = bottom - el.clientHeight;
        }
      });
    });
  });

  function label(page: PageSummary): string {
    return page.title.trim() || "Untitled";
  }

  function requestDelete(page: PageSummary, anchor: HTMLElement | null): void {
    // Same as the add button: refused rows explain themselves in the tooltip.
    if (lockBlockedBy.has(page.id)) return;
    onDelete(page, anchor);
  }

  function toggle(id: string): void {
    if (expanded.has(id)) expanded.delete(id);
    else expanded.add(id);
    persist();
  }

  function addChild(parent: PageSummary): void {
    // The button is disabled and says why, so a click on it just does nothing.
    if (parent.locked) return;
    expanded.add(parent.id);
    persist();
    onCreateChild(parent.id);
  }

  let navEl = $state<HTMLElement>();
  let dragId = $state<string | null>(null);

  let dropAnchorId = $state<string | null>(null);
  let dropKind = $state<"before" | "after" | "inside">("before");

  interface DropPlan {
    newParent: string | null; // where the page lands
    orderedIds: string[]; // the destination group's ids in their new order
    anchorId: string; // row the indicator attaches to
    kind: "before" | "after" | "inside";
    noop: boolean; // true when the drop wouldn't change anything
  }

  function rowAt(clientY: number): { id: string; rect: DOMRect } | null {
    for (const el of navEl?.querySelectorAll<HTMLElement>(".page-row[data-id]") ?? []) {
      const rect = el.getBoundingClientRect();
      if (clientY >= rect.top && clientY <= rect.bottom) {
        return { id: el.dataset.id!, rect };
      }
    }
    return null;
  }

  function planDrop(clientY: number): DropPlan | null {
    if (dragId === null) return null;
    const moving = dragId;

    const hit = rowAt(clientY);
    let refId: string;
    let kind: "before" | "after" | "inside";
    if (hit) {
      if (isSelfOrDescendant(hit.id, moving, parentOf)) return null;
      refId = hit.id;
      const rel = (clientY - hit.rect.top) / hit.rect.height;
      kind = rel < 0.3 ? "before" : rel > 0.7 ? "after" : "inside";
    } else {
      const top = children.get(chrootId) ?? [];
      if (top.length === 0) return null;
      refId = top[top.length - 1].id;
      kind = "after";
    }

    const newParent = kind === "inside" ? refId : (parentOf.get(refId) ?? null);
    const siblings = (children.get(newParent) ?? [])
      .map((p) => p.id)
      .filter((x) => x !== moving);

    let index: number;
    if (kind === "inside") {
      index = siblings.length;
    } else {
      const rpos = siblings.indexOf(refId);
      index = rpos === -1 ? siblings.length : kind === "after" ? rpos + 1 : rpos;
    }
    const orderedIds = [...siblings];
    orderedIds.splice(index, 0, moving);

    const anchorId = kind === "after" ? lastSubtreeRowId(refId) : refId;

    const currentGroup = (children.get(newParent) ?? []).map((p) => p.id);
    const noop =
      newParent === (parentOf.get(moving) ?? null) &&
      orderedIds.length === currentGroup.length &&
      orderedIds.every((v, i) => v === currentGroup[i]);

    return { newParent, orderedIds, anchorId, kind, noop };
  }

  function lastSubtreeRowId(id: string): string {
    const start = rows.findIndex((r) => r.page.id === id);
    if (start === -1) return id;
    const depth = rows[start].depth;
    let last = start;
    for (let i = start + 1; i < rows.length && rows[i].depth > depth; i++) last = i;
    return rows[last].page.id;
  }

  function onDragStart(e: DragEvent, page: PageSummary): void {
    dragId = page.id;

    e.dataTransfer?.setData("text/plain", page.id);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
  }

  function endDrag(): void {
    dragId = null;
    dropAnchorId = null;
  }

  function onListDragOver(e: DragEvent): void {
    if (dragId === null) return;
    e.preventDefault(); // mark the whole list as a valid drop zone
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    const plan = planDrop(e.clientY);
    if (!plan || plan.noop) {
      dropAnchorId = null;
    } else {
      dropAnchorId = plan.anchorId;
      dropKind = plan.kind;
    }
  }

  function onListDrop(e: DragEvent): void {
    if (dragId === null) return;
    e.preventDefault();
    const moving = dragId;
    const plan = planDrop(e.clientY);
    endDrag();
    if (!plan || plan.noop) return;

    if (plan.kind === "inside" && plan.newParent) {
      expanded.add(plan.newParent);
      persist();
    }
    onMove(moving, plan.newParent, plan.orderedIds);
  }

  const RESIZE_STEP = 16;

  let asideEl = $state<HTMLElement>();
  let resizing = $state(false);
  let dragWidth = $state<number | null>(null);
  const sidebarWidth = $derived(dragWidth ?? settings.sidebarWidth);

  function previewWidth(width: number): void {
    dragWidth = clampSidebarWidth(width);
    document.documentElement.style.setProperty("--sidebar-width", `${dragWidth}px`);
  }

  function setWidth(width: number): void {
    dragWidth = null;
    settings.setSidebarWidth(width);
    dismissDragHandle();
  }

  function onResizeStart(e: PointerEvent): void {
    if (e.button !== 0) return;
    e.preventDefault();

    dismissDragHandle();

    const startX = e.clientX;
    const startWidth = asideEl?.offsetWidth ?? settings.sidebarWidth;
    const body = document.body;
    const priorSelect = body.style.userSelect;
    const priorCursor = body.style.cursor;
    body.style.userSelect = "none";
    body.style.cursor = "col-resize";

    const move = (ev: PointerEvent) => previewWidth(startWidth + ev.clientX - startX);

    const end = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      body.style.userSelect = priorSelect;
      body.style.cursor = priorCursor;
      resizing = false;
      setWidth(startWidth + ev.clientX - startX);
    };

    resizing = true;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  }

  function onResizeKeydown(e: KeyboardEvent): void {
    const step = e.shiftKey ? RESIZE_STEP * 2 : RESIZE_STEP;
    if (e.key === "ArrowLeft") setWidth(sidebarWidth - step);
    else if (e.key === "ArrowRight") setWidth(sidebarWidth + step);
    else if (e.key === "Home") setWidth(SIDEBAR_WIDTH_MIN);
    else if (e.key === "End") setWidth(SIDEBAR_WIDTH_MAX);
    else return;
    e.preventDefault();
  }
</script>

<aside class="sidebar" bind:this={asideEl}>
  <div class="traffic-lights" data-tauri-drag-region></div>
  <div class="header">
    <ContextSwitcher
      {contexts}
      active={activeContext}
      onSwitch={onSwitchContext}
      onCreate={onCreateContext}
      onManage={onManageContexts}
      switchedAt={contextSwitchedAt}
    />
    <div class="header-actions">
      {#if chrootPage}
        <button
          class="control quiet icon-btn chroot-exit"
          title="Showing only pages inside “{label(
            chrootPage,
          )}”. Back to the top of “{activeContext}”{unchrootHint}"
          aria-label="Back to the top of this context"
          onclick={() => onChroot(null)}
          data-testid="chroot-exit"
        >
          /
        </button>
      {/if}
      <button
        class="control quiet icon-btn search-btn"
        title="Search ({formatShortcut('Mod+K')})"
        aria-label="Search"
        onclick={onOpenSearch}
        data-testid="sidebar-search"
      >
        <Icon name="search" />
      </button>
      <button
        class="control quiet new-btn"
        title={(chrootPage ? `New page inside “${label(chrootPage)}”` : "New page") +
          newPageHint}
        onclick={onCreate}
        aria-label={chrootPage ? `New page inside “${label(chrootPage)}”` : "New page"}
      >
        <Icon name="plus" />
      </button>
      {#if showCollapse}
        <button
          class="control quiet icon-btn"
          title="Hide sidebar{hideHint}"
          aria-label="Hide sidebar"
          onclick={onToggleCollapse}
        >
          <Icon name="sidebar" />
        </button>
      {/if}
    </div>
  </div>
  <nav
    class="pages"
    class:is-empty={rows.length === 0}
    bind:this={navEl}
    bind:clientHeight={viewportH}
    onscroll={onScroll}
    ondragover={onListDragOver}
    ondrop={onListDrop}
  >
    {#if rows.length === 0}
      <p class="empty">
        {#if chrootPage}
          Nothing inside this page yet.
        {:else if contexts.length > 1}
          Nothing in “{activeContext}” yet.
        {:else}
          No pages yet.
        {/if}
      </p>
    {:else}
      <div class="rows-viewport" style="height: {rows.length * rowH}px">
        {#each visibleRows as { row, index } (row.page.id)}
          <div
            class="page-row"
            class:active={row.page.id === activeId}
            class:dragging={row.page.id === dragId}
            class:drop-before={row.page.id === dropAnchorId && dropKind === "before"}
            class:drop-after={row.page.id === dropAnchorId && dropKind === "after"}
            class:drop-inside={row.page.id === dropAnchorId && dropKind === "inside"}
            style="--depth: {row.depth}; top: {index * rowH}px"
            data-id={row.page.id}
            draggable="true"
            role="presentation"
            ondragstart={(e) => onDragStart(e, row.page)}
            ondragend={endDrag}
          >
            {#if row.hasChildren}
              <button
                class="twisty"
                class:open={row.isOpen}
                title={row.isOpen ? "Collapse" : "Expand"}
                aria-label={row.isOpen ? "Collapse" : "Expand"}
                aria-expanded={row.isOpen}
                onclick={() => toggle(row.page.id)}
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

            <!-- Only a marker: unlocking asks first on the page itself. -->
            {#if row.page.locked}
              <span class="lock-badge" title="Locked" aria-label="Locked" role="img">
                <span class="nav-icon"><Icon name="lock" /></span>
              </span>
            {/if}
            <button
              class="page-item"
              class:after-lock={row.page.locked}
              onclick={() => onSelect(row.page.id)}
            >
              {#if !row.page.locked}
                <span class="nav-icon"><Icon name="page" /></span>
              {/if}
              <span class="page-title">{label(row.page)}</span>
            </button>
            <button
              class="control quiet row-btn add-btn"
              title={row.page.locked
                ? PAGE_LOCKED
                : "Add a page inside" +
                  (row.page.id === activeId ? newChildPageHint : "")}
              aria-label="Add a page inside “{label(row.page)}”"
              aria-disabled={row.page.locked === true}
              onclick={() => addChild(row.page)}
            >
              <Icon name="plus" />
            </button>
            <button
              class="control quiet row-btn delete-btn danger"
              title={lockBlockedBy.has(row.page.id)
                ? row.page.locked
                  ? PAGE_LOCKED
                  : `“${lockBlockedBy.get(row.page.id)}” inside is locked`
                : "Move to Trash" + (row.page.id === activeId ? trashPageHint : "")}
              aria-label="Move “{label(row.page)}” to Trash"
              aria-disabled={lockBlockedBy.has(row.page.id)}
              onclick={(e) => requestDelete(row.page, e.currentTarget)}
            >
              <Icon name="trash" />
            </button>
          </div>
        {/each}
      </div>
    {/if}
  </nav>
  <div class="footer">
    <button
      class="control quiet footer-btn"
      title="Trash{openTrashHint}"
      aria-label="Trash{trashCount > 0 ? ` (${trashCount})` : ''}"
      onclick={onOpenTrash}
    >
      <Icon name="trash" />
      {#if trashCount > 0}
        <span class="count">{trashCount}</span>
      {/if}
    </button>
    <button
      class="control quiet footer-btn"
      title={(updateWaiting ? "Settings — an update is waiting" : "Settings") +
        settingsHint}
      aria-label={updateWaiting ? "Settings (an update is waiting)" : "Settings"}
      onclick={onOpenSettings}
    >
      <Icon name="settings" />
      {#if updateWaiting}
        <span class="dot" data-testid="update-dot"></span>
      {/if}
    </button>
  </div>
  <div
    class="resizer"
    class:resizing
    role="slider"
    aria-label="Sidebar width"
    aria-valuenow={sidebarWidth}
    aria-valuemin={SIDEBAR_WIDTH_MIN}
    aria-valuemax={SIDEBAR_WIDTH_MAX}
    tabindex="0"
    title="Drag to resize — double-click to reset"
    data-testid="sidebar-resizer"
    onpointerdown={onResizeStart}
    ondblclick={() => setWidth(SIDEBAR_WIDTH_DEFAULT)}
    onkeydown={onResizeKeydown}
  ></div>
</aside>

<style>
  .sidebar {
    position: relative;
    width: var(--sidebar-width);
    flex: 0 0 var(--sidebar-width);
    height: 100%;

    background: var(--surface);
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .resizer {
    position: absolute;
    top: 0;
    right: 0;
    z-index: 2;
    width: 6px;
    height: 100%;
    cursor: col-resize;
    touch-action: none;
  }

  .resizer::after {
    content: "";
    position: absolute;
    top: 0;
    right: 0;
    width: 2px;
    height: 100%;
    background: transparent;
    transition: background-color 0.12s ease;
  }

  .resizer:hover::after,
  .resizer:focus-visible::after,
  .resizer.resizing::after {
    background: var(--accent);
  }

  .resizer:focus-visible {
    outline: none;
  }

  .traffic-lights {
    flex: 0 0 auto;
    height: 0;
  }
  :global(html.tauri-macos) .traffic-lights {
    height: 38px;
  }

  /* Matches the app-drawn bar in the main column, so the whole top edge drags. */
  :global(html.tauri-linux) .traffic-lights,
  :global(html.tauri-windows) .traffic-lights {
    height: var(--titlebar-height);
  }

  .header {
    display: flex;
    align-items: center;

    gap: 0.3rem;

    height: var(--sidebar-header-height);
    flex: 0 0 auto;
    padding: 0 0.75rem;
  }

  .header-actions {
    display: flex;
    align-items: center;
    gap: 2px;

    margin-left: auto;
    flex: 0 0 auto;

    padding-left: max(0px, var(--sidebar-width) - var(--sidebar-width-default));
  }

  .new-btn,
  .icon-btn,
  .row-btn {
    width: 24px;
    height: 24px;
  }

  .new-btn {
    font-size: 0.95rem;
  }
  .chroot-exit {
    font-size: 0.9375rem;
    font-weight: 600;
  }
  .search-btn {
    font-size: 0.85rem;
  }

  .pages {
    flex: 1 1 auto;
    overflow-y: auto;
    padding: 0 0.5rem;
  }
  .pages.is-empty {
    display: flex;
    flex-direction: column;
  }

  .rows-viewport {
    position: relative;
    width: 100%;
  }

  .page-row {
    position: absolute;
    left: 0;
    right: 0;
    display: flex;
    align-items: center;

    gap: 2px;
    border-radius: var(--radius);

    padding-left: calc(var(--depth) * 0.75rem);

    padding-right: 4px;

    cursor: grab;
  }
  .page-row:active {
    cursor: grabbing;
  }

  .page-row:hover {
    background-color: var(--bg-hover);
  }
  .page-row.active {
    background-color: var(--bg-active);
  }

  .page-row.dragging {
    opacity: 0.4;
  }

  .page-row.drop-before::after,
  .page-row.drop-after::after {
    content: "";
    position: absolute;
    left: calc(var(--depth) * 0.75rem + 18px);
    right: 6px;
    height: 2px;
    border-radius: 2px;
    background-color: var(--accent);
    pointer-events: none;
  }
  .page-row.drop-before::after {
    top: -1px;
  }
  .page-row.drop-after::after {
    bottom: -1px;
  }

  .page-row.drop-inside {
    box-shadow: inset 0 0 0 2px var(--accent);
  }

  .twisty,
  .twisty-spacer {
    flex: 0 0 auto;
    width: 18px;
    height: 26px;
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

  .page-item {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    flex: 1 1 auto;
    min-width: 0;

    padding: 0.45rem 0.45rem;
    border: none;
    border-radius: var(--radius);
    background: transparent;
    color: var(--text);
    font-size: 0.9rem;
    text-align: left;
    cursor: pointer;
  }

  /*
   * 4px either side inside the button plus the row's 2px gap equals the page-item's padding and
   * gap.
   */
  .lock-badge {
    display: inline-flex;
    flex: 0 0 auto;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    margin-left: calc(0.45rem - 4px);
  }
  .page-item.after-lock {
    padding-left: calc(0.55rem - 6px);
  }

  .row-btn {
    opacity: 0;
  }
  .add-btn {
    font-size: 0.95rem;
  }
  .delete-btn {
    font-size: 15px;
  }

  .page-row:hover .row-btn,
  .row-btn:focus-visible {
    opacity: 1;
  }

  .page-row:hover .row-btn[aria-disabled="true"],
  .row-btn[aria-disabled="true"]:focus-visible {
    opacity: 0.7;
  }

  .row-btn[aria-disabled="true"] {
    cursor: not-allowed;
  }
  /* Refused rather than dead: a filled accent would promise the click goes through. */
  .row-btn[aria-disabled="true"]:hover {
    background: var(--accent-soft);
    border-color: transparent;
    color: var(--accent-ink);
  }

  .nav-icon {
    display: inline-flex;
    align-items: center;
    flex: 0 0 auto;
    font-size: 1rem;

    color: var(--accent);
    transform: translateY(-1px);
  }
  .nav-icon :global(svg) {
    display: block;
  }

  .page-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* in the middle of the empty list, both ways */
  .empty {
    margin: auto;
    color: var(--text-subtle);
    font-size: 0.85rem;
    padding: 0.5rem;
    text-align: center;
  }

  .footer {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 0.5rem;
    border-top: 1px solid var(--border);
  }

  .footer-btn {
    flex: 1 1 0;
    min-width: 0;
    height: 28px;
    gap: 0.35rem;
    font-size: 1rem;
  }

  .count {
    font-size: 0.75rem;
  }

  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent);
  }
</style>
