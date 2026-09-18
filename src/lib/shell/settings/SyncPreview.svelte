<script lang="ts">
  import { sync, type PreviewRequest } from "$lib/state/sync.svelte";
  import {
    buildTree,
    changeLabel,
    changeTone,
    countsLabel,
    pageName,
    summarize,
    type SyncDiff,
    type TreeNode,
  } from "$lib/state/sync-preview";
  import Button from "../Button.svelte";
  import Icon from "../Icon.svelte";

  interface Props {
    request: PreviewRequest;
    onAnswer: (go: boolean) => void;
  }

  let { request, onAnswer }: Props = $props();

  /** Past this many, unchanged pages in a folder fold into one line. */
  const QUIET_SHOWN = 8;

  const tree = $derived(buildTree(request.preview));
  const summary = $derived(summarize(request.preview));
  const mass = $derived(request.preview.massTrash);

  const sides = $derived(
    [
      { name: "This device", counts: countsLabel(summary.here) },
      { name: request.peerName, counts: countsLabel(summary.there) },
    ].map((side) => ({ ...side, counts: side.counts || "Nothing changes" })),
  );

  const asides = $derived(
    [
      summary.merged > 0
        ? `${count(summary.merged, "note")} merged from both devices`
        : "",
      summary.conflicts > 0
        ? `${count(summary.conflicts, "note")} edited on both, with the older version kept as a copy`
        : "",
      summary.leftOut > 0
        ? `${count(summary.leftOut, "file")} left where ${summary.leftOut === 1 ? "it is" : "they are"}`
        : "",
    ].filter(Boolean),
  );

  function count(n: number, noun: string): string {
    return `${n} ${noun}${n === 1 ? "" : "s"}`;
  }

  function pages(n: number): string {
    return count(n, "page");
  }

  // Folders open onto what changes; anything clicked is remembered over that.
  let toggled = $state<Record<string, boolean>>({});
  const isOpen = (id: string, node: TreeNode) => toggled[id] ?? node.changed > 0;

  let revealed = $state<Record<string, boolean>>({});

  let selected = $state<string | null>(null);
  let diff = $state<SyncDiff | null>(null);
  let diffState = $state<"idle" | "loading" | "none">("idle");

  async function show(path: string): Promise<void> {
    if (selected === path) {
      selected = null;
      return;
    }
    selected = path;
    diff = null;
    diffState = "loading";
    const loaded = await sync.previewDiff(path);
    if (selected !== path) return; // another row was picked meanwhile
    diff = loaded;
    diffState = loaded ? "idle" : "none";
  }

  const selectedName = $derived(selected ? pageName(request.preview, selected) : "");

  let go = $state<HTMLButtonElement>();
  let cancel = $state<HTMLButtonElement>();
  $effect(() => {
    // The careful answer gets the focus when the question is a pointed one.
    (mass ? cancel : go)?.focus();
  });
</script>

{#snippet rows(nodes: TreeNode[], parent: string, depth: number)}
  {@const quiet = nodes.filter((n) => n.changed === 0)}
  {@const folded = quiet.length > QUIET_SHOWN && !revealed[parent]}
  {#each folded ? nodes.filter((n) => n.changed > 0) : nodes as node (node.key)}
    {@const id = `${parent}/${node.key}`}
    {@const change = node.change}
    {@const branch = node.children.length > 0}
    {@const open = branch && isOpen(id, node)}
    <li
      role="treeitem"
      aria-expanded={branch ? open : undefined}
      aria-selected={change?.diffable ? selected === change.path : undefined}
    >
      <div
        class="row {change ? changeTone(change) : ''}"
        class:quiet={node.changed === 0}
        class:selected={!!change && selected === change.path}
        style:padding-left="{0.35 + depth * 0.95}rem"
      >
        {#if branch}
          <button
            type="button"
            class="twisty"
            class:open
            aria-label={open ? `Close ${node.name}` : `Open ${node.name}`}
            onclick={() => (toggled[id] = !open)}
          >
            <Icon name="forward" />
          </button>
        {:else}
          <span class="twisty"></span>
        {/if}
        <span class="kind">
          <Icon
            name={node.kind === "page"
              ? "page"
              : node.kind === "file"
                ? "image"
                : "context"}
          />
        </span>
        {#if change?.diffable}
          <button
            type="button"
            class="name link"
            title="See what changes"
            onclick={() => show(change.path)}>{node.name}</button
          >
        {:else}
          <span class="name">{node.name}</span>
        {/if}
        {#if change}
          {@const from = change.here?.from ?? change.there?.from}
          {@const label = changeLabel(change, request.peerName)}
          <span
            class="what"
            title={from ? `${label}, from ${from.replace(/\.md$/i, "")}` : label}
            >{label}</span
          >
        {:else if branch && !open && node.changed > 0}
          <span class="what">{count(node.changed, "change")}</span>
        {/if}
      </div>
      {#if open}
        <ul role="group">
          {@render rows(node.children, id, depth + 1)}
        </ul>
      {/if}
    </li>
  {/each}
  {#if folded}
    <li role="none">
      <button
        type="button"
        class="row more"
        style:padding-left="{0.35 + depth * 0.95 + 1.15}rem"
        onclick={() => (revealed[parent] = true)}
      >
        and {quiet.length} that stay as they are
      </button>
    </li>
  {/if}
{/snippet}

<section class="preview" data-testid="sync-preview" aria-label="Sync preview">
  <h3 class="title">Sync with {request.peerName}?</h3>
  <p class="set-hint">
    Nothing has changed yet. Confirm the following changes before syncing.
  </p>

  {#if mass}
    <p class="mass" role="alert" data-testid="sync-preview-mass">
      This moves
      {[
        mass.here > 0 ? `${pages(mass.here)} to the Trash on this device` : "",
        mass.there > 0 ? `${pages(mass.there)} to the Trash on ${request.peerName}` : "",
      ]
        .filter(Boolean)
        .join(" and ")}. If that isn't what you meant, check that both devices are on the
      right notes folder before going on.
    </p>
  {/if}

  <dl class="summary">
    <!-- By position: a device can be called anything, "This device" included. -->
    {#each sides as side, i (i)}
      <div>
        <dt>{side.name}</dt>
        <dd>{side.counts}</dd>
      </div>
    {/each}
  </dl>
  {#if asides.length > 0}
    <p class="set-hint">{asides.join(". ")}.</p>
  {/if}

  <div class="panes" class:split={selected !== null}>
    <ul class="tree" role="tree" aria-label="Notes folder after this sync">
      {@render rows(tree, "", 0)}
    </ul>

    {#if selected !== null}
      <div class="diff" data-testid="sync-preview-diff">
        <div class="diff-head">
          <span class="diff-name">{selectedName}</span>
          <span class="diff-side">
            {#if diff}
              {diff.side === "here" ? "on this device" : `on ${request.peerName}`}
            {/if}
          </span>
          <button
            type="button"
            class="control quiet diff-close"
            aria-label="Close the comparison"
            onclick={() => (selected = null)}
          >
            <Icon name="close" />
          </button>
        </div>
        {#if diffState === "loading"}
          <p class="diff-note">Comparing…</p>
        {:else if !diff}
          <p class="diff-note">There's no text to compare for this one.</p>
        {:else if diff.lines.length === 0}
          <p class="diff-note">
            The words are the same. Only how the file is saved differs.
          </p>
        {:else}
          <ol class="lines">
            {#each diff.lines as line, i (i)}
              {#if line.kind === "gap"}
                <li class="gap" aria-hidden="true">⋯</li>
              {:else}
                <li class={line.kind}>
                  <span class="sign" aria-hidden="true"
                    >{line.kind === "add" ? "+" : line.kind === "del" ? "−" : ""}</span
                  >
                  <span class="sr"
                    >{line.kind === "add"
                      ? "Added: "
                      : line.kind === "del"
                        ? "Removed: "
                        : ""}</span
                  >
                  <span class="text">{line.text || " "}</span>
                </li>
              {/if}
            {/each}
          </ol>
          {#if diff.truncated}
            <p class="diff-note">The change goes on past here.</p>
          {/if}
        {/if}
      </div>
    {/if}
  </div>

  <div class="actions">
    <Button bind:ref={cancel} size="md" onclick={() => onAnswer(false)}>Cancel</Button>
    <Button
      bind:ref={go}
      variant="primary"
      tone={mass ? "danger" : "neutral"}
      size="md"
      onclick={() => onAnswer(true)}
    >
      {mass ? "Sync anyway" : "Sync"}
    </Button>
  </div>
</section>

<style>
  .preview {
    --added: var(--hl-string);

    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  .title {
    margin: 0;
    font-size: 0.95rem;
    font-weight: 600;
    color: var(--text);
  }

  .mass {
    margin: 0.75rem 0 0;
    padding: 0.55rem 0.7rem;
    font-size: 0.8rem;
    line-height: 1.5;
    color: var(--text);
    border: 1px solid color-mix(in srgb, var(--danger) 45%, var(--border));
    border-radius: var(--radius);
    background: color-mix(in srgb, var(--danger) 8%, transparent);
  }

  .summary {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem 1.75rem;
    margin: 0.85rem 0 0;
  }
  .summary div {
    min-width: 0;
  }
  .summary dt {
    font-size: 0.72rem;
    color: var(--text-subtle);
  }
  .summary dd {
    margin: 0.1rem 0 0;
    font-size: 0.85rem;
    color: var(--text);
  }

  .panes {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 0.6rem;
    margin-top: 0.85rem;
  }
  .panes.split {
    grid-template-columns: minmax(0, 5fr) minmax(0, 6fr);
  }

  .tree,
  .diff {
    box-sizing: border-box;
    height: min(46vh, 26rem);
    overflow: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--bg-elevated);
  }

  .tree {
    margin: 0;
    padding: 0.3rem;
    list-style: none;
  }
  .tree ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    min-height: 1.6rem;
    padding-right: 0.45rem;
    border-radius: calc(var(--radius) - 2px);
    font-size: 0.8rem;
    color: var(--text);
  }
  .row.quiet {
    color: var(--text-muted);
  }
  .row.selected {
    background: var(--bg-active);
  }

  .twisty {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1rem;
    height: 1rem;
    padding: 0;
    border: 0;
    background: none;
    font-size: 0.7rem;
    color: var(--text-subtle);
    cursor: pointer;
    transition: transform 0.12s ease;
  }
  span.twisty {
    cursor: default;
  }
  .twisty.open {
    transform: rotate(90deg);
  }
  .twisty:focus-visible,
  .link:focus-visible,
  .more:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
    border-radius: 3px;
  }

  .kind {
    flex: none;
    display: inline-flex;
    font-size: 0.85rem;
    color: var(--text-subtle);
  }

  .name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .link {
    padding: 0;
    border: 0;
    background: none;
    font: inherit;
    color: inherit;
    text-align: left;
    cursor: pointer;
    text-decoration: underline;
    text-decoration-color: var(--text-subtle);
    text-decoration-style: dotted;
    text-underline-offset: 0.2em;
  }
  .link:hover {
    text-decoration-color: currentColor;
    text-decoration-style: solid;
  }

  .what {
    flex: none;
    max-width: 60%;
    margin-left: auto;
    padding-left: 0.6rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.72rem;
    color: var(--text-muted);
  }
  .row.add .what {
    color: var(--added);
  }
  .row.gone .what {
    color: var(--danger);
  }
  .row.gone .name {
    text-decoration: line-through;
    text-decoration-color: var(--text-subtle);
  }
  .row.warn .what {
    color: var(--warning);
  }

  .more {
    width: 100%;
    border: 0;
    background: none;
    font: inherit;
    font-size: 0.75rem;
    color: var(--text-subtle);
    cursor: pointer;
  }
  .more:hover {
    color: var(--text-muted);
  }

  .diff {
    display: flex;
    flex-direction: column;
  }
  .diff-head {
    position: sticky;
    top: 0;
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.3rem 0.3rem 0.3rem 0.6rem;
    border-bottom: 1px solid var(--border);
    background: var(--bg-elevated);
    font-size: 0.78rem;
  }
  .diff-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 600;
    color: var(--text);
  }
  .diff-side {
    flex: 1;
    white-space: nowrap;
    color: var(--text-subtle);
  }
  .diff-close {
    flex: none;
    width: 1.4rem;
    height: 1.4rem;
    font-size: 0.75rem;
  }
  .diff-note {
    margin: 0;
    padding: 0.6rem;
    font-size: 0.78rem;
    color: var(--text-muted);
  }

  .lines {
    margin: 0;
    padding: 0.3rem 0;
    list-style: none;
    font-family: var(--font-mono);
    font-size: 0.72rem;
    line-height: 1.55;
  }
  .lines li {
    display: flex;
    padding: 0 0.6rem 0 0;
    color: var(--text-muted);
  }
  .sign {
    flex: none;
    width: 1.4rem;
    text-align: center;
    user-select: none;
  }
  .text {
    min-width: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    user-select: text;
  }
  .lines .add {
    color: var(--text);
    background: color-mix(in srgb, var(--added) 14%, transparent);
  }
  .lines .add .sign {
    color: var(--added);
  }
  .lines .del {
    color: var(--text);
    background: color-mix(in srgb, var(--danger) 11%, transparent);
  }
  .lines .del .sign {
    color: var(--danger);
  }
  .lines .gap {
    justify-content: center;
    color: var(--text-subtle);
    user-select: none;
  }
  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 0.85rem;
  }

  @media (max-width: 720px) {
    .panes.split {
      grid-template-columns: minmax(0, 1fr);
    }
    .tree,
    .diff {
      height: min(34vh, 18rem);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .twisty {
      transition: none;
    }
  }
</style>
