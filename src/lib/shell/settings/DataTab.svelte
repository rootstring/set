<script lang="ts">
  import { getStore } from "$lib/storage";
  import { buildExportBundle } from "$lib/storage/export";
  import Button from "../Button.svelte";
  import { importNotesFile } from "./import-notes";
  import { message } from "$lib/utils/error";
  import type { TabContext } from "./shared";

  let { ctx }: { ctx: TabContext } = $props();

  let exporting = $state(false);
  let importing = $state(false);
  let fileEl = $state<HTMLInputElement>();

  async function exportNotes(): Promise<void> {
    exporting = true;
    try {
      const store = await getStore();
      const bundle = await buildExportBundle(store);
      const blob = new Blob([JSON.stringify(bundle)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `set-notes-${new Date(bundle.exportedAt).toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);

      ctx.flash(
        `Exported ${bundle.pages.length} page${bundle.pages.length === 1 ? "" : "s"}`,
      );
    } catch (e) {
      ctx.flash(`Couldn't export: ${message(e)}`, "warn");
    } finally {
      exporting = false;
    }
  }

  /** Added to what this browser holds, never in place of it. */
  async function importNotes(): Promise<void> {
    const file = fileEl?.files?.[0];
    if (!file) return;
    importing = true;
    try {
      const said = await importNotesFile(await file.text());
      ctx.flash(said.text, said.tone);
    } catch (e) {
      ctx.flash(`Couldn't import: ${message(e)}`, "warn");
    } finally {
      importing = false;
      // So choosing the same file again still counts as a change.
      if (fileEl) fileEl.value = "";
    }
  }
</script>

<section class="set-section">
  <div class="set-section-head">
    <h3 class="set-section-title">Export your notes</h3>
    <Button onclick={exportNotes} disabled={exporting}>
      {exporting ? "Exporting" : "Export"}
    </Button>
  </div>
  <p class="set-hint">Export all your notes.</p>
</section>

<section class="set-section">
  <div class="set-section-head">
    <h3 class="set-section-title">Import notes</h3>
    <Button onclick={() => fileEl?.click()} disabled={importing}>
      {importing ? "Importing" : "Import"}
    </Button>
  </div>
  <p class="set-hint">Import notes from another browser.</p>
  <input
    bind:this={fileEl}
    type="file"
    accept=".json,application/json"
    hidden
    data-testid="import-notes-input"
    onchange={importNotes}
  />
</section>
