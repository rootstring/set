<script lang="ts">
  import { settings } from "$lib/state/settings.svelte";
  import { updates } from "$lib/state/updates.svelte";
  import Button from "../Button.svelte";

  // The check, download and restart are all Tauri commands.
  const shown = updates.ready;

  const note = $derived.by(() => {
    switch (updates.status) {
      case "checking":
        return "Checking…";
      case "downloading": {
        const fraction = updates.fraction;
        return fraction === null
          ? "Downloading…"
          : `Downloading… ${Math.round(fraction * 100)}%`;
      }
      case "available":
        return `You're on v${settings.appVersion}.`;
      case "installed":
        return "Installed.";
      default:
        if (updates.lastError) return "Couldn't reach the update feed.";
        return updates.checked
          ? `Up to date, v${settings.appVersion}.`
          : `v${settings.appVersion}.`;
    }
  });
</script>

{#if shown}
  <section class="set-section">
    <div class="set-section-head">
      <h3 class="set-section-title">Updates</h3>
      {#if updates.status === "available"}
        <Button variant="primary" onclick={() => void updates.install()}>
          Download v{updates.available?.version}
        </Button>
      {:else if updates.status === "installed"}
        <Button variant="primary" onclick={() => void updates.restart()}>
          Restart to finish
        </Button>
      {:else}
        <Button
          disabled={updates.status === "checking" || updates.status === "downloading"}
          onclick={() => void updates.check()}
        >
          Check now
        </Button>
      {/if}
    </div>
    <p class="set-hint" title={updates.lastError ?? undefined} aria-live="polite">
      {note}
    </p>
  </section>
{/if}
