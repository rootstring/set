<script lang="ts">
  import { dictation, formatBytes } from "$lib/state/dictation.svelte";
  import Button from "../Button.svelte";
  import DictationModel from "./DictationModel.svelte";
  import Field from "./Field.svelte";
  import LanguagePicker from "./LanguagePicker.svelte";
  import type { TabContext } from "./shared";

  let { ctx }: { ctx: TabContext } = $props();

  const status = $derived(dictation.status);
  const downloading = $derived(status.phase === "downloading");

  $effect(() => {
    void dictation.refresh();
  });

  function tryIt(): void {
    ctx.close();
    void dictation.begin();
  }

  let removeEl = $state<HTMLButtonElement>();

  function removeModel(): void {
    ctx.confirm({
      anchor: removeEl,
      title: "Remove the dictation model?",
      message: `Frees ${formatBytes(status.modelBytes)}. You can download it again.`,
      confirmLabel: "Remove",
      danger: true,
      onConfirm: async () => {
        await dictation.deleteModel();
        ctx.flash("Dictation model removed");
      },
    });
  }
</script>

<section class="set-section">
  <div class="set-section-head">
    <h3 class="set-section-title">Dictation</h3>
    {#if status.available && status.modelInstalled}
      <Button bind:ref={removeEl} tone="danger" onclick={removeModel}>Remove model</Button
      >
    {/if}
  </div>
  <p class="set-hint wide">Speech to text on your computer.</p>
  {#if !status.available}
    <p class="set-hint wide">This build of Set was made without dictation.</p>
  {:else}
    <div class="card">
      <DictationModel showPath>
        {#snippet extra()}
          {#if status.modelInstalled && !downloading}
            <div class="row">
              <Button variant="primary" onclick={tryIt} disabled={dictation.busy}>
                Try it
              </Button>
            </div>
          {/if}
        {/snippet}
      </DictationModel>
    </div>
    <Field label="Language" htmlFor="dictation-language">
      <LanguagePicker id="dictation-language" />
    </Field>
  {/if}
</section>

<style>
  .set-hint.wide {
    max-width: none;
  }

  .card {
    margin: 0.9rem 0 1.2rem;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.85rem;
  }
</style>
