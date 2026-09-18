<script lang="ts">
  import { dictation } from "$lib/state/dictation.svelte";
  import Titlebar from "../Titlebar.svelte";
  import Button from "../Button.svelte";
  import FolderStep from "./FolderStep.svelte";
  import ImportStep from "./ImportStep.svelte";
  import DictationStep from "./DictationStep.svelte";
  import LookStep from "./LookStep.svelte";
  import StartupStep from "./StartupStep.svelte";

  interface Props {
    onDone: () => void;
  }

  let { onDone }: Props = $props();

  type StepId = "folder" | "import" | "dictation" | "look" | "startup";

  const steps = $derived<{ id: StepId; label: string }[]>([
    { id: "folder", label: "Notes folder" },
    { id: "look", label: "Look and feel" },
    ...(dictation.offered ? [{ id: "dictation" as const, label: "Dictation" }] : []),
    { id: "import", label: "Import" },
    { id: "startup", label: "At login" },
  ]);

  let index = $state(0);

  const current = $derived(steps[Math.min(index, steps.length - 1)]);
  const last = $derived(index >= steps.length - 1);

  function back(): void {
    if (index > 0) index -= 1;
  }

  function next(): void {
    if (last) onDone();
    else index += 1;
  }
</script>

<div class="onboarding" role="dialog" aria-modal="true" aria-label="Set up Set">
  <Titlebar />
  <div class="frame">
    <header class="head">
      <ol class="rail">
        {#each steps as step, i (step.id)}
          <li
            class="rail-step"
            class:done={i < index}
            class:now={i === index}
            aria-current={i === index ? "step" : undefined}
          >
            <span class="rail-num">{i + 1}</span>
            <span class="rail-label">{step.label}</span>
          </li>
        {/each}
      </ol>
      <button type="button" class="control quiet skip" onclick={onDone}>
        Skip setup
      </button>
    </header>
    <div class="stage">
      {#key current.id}
        <div class="step-in">
          {#if current.id === "folder"}
            <FolderStep />
          {:else if current.id === "look"}
            <LookStep />
          {:else if current.id === "dictation"}
            <DictationStep />
          {:else if current.id === "startup"}
            <StartupStep />
          {:else}
            <ImportStep />
          {/if}
        </div>
      {/key}
    </div>
    <footer class="foot">
      <span class="foot-start">
        {#if index > 0}
          <Button size="md" onclick={back}>Back</Button>
        {/if}
      </span>
      <Button variant="primary" size="md" onclick={next}>
        {last ? "Start writing" : "Continue"}
      </Button>
    </footer>
  </div>
</div>

<style>
  .onboarding {
    position: fixed;
    inset: 0;
    z-index: 140;
    display: flex;
    flex-direction: column;
    /* Same ground as the editor, so a tint picked on the Look step lands here. */
    background: var(--editor-bg);
    color: var(--text);
  }

  .frame {
    --gutter: 1.25rem;
    box-sizing: border-box;
    width: min(940px, 100vw - 2rem);

    --frame-h: min(80vh, 620px);

    --stage-h: calc(var(--frame-h) - 11rem);
    height: var(--frame-h);
    margin: auto;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  .head {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 1rem;
    min-height: 3.4rem;
    padding: 0 var(--gutter);
    border-bottom: 1px solid var(--border);
  }

  .rail {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 1.5rem;
    margin: 0;
    padding: 0;
    list-style: none;
    min-width: 0;
    overflow: hidden;
  }
  .rail-step {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.82rem;
    color: var(--text-subtle);
    white-space: nowrap;
    transition: color 0.15s ease;
  }

  .rail-num {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    width: 1.4rem;
    height: 1.4rem;
    border-radius: 50%;
    box-shadow: inset 0 0 0 1px var(--border);
    font-size: 0.72rem;
    font-variant-numeric: tabular-nums;
    transition:
      background 0.15s ease,
      box-shadow 0.15s ease,
      color 0.15s ease;
  }
  .rail-step.done {
    color: var(--text-muted);
  }
  .rail-step.done .rail-num {
    box-shadow: inset 0 0 0 1px var(--accent-soft);
    color: var(--text-muted);
  }
  .rail-step.now {
    color: var(--text);
    font-weight: 600;
  }
  .rail-step.now .rail-num {
    background: var(--accent);
    color: var(--on-accent);
    box-shadow: none;
  }

  @media (max-width: 820px) {
    .rail-label {
      display: none;
    }
  }

  .skip {
    flex: 0 0 auto;
    font-size: 0.8rem;
    padding: 0.25rem 0.5rem;
    color: var(--text-muted);
  }

  .stage {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    padding: 2rem var(--gutter) 1.75rem;
  }

  .step-in {
    margin: auto 0;
    animation: step-in 0.26s cubic-bezier(0.22, 0.8, 0.2, 1) both;
  }
  @keyframes step-in {
    from {
      opacity: 0;
      transform: translateY(8px);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .step-in {
      animation: none;
    }
  }

  .foot {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.85rem var(--gutter);
    border-top: 1px solid var(--border);
  }
  .foot-start {
    flex: 1;
    display: flex;
    align-items: center;
    min-height: 2rem;
  }
</style>
