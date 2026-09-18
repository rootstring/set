<script lang="ts">
  import type { Snippet } from "svelte";

  import { dictation, formatBytes } from "$lib/state/dictation.svelte";
  import Button from "../Button.svelte";

  interface Props {
    extra?: Snippet;
    showPath?: boolean;
  }

  let { extra, showPath = false }: Props = $props();

  const status = $derived(dictation.status);
  const downloading = $derived(status.phase === "downloading");
</script>

<div class="model" data-testid="dictation-model">
  <div class="model-head">
    <span class="model-name">
      {status.modelLabel}
    </span>
    <span class="state" class:on={status.modelInstalled}>
      {#if downloading}
        Downloading {Math.round(dictation.downloadProgress * 100)}%
      {:else if status.modelInstalled}
        Installed
      {:else}
        Not downloaded
      {/if}
    </span>
  </div>
  <dl class="costs">
    <div>
      <dt>Download &amp; disk</dt>
      <dd>{formatBytes(status.modelBytes)}</dd>
    </div>
    <div>
      <dt>Memory while transcribing</dt>
      <dd>about {formatBytes(status.modelMemoryBytes)}</dd>
    </div>
  </dl>
  {#if downloading}
    <div class="row">
      <div
        class="progress"
        role="progressbar"
        aria-valuemin="0"
        aria-valuemax="100"
        aria-valuenow={Math.round(dictation.downloadProgress * 100)}
      >
        <span class="progress-fill" style="width: {dictation.downloadProgress * 100}%"
        ></span>
      </div>
      <Button onclick={() => dictation.cancelDownload()}>Cancel</Button>
    </div>
    <p class="set-hint wide">
      {formatBytes(status.downloaded)} of {formatBytes(status.modelBytes)}.
    </p>
  {:else if !status.modelInstalled}
    <div class="row">
      <Button variant="primary" onclick={() => dictation.downloadModel()}>
        Download
      </Button>
    </div>
  {/if}

  {@render extra?.()}
  {#if showPath && status.modelPath}
    <p class="set-path" title={status.modelPath}>{status.modelPath}</p>
  {/if}
</div>

<style>
  .model {
    padding: 0.75rem 0.85rem;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }

  .model-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 1rem;
  }
  .model-name {
    font-size: 0.9rem;
    font-weight: 600;
    color: var(--text);
  }

  .state {
    flex: 0 0 auto;
    font-size: 0.78rem;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .state.on {
    color: var(--accent);
    font-weight: 600;
  }

  .costs {
    margin: 0.7rem 0 0;
    font-size: 0.8rem;
  }
  .costs div {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 1rem;
  }
  .costs div + div {
    margin-top: 0.25rem;
  }
  .costs dt {
    color: var(--text-muted);
  }
  .costs dd {
    margin: 0;
    color: var(--text);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.85rem;
  }

  .progress {
    flex: 1;
    min-width: 0;
    height: 0.4rem;
    border-radius: 999px;
    background: var(--bg-hover);
    overflow: hidden;
  }
  .progress-fill {
    display: block;
    height: 100%;
    background: var(--accent);
    border-radius: inherit;
    transition: width 0.2s ease-out;
  }

  .set-hint.wide {
    max-width: none;
  }
</style>
