<script lang="ts">
  import { dictation } from "$lib/state/dictation.svelte";
  import { settings, formatShortcut } from "$lib/state/settings.svelte";
  import DictationModel from "../settings/DictationModel.svelte";
  import Field from "../settings/Field.svelte";
  import LanguagePicker from "../settings/LanguagePicker.svelte";

  const status = $derived(dictation.status);
  const downloading = $derived(status.phase === "downloading");

  $effect(() => {
    void dictation.refresh();
  });

  const dictateKey = $derived(
    settings.dictateShortcut ? formatShortcut(settings.dictateShortcut) : "",
  );
</script>

<section class="ob-step">
  <h2 class="ob-title">Dictation</h2>
  <p class="ob-lede">
    Set can turn speech into text locally on this computer. You can download the following
    asset if you want to enable this feature.
  </p>
  <div class="card" data-testid="onboarding-dictation">
    <DictationModel />
  </div>
  {#if status.modelInstalled || downloading}
    <Field label="Language" htmlFor="onboarding-dictation-language">
      <LanguagePicker id="onboarding-dictation-language" />
    </Field>
  {/if}

  <p class="set-hint">
    {#if downloading}
      You can continue. It keeps downloading while you finish setup.
    {:else if status.modelInstalled}
      Dictate into any page with <code>/dictate</code>{dictateKey
        ? `, or ${dictateKey}`
        : ""}.
    {:else}
      You can also download later from your settings.
    {/if}
  </p>
</section>

<style>
  .card {
    margin-bottom: 1.2rem;
  }

  .set-hint code {
    font-family: var(--font-mono);
    font-size: 0.95em;
  }
</style>
