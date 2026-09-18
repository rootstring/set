<script lang="ts">
  import { settings } from "$lib/state/settings.svelte";
  import { workspace } from "$lib/state/workspace.svelte";
  import Button from "../Button.svelte";
  import { importNotesFile } from "./import-notes";
  import { message } from "$lib/utils/error";
  import type { TabContext } from "./shared";

  let { ctx }: { ctx: TabContext } = $props();

  let changeEl = $state<HTMLButtonElement>();
  let importEl = $state<HTMLButtonElement>();
  let importingNotes = $state(false);

  let notesPath = $state("");
  $effect(() => {
    settings.notesFolder; // refresh when it changes
    workspace.notesFolder().then((p) => (notesPath = p));
  });

  const EXPORT_NAME = "set-settings.json";

  async function exportSettings(): Promise<void> {
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const path = await save({
        defaultPath: EXPORT_NAME,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!path) return;

      // Not `grant_notes_dir`: that also makes it the notes folder.
      const { writeTextFile } = await import("@tauri-apps/plugin-fs");
      await writeTextFile(path, settings.toExportJSON());
      ctx.flash("Settings exported");
    } catch (e) {
      ctx.flash(`Couldn't export: ${message(e)}`, "warn");
    }
  }

  async function importSettings(): Promise<void> {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const path = await open({
        multiple: false,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (typeof path !== "string") return;
      const { readTextFile } = await import("@tauri-apps/plugin-fs");
      const text = await readTextFile(path);
      ctx.confirm({
        anchor: importEl,
        title: "Import settings",
        message: "Replace your current settings with this file?",
        confirmLabel: "Import",
        danger: false,
        onConfirm: () =>
          settings.importFromJSON(text)
            ? ctx.flash("Settings imported")
            : ctx.flash("Couldn't read that file", "warn"),
      });
    } catch (e) {
      ctx.flash(`Couldn't import: ${message(e)}`, "warn");
    }
  }

  /** For anyone who skipped setup. */
  async function importNotes(): Promise<void> {
    importingNotes = true;
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const path = await open({
        multiple: false,
        filters: [{ name: "JSON", extensions: ["json"] }],
        title: "Choose an exported notes file",
      });
      if (typeof path !== "string") return;
      const { readTextFile } = await import("@tauri-apps/plugin-fs");
      const said = await importNotesFile(await readTextFile(path));
      ctx.flash(said.text, said.tone);
    } catch (e) {
      ctx.flash(`Couldn't import: ${message(e)}`, "warn");
    } finally {
      importingNotes = false;
    }
  }

  async function changeFolder(): Promise<void> {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({
      directory: true,
      multiple: false,
      title: "Choose notes folder",
    });
    if (typeof picked !== "string") return;
    if (picked === (await workspace.notesFolder())) return;
    if (workspace.pages.length > 0) {
      ctx.confirm({
        anchor: changeEl,
        title: "Move your notes?",
        message: `Take your notes to “${picked}”, or leave them where they are?`,
        confirmLabel: "Move",
        cancelLabel: "Don't move",
        danger: false,
        onConfirm: () => void doChangeFolder(picked, true),
        onCancel: () => void doChangeFolder(picked, false),
      });
    } else {
      await doChangeFolder(picked, false);
    }
  }

  async function doChangeFolder(path: string, move: boolean): Promise<void> {
    await workspace.changeNotesFolder(path, { move });
    ctx.flash(move ? "Notes moved" : "Notes folder changed");
  }
</script>

<section class="set-section">
  <div class="set-section-head">
    <h3 class="set-section-title">Notes folder</h3>
    <div class="actions">
      <Button bind:ref={changeEl} onclick={changeFolder}>Change</Button>
      <Button onclick={() => workspace.openNotesFolder()}>Open</Button>
    </div>
  </div>
  {#if notesPath}
    <p class="set-path" title={notesPath}>{notesPath}</p>
  {/if}
</section>
<section class="set-section">
  <div class="set-section-head">
    <h3 class="set-section-title">Import from the browser</h3>
    <Button onclick={importNotes} disabled={importingNotes}>
      {importingNotes ? "Importing" : "Import"}
    </Button>
  </div>
  <p class="set-hint">
    Used Set in a browser? Export your notes from Settings → Storage there, then import
    the file here.
  </p>
</section>
<section class="set-section">
  <div class="set-section-head">
    <h3 class="set-section-title">Settings file</h3>
    <div class="actions">
      <Button onclick={exportSettings}>Export</Button>
      <Button bind:ref={importEl} onclick={importSettings}>Import</Button>
    </div>
  </div>
  <p class="set-hint">Export/import your preferences as a file.</p>
</section>

<style>
  .actions {
    display: inline-flex;
    gap: 0.4rem;
  }
</style>
