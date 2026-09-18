<script lang="ts">
  import { dictation, formatBytes } from "$lib/state/dictation.svelte";
  import Icon from "./Icon.svelte";
  import Button from "./Button.svelte";

  const status = $derived(dictation.status);
  const downloading = $derived(status.phase === "downloading");
  const transcribing = $derived(status.phase === "transcribing");

  const meter = $derived(Math.min(100, Math.sqrt(Math.min(1, dictation.level)) * 118));

  function dismissPrompt(): void {
    dictation.promptOpen = false;
  }

  async function accept(): Promise<void> {
    dictation.promptOpen = false;
    await dictation.downloadModel();
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key !== "Escape") return;
    if (dictation.promptOpen) {
      e.preventDefault();
      dismissPrompt();
    } else if (dictation.recording) {
      e.preventDefault();
      void dictation.cancel();
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />
{#if dictation.promptOpen}
  <div class="backdrop" onmousedown={dismissPrompt} role="presentation">
    <div
      class="prompt"
      onmousedown={(e) => e.stopPropagation()}
      role="dialog"
      aria-modal="true"
      aria-labelledby="dictation-prompt-title"
      tabindex="-1"
      data-testid="dictation-prompt"
    >
      <h2 class="prompt-title" id="dictation-prompt-title">
        Download the dictation model
      </h2>
      <p class="prompt-body">
        Dictation runs on this computer. Your voice never leaves it. Set needs to download
        {status.modelLabel} ({status.modelParameters} parameters) once.
      </p>
      <dl class="costs">
        <div>
          <dt>Download size</dt>
          <dd>{formatBytes(status.modelBytes)}</dd>
        </div>
        <div>
          <dt>Memory used while transcribing</dt>
          <dd>about {formatBytes(status.modelMemoryBytes)}</dd>
        </div>
      </dl>
      <p class="prompt-note">
        You can remove it again at any time in Settings → Other, and get the space back.
      </p>
      <div class="prompt-actions">
        <Button size="md" onclick={dismissPrompt}>Not now</Button>
        <Button size="md" variant="primary" onclick={accept}>Download</Button>
      </div>
    </div>
  </div>
{/if}

{#if dictation.recording || downloading || transcribing}
  <div class="bar" role="status" aria-live="polite" data-testid="dictation-bar">
    {#if downloading}
      <span class="glyph"><Icon name="mic" /></span>
      <div class="downloading">
        <span class="label">
          Downloading {status.modelLabel}: {formatBytes(status.downloaded)} of {formatBytes(
            status.modelBytes,
          )}
        </span>
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
      </div>
      <button
        type="button"
        class="control quiet dismiss danger"
        aria-label="Cancel the download"
        title="Cancel the download"
        onclick={() => dictation.cancelDownload()}
      >
        <Icon name="close" />
      </button>
    {:else if transcribing}
      <span class="glyph"><Icon name="mic" /></span>
      <span class="label">Transcribing…</span>
      <span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>
    {:else}
      <span class="glyph live"><Icon name="mic" /></span>
      <span class="label">Listening…</span>
      <div class="meter" aria-hidden="true">
        <span class="meter-fill" style="width: {meter}%"></span>
      </div>
      <Button onclick={() => dictation.cancel()}>Discard</Button>
      <Button variant="primary" onclick={() => dictation.stop()}>Insert text</Button>
    {/if}
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 140;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1rem;
    background: oklch(0% 0 0 / 0.45);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
  }

  .prompt {
    width: min(30rem, calc(100vw - 2rem));
    padding: 1.25rem 1.35rem 1.1rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: calc(var(--radius) * 2);
    box-shadow: var(--shadow-pop);
  }

  .prompt-title {
    margin: 0 0 0.55rem;
    font-size: 1rem;
    font-weight: 600;
    color: var(--text);
  }

  .prompt-body {
    margin: 0;
    font-size: 0.85rem;
    line-height: 1.55;
    color: var(--text-muted);
  }

  .costs {
    margin: 0.9rem 0 0;
    padding: 0.6rem 0.75rem;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    font-size: 0.82rem;
  }
  .costs div {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 1rem;
  }
  .costs div + div {
    margin-top: 0.35rem;
  }
  .costs dt {
    color: var(--text-muted);
  }
  .costs dd {
    margin: 0;
    color: var(--text);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .prompt-note {
    margin: 0.7rem 0 0;
    font-size: 0.78rem;
    line-height: 1.5;
    color: var(--text-subtle);
  }

  .prompt-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 1.1rem;
  }

  .bar {
    position: fixed;
    left: 50%;
    bottom: 1.5rem;
    transform: translateX(-50%);
    z-index: 120;
    display: flex;
    align-items: center;
    gap: 0.6rem;
    max-width: calc(100vw - 2rem);
    padding: 0.5rem 0.6rem 0.5rem 0.85rem;
    background:
      linear-gradient(var(--surface-tint), var(--surface-tint)), var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 999px;
    box-shadow: 0 8px 28px oklch(0% 0 0 / 0.28);
    animation: rise 0.2s cubic-bezier(0.22, 0.8, 0.2, 1) both;
  }
  @keyframes rise {
    from {
      opacity: 0;
      transform: translate(-50%, 8px);
    }
    to {
      opacity: 1;
      transform: translate(-50%, 0);
    }
  }

  .glyph {
    display: inline-flex;
    flex: 0 0 auto;
    font-size: 1rem;
    color: var(--text-subtle);
  }

  .glyph.live {
    color: var(--danger);
    animation: pulse 1.6s ease-in-out infinite;
  }
  @keyframes pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.45;
    }
  }

  .label {
    flex: 0 1 auto;
    font-size: 0.82rem;
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .meter {
    flex: 0 0 auto;
    width: 5.5rem;
    height: 0.35rem;
    border-radius: 999px;
    background: var(--bg-hover);
    overflow: hidden;
  }
  .meter-fill {
    display: block;
    height: 100%;
    background: var(--accent);
    border-radius: inherit;

    transition: width 0.12s ease-out;
  }

  .downloading {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    min-width: 0;
  }
  .progress {
    width: 16rem;
    max-width: 100%;
    height: 0.35rem;
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

  .dismiss {
    width: 1.6rem;
    height: 1.6rem;
    font-size: 0.85rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  .dots {
    display: inline-flex;
    gap: 0.2rem;
    padding-right: 0.25rem;
  }
  .dots i {
    width: 0.3rem;
    height: 0.3rem;
    border-radius: 50%;
    background: var(--text-subtle);
    animation: blink 1.2s ease-in-out infinite;
  }
  .dots i:nth-child(2) {
    animation-delay: 0.16s;
  }
  .dots i:nth-child(3) {
    animation-delay: 0.32s;
  }
  @keyframes blink {
    0%,
    100% {
      opacity: 0.25;
    }
    50% {
      opacity: 1;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .bar {
      animation: none;
    }
    .glyph.live,
    .dots i {
      animation: none;
    }
    .dots i {
      opacity: 0.6;
    }
  }
</style>
