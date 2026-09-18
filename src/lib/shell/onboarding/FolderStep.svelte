<script lang="ts">
  import { defaultNotesRoot } from "$lib/storage";
  import { settings } from "$lib/state/settings.svelte";
  import { workspace } from "$lib/state/workspace.svelte";
  import Button from "../Button.svelte";
  import { confirms } from "$lib/state/confirm.svelte";
  import { message } from "$lib/utils/error";

  let path = $state("");
  let fallback = $state("");
  let error = $state("");

  let chooseEl = $state<HTMLButtonElement>();

  $effect(() => {
    settings.notesFolder; // re-read when it changes
    void workspace.notesFolder().then((p) => (path = p));
  });
  $effect(() => {
    void defaultNotesRoot().then((p) => (fallback = p));
  });

  const isDefault = $derived(!!fallback && path === fallback);

  async function switchFolder(target: string): Promise<void> {
    if (target === (await workspace.notesFolder())) return;

    if (workspace.pages.length <= 1) {
      await switchTo(target, true);
      return;
    }
    confirms.ask({
      anchor: chooseEl ?? null,
      title: "Move your notes?",
      message: `Take your notes to “${target}”, or leave them where they are?`,
      confirmLabel: "Move",
      cancelLabel: "Don't move",
      danger: false,
      remember: false,
      permanent: false,
      onConfirm: () => void switchTo(target, true),
      onCancel: () => void switchTo(target, false),
      // Both buttons do something, so clicking away must not pick one.
      onDismiss: () => {},
    });
  }

  async function choose(): Promise<void> {
    error = "";
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({
        directory: true,
        multiple: false,
        title: "Choose notes folder",
      });
      if (typeof picked !== "string") return;
      await switchFolder(picked);
    } catch (e) {
      error = `Couldn't open that folder: ${message(e)}`;
    }
  }

  async function switchTo(target: string, move: boolean): Promise<void> {
    try {
      await workspace.changeNotesFolder(target, { move });
    } catch (e) {
      error = `Couldn't use that folder: ${message(e)}`;
    }
  }
</script>

<section class="ob-step">
  <h2 class="ob-title">Where your notes live</h2>
  <p class="ob-lede">
    Every note is a Markdown file stored locally in one folder on this computer.
  </p>
  <div class="ob-card">
    <span class="ob-card-label">{isDefault ? "Default folder" : "Notes folder"}</span>
    <p class="set-path path" title={path} data-testid="onboarding-folder">{path}</p>
  </div>
  <div class="ob-actions">
    <Button bind:ref={chooseEl} size="md" onclick={choose}>
      Choose a different folder
    </Button>
    {#if !isDefault && fallback}
      <Button size="md" onclick={() => switchFolder(fallback)}>Use the default</Button>
    {/if}
  </div>
  {#if error}
    <p class="ob-error" role="alert">{error}</p>
  {:else}
    <p class="set-hint">You can change this later in Settings → Storage.</p>
  {/if}
</section>

<style>
  .path {
    margin: 0;
  }
</style>
