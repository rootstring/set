<script lang="ts">
  import Button from "./Button.svelte";
  import type { ConflictChoice } from "$lib/state/workspace.svelte";

  interface Props {
    title: string;
    onChoose: (choice: ConflictChoice) => void;
  }

  let { title, onChoose }: Props = $props();

  const name = $derived(title.trim() || "Untitled");

  let keepBoth = $state<HTMLButtonElement>();
  $effect(() => {
    keepBoth?.focus();
  });
</script>

<div class="backdrop">
  <div class="dialog" role="dialog" aria-modal="true" aria-label="File changed on disk">
    <h2 class="title">“{name}” changed on disk</h2>
    <p class="message">
      Another app edited this page while you had unsaved changes. Choose which version to
      keep.
    </p>
    <div class="actions">
      <Button size="md" onclick={() => onChoose("keep-mine")}>Keep Set’s version</Button>
      <Button size="md" onclick={() => onChoose("take-theirs")}>Load from disk</Button>
      <Button
        bind:ref={keepBoth}
        variant="primary"
        size="md"
        onclick={() => onChoose("keep-both")}
      >
        Keep both
      </Button>
    </div>
    <p class="hint">
      Keeping both loads the version from disk and saves yours alongside it as a separate
      page.
    </p>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;

    z-index: 200;
    display: flex;
    align-items: center;
    justify-content: center;
    background: oklch(0% 0 0 / 0.45);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
  }

  .dialog {
    width: min(440px, calc(100vw - 2rem));
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: calc(var(--radius) * 2);
    box-shadow: var(--shadow-pop);
    padding: 1.25rem;
  }

  .title {
    margin: 0 0 0.5rem;
    font-size: 1rem;
    font-weight: 600;
    color: var(--text);
  }

  .message {
    margin: 0 0 1.25rem;
    font-size: 0.9rem;
    line-height: 1.4;
    color: var(--text-muted);
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;

    flex-wrap: wrap;
  }

  .hint {
    margin: 0.75rem 0 0;
    font-size: 0.8rem;
    line-height: 1.4;
    color: var(--text-muted);
    text-align: right;
  }
</style>
