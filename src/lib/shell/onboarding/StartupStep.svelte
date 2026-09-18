<script lang="ts">
  import { startup } from "$lib/state/startup.svelte";
  import Segmented from "../settings/Segmented.svelte";
  import type { Opt } from "../settings/shared";

  const TOGGLE_OPTS: Opt[] = [
    { value: "on", label: "On" },
    { value: "off", label: "Off" },
  ];

  $effect(() => {
    void startup.refresh();
  });

  let failed = $state(false);

  async function choose(value: string): Promise<void> {
    failed = !(await startup.set(value === "on"));
  }
</script>

<section class="ob-step">
  <h2 class="ob-title">Open Set when you log in?</h2>
  <p class="ob-lede">Sync and outside edits only work while Set is running.</p>
  <div class="choice">
    <Segmented
      label="Start at login"
      options={TOGGLE_OPTS}
      value={startup.enabled ? "on" : "off"}
      {choose}
    />
  </div>
  {#if failed}
    <p class="ob-error" role="alert">
      Couldn't change the login item. Try again in Settings → Other.
    </p>
  {:else}
    <p class="set-hint">You can change this in Settings → Other.</p>
  {/if}
</section>

<style>
  .choice {
    display: flex;
    margin-bottom: 1.2rem;
  }
</style>
