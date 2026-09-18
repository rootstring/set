<script lang="ts">
  import { workspace } from "$lib/state/workspace.svelte";
  import { isExportBundle } from "$lib/storage/bundle";
  import Button from "../Button.svelte";
  import { message } from "$lib/utils/error";

  let busy = $state(false);
  let result = $state<{ imported: number; failed: number } | null>(null);
  let error = $state("");

  async function chooseFile(): Promise<void> {
    error = "";
    result = null;
    busy = true;
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const path = await open({
        multiple: false,
        filters: [{ name: "JSON", extensions: ["json"] }],
        title: "Choose an exported notes file",
      });
      if (typeof path !== "string") return;
      const { readTextFile } = await import("@tauri-apps/plugin-fs");
      const text = await readTextFile(path);
      const parsed: unknown = JSON.parse(text);
      if (!isExportBundle(parsed)) {
        error = "That doesn't look like a notes export from Set.";
        return;
      }
      result = await workspace.importBundle(parsed);
    } catch (e) {
      error = `Couldn't import: ${message(e)}`;
    } finally {
      busy = false;
    }
  }
</script>

<section class="ob-step">
  <h2 class="ob-title">Used Set on the web?</h2>
  <p class="ob-lede">
    Export your notes from Settings → Storage from your <a
      href="https://app.writewithset.com">browser</a
    >.
  </p>
  <div class="ob-actions">
    <Button size="md" onclick={chooseFile} disabled={busy}>
      {busy ? "Importing" : "Choose exported file"}
    </Button>
  </div>
  {#if error}
    <p class="ob-error" role="alert">{error}</p>
  {:else if result}
    <p class="set-hint" data-testid="onboarding-import-result">
      {#if result.imported === 0}
        Nothing in that file could be imported.
      {:else}
        Imported {result.imported} page{result.imported === 1 ? "" : "s"}.
        {#if result.failed > 0}
          {result.failed} couldn't be brought in.
        {/if}
      {/if}
    </p>
  {/if}
</section>
