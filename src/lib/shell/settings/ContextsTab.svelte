<script lang="ts">
  import { workspace } from "$lib/state/workspace.svelte";
  import Icon from "../Icon.svelte";
  import { settings, formatShortcut, contextShortcut } from "$lib/state/settings.svelte";
  import { checkContextName } from "../context-name";
  import Button from "../Button.svelte";
  import type { TabContext } from "./shared";
  import { askDelete } from "$lib/state/confirm.svelte";

  let { ctx }: { ctx: TabContext } = $props();

  let editing = $state<string | null>(null);
  let draft = $state("");
  let draftEl = $state<HTMLInputElement>();

  let adding = $state(false);
  let newName = $state("");
  let newEl = $state<HTMLInputElement>();

  const contexts = $derived(settings.orderContexts(workspace.contexts));
  const names = $derived(contexts.map((c) => c.name));

  const newVerdict = $derived(checkContextName(newName, names));
  const renameVerdict = $derived(checkContextName(draft, names, editing ?? undefined));

  function beginRename(name: string): void {
    adding = false;
    editing = name;
    draft = name;
  }

  function cancelRename(): void {
    editing = null;
    draft = "";
  }

  async function commitRename(): Promise<void> {
    const from = editing;

    if (!from || !renameVerdict.ok || renameVerdict.name === from) {
      cancelRename();
      return;
    }
    const to = renameVerdict.name;
    cancelRename();
    await workspace.renameContext(from, to);
  }

  async function commitNew(): Promise<void> {
    if (!newVerdict.ok) return;
    const wanted = newVerdict.name;
    adding = false;
    newName = "";
    const created = await workspace.createContext(wanted);

    if (created) ctx.close();
  }

  function cancelNew(): void {
    adding = false;
    newName = "";
  }

  function remove(name: string, anchor: HTMLElement): void {
    const held = workspace.contexts.find((c) => c.name === name)?.pages ?? 0;
    if (workspace.contexts.length <= 1) {
      ctx.flash("Your notes keep at least one context.", "warn");
      return;
    }
    askDelete({
      anchor,
      title: `Delete “${name}”`,
      message: held
        ? `Move “${name}” and its ${held} ${held === 1 ? "page" : "pages"} to Trash? ` +
          `You can restore it later.`
        : `Move “${name}” to Trash? You can restore it later.`,
      confirmLabel: "Delete context",
      onConfirm: (asked) => void workspace.deleteContext(name, { undoable: !asked }),
    });
  }

  function onRenameKeydown(event: KeyboardEvent): void {
    if (event.key === "Enter") {
      event.preventDefault();
      void commitRename();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation(); // don't also close the panel
      cancelRename();
    }
  }

  function onNewKeydown(event: KeyboardEvent): void {
    if (event.key === "Enter") {
      event.preventDefault();
      void commitNew();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cancelNew();
    }
  }

  function reorder(name: string, delta: -1 | 1): void {
    const i = names.indexOf(name);
    move(i, i + delta);
  }

  function move(from: number, to: number): void {
    if (from === -1 || to < 0 || to >= names.length || from === to) return;
    const next = [...names];
    const [row] = next.splice(from, 1);
    next.splice(to, 0, row);
    settings.setContextOrder(next);
  }

  let dragging = $state<number | null>(null);

  let dropAt = $state<number | null>(null);

  function onDragStart(event: DragEvent, i: number): void {
    dragging = i;
    event.dataTransfer?.setData("text/plain", names[i]);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
  }

  function onDragOver(event: DragEvent, i: number): void {
    if (dragging === null) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";

    const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
    dropAt = event.clientY < box.top + box.height / 2 ? i : i + 1;
  }

  function onDrop(event: DragEvent): void {
    event.preventDefault();
    if (dragging !== null && dropAt !== null) {
      move(dragging, dropAt > dragging ? dropAt - 1 : dropAt);
    }
    endDrag();
  }

  function endDrag(): void {
    dragging = null;
    dropAt = null;
  }

  function onGripKeydown(event: KeyboardEvent, name: string): void {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    reorder(name, event.key === "ArrowUp" ? -1 : 1);

    queueMicrotask(() => {
      const at = names.indexOf(name);
      gripEls[at]?.focus();
    });
  }

  let gripEls = $state<(HTMLButtonElement | undefined)[]>([]);

  $effect(() => {
    if (editing) draftEl?.focus();
  });
  $effect(() => {
    if (adding) newEl?.focus();
  });
</script>

<section class="set-section">
  <div class="set-section-head">
    <h3 class="set-section-title">Contexts</h3>
    <Button onclick={() => ((adding = true), (editing = null))} disabled={adding}>
      New
    </Button>
  </div>
  <p class="set-hint">Separate areas for your notes, like Work and Personal.</p>
  <ul
    class="contexts"
    ondragover={(e) => dragging !== null && e.preventDefault()}
    ondrop={onDrop}
    ondragend={endDrag}
  >
    {#each contexts as context, i (context.name)}
      <li
        class="context"
        class:current={context.name === workspace.activeContext}
        class:dragging={dragging === i}
        class:drop-above={dropAt === i}
        class:drop-below={dropAt === i + 1 && i === contexts.length - 1}
        draggable={editing === null && !adding}
        ondragstart={(e) => onDragStart(e, i)}
        ondragover={(e) => onDragOver(e, i)}
      >
        <button
          type="button"
          class="grip"
          bind:this={gripEls[i]}
          title="Drag to reorder, or ↑/↓ when focused"
          aria-label="Reorder “{context.name}” with arrow keys"
          onkeydown={(e) => onGripKeydown(e, context.name)}
        >
          <svg viewBox="0 0 10 16" width="10" height="16" aria-hidden="true">
            {#each [4, 8, 12] as y}
              <circle cx="3.5" cy={y} r="1" fill="currentColor" />
              <circle cx="7" cy={y} r="1" fill="currentColor" />
            {/each}
          </svg>
        </button>
        {#if i < 9}
          <kbd class="key">{formatShortcut(contextShortcut(i + 1))}</kbd>
        {:else}
          <span class="key key-none"></span>
        {/if}

        {#if editing === context.name}
          <div class="name-cell">
            <input
              class="name-input"
              type="text"
              aria-label="Rename “{context.name}”"
              aria-invalid={!!renameVerdict.error}
              bind:value={draft}
              bind:this={draftEl}
              onkeydown={onRenameKeydown}
              onblur={commitRename}
              data-testid="context-rename-input"
            />
            {#if renameVerdict.error}
              <p class="name-note bad" data-testid="context-rename-note">
                {renameVerdict.error}
              </p>
            {:else if renameVerdict.note}
              <p class="name-note">{renameVerdict.note}</p>
            {/if}
          </div>
        {:else}
          <span class="name" data-testid="context-row-name">{context.name}</span>
        {/if}

        <span class="count">
          {context.pages}
          {context.pages === 1 ? "page" : "pages"}
        </span>
        <span class="row-actions">
          <button
            type="button"
            class="control quiet row-action"
            title="Rename “{context.name}”"
            aria-label="Rename “{context.name}”"
            onclick={() => beginRename(context.name)}
            data-testid="context-rename"
          >
            <svg
              viewBox="0 0 16 16"
              width="13"
              height="13"
              fill="none"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M11.2 2.8l2 2L6 12H4v-2z" />
              <path d="M2.5 14.5h11" />
            </svg>
          </button>
          <button
            type="button"
            class="control quiet danger row-action"
            title="Delete “{context.name}”"
            aria-label="Delete “{context.name}”"
            onclick={(e) => remove(context.name, e.currentTarget)}
          >
            <Icon name="trash" />
          </button>
        </span>
      </li>
    {/each}

    {#if adding}
      <li class="context adding">
        <span class="grip-space"></span>
        <span class="key key-none"></span>
        <div class="name-cell">
          <input
            class="name-input"
            type="text"
            placeholder="Context name"
            aria-label="New context name"
            aria-invalid={!!newVerdict.error}
            bind:value={newName}
            bind:this={newEl}
            onkeydown={onNewKeydown}
            data-testid="context-new-input"
          />
          <p class="name-note" class:bad={!!newVerdict.error} data-testid="context-note">
            {newVerdict.error ?? newVerdict.note ?? ""}
          </p>
        </div>
        <div class="add-actions">
          <Button onclick={cancelNew}>Cancel</Button>
          <Button variant="primary" onclick={commitNew} disabled={!newVerdict.ok}>
            Create
          </Button>
        </div>
      </li>
    {/if}
  </ul>
</section>

<style>
  .contexts {
    list-style: none;
    margin: 0.2rem 0 0;
    padding: 0;
  }

  .context {
    position: relative;
    display: flex;
    align-items: center;
    gap: 0.65rem;

    padding: 0.45rem 0.3rem;
    min-height: 2.9rem;

    border-radius: var(--radius);
  }
  .context:hover {
    background: var(--bg-hover);
  }
  .context.dragging {
    opacity: 0.4;
  }

  .context.drop-above::before,
  .context.drop-below::after {
    content: "";
    position: absolute;
    left: 0;
    right: 0;
    height: 2px;
    background: var(--accent);
  }
  .context.drop-above::before {
    top: -1px;
  }
  .context.drop-below::after {
    bottom: -1px;
  }

  .grip,
  .grip-space {
    flex: 0 0 auto;
    width: 1.25rem;
    height: 1.5rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    border: none;
    background: transparent;

    color: var(--text-subtle);
    opacity: 0.55;
    cursor: grab;
  }
  .grip:hover,
  .grip:focus-visible {
    opacity: 1;
    color: var(--text-muted);
    outline: none;
  }
  .grip:focus-visible {
    color: var(--accent);
    box-shadow: 0 0 0 2px var(--accent-soft);
    border-radius: 4px;
  }
  .context.dragging .grip {
    cursor: grabbing;
  }

  .name {
    margin-right: auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;

    padding: 2px 6px;
    border: 1px solid transparent;

    font-size: 0.85rem;
  }

  .context.current .name {
    font-weight: 600;
  }

  .name-cell {
    flex: 0 1 11rem;
    min-width: 0;
    margin-right: auto;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }

  .name-input {
    box-sizing: border-box;
    width: 100%;
    min-width: 0;
    padding: 2px 6px;
    border: 1px solid var(--accent);
    border-radius: calc(var(--radius) - 2px);
    background: var(--bg);
    color: var(--text);
    font: inherit;
    font-size: 0.85rem;
    text-align: left;
  }
  .name-input:focus {
    outline: none;
  }
  .name-input[aria-invalid="true"] {
    border-color: var(--danger);
  }

  .name-note {
    margin: 0;
    font-size: 0.7rem;
    line-height: 1.3;
    color: var(--text-muted);
  }
  .name-note.bad {
    color: var(--danger);
  }

  .key {
    flex: 0 0 auto;
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 3.1rem;
    height: 1.9rem;
    padding: 0 0.55rem;
    border-radius: var(--radius);
    background: var(--bg-hover);
    color: var(--text-muted);
    font-family: var(--font-body);
    font-size: 0.8rem;
    font-variant-numeric: tabular-nums;
  }

  .key-none {
    background: transparent;
  }

  .count {
    flex: 0 0 auto;
    white-space: nowrap;
    color: var(--text-muted);
    font-size: 0.8rem;
    font-variant-numeric: tabular-nums;
  }

  .row-actions {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;

    gap: 0.15rem;
    margin-left: 0.35rem;
  }
  .row-action {
    width: 1.9rem;
    height: 1.9rem;
    color: var(--text-subtle);
  }
  .context:hover .row-action,
  .context:focus-within .row-action {
    color: var(--text-muted);
  }

  .context .row-action:hover {
    color: var(--on-accent);
  }
  .context .row-action.danger:hover {
    color: oklch(100% 0 0);
  }

  .add-actions {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
  }
</style>
