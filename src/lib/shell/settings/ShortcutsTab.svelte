<script lang="ts">
  import { isTauri } from "@tauri-apps/api/core";

  import {
    settings,
    shortcutFromEvent,
    formatShortcut,
    BINDINGS,
    SETTINGS_SHORTCUT,
    CONTEXT_SHORTCUT_MODS,
    type BindingId,
  } from "$lib/state/settings.svelte";
  import { dictation } from "$lib/state/dictation.svelte";
  import Field from "./Field.svelte";
  import type { TabContext } from "./shared";

  let { ctx }: { ctx: TabContext } = $props();

  const bindings = $derived(
    BINDINGS.filter((b) => b.id !== "dictate" || dictation.offered),
  );

  const FIXED: { label: string; combo: string }[] = [
    { label: "Settings", combo: SETTINGS_SHORTCUT },
    { label: "Switch to context 1–9", combo: `${CONTEXT_SHORTCUT_MODS}+1…9` },
    { label: "Undo", combo: "Mod+KeyZ" },
    { label: "Redo", combo: "Mod+Shift+KeyZ" },
    ...(isTauri() ? [{ label: "Open notes folder", combo: "Mod+Shift+KeyO" }] : []),
  ];

  let recording = $state<BindingId | null>(null);
  let recorderEls: Partial<Record<BindingId, HTMLButtonElement>> = $state({});
  let resetEl = $state<HTMLButtonElement>();

  /** The modifiers being held, so the button shows the combo as it's built. */
  let held = $state("");

  function modifiers(e: KeyboardEvent): string {
    const parts: string[] = [];
    if (e.metaKey || e.ctrlKey) parts.push("Mod");
    if (e.altKey) parts.push("Alt");
    if (e.shiftKey) parts.push("Shift");
    return parts.join("+");
  }

  $effect(() => {
    const id = recording;
    held = "";
    if (!id) return;
    const label = BINDINGS.find((b) => b.id === id)?.label ?? "";
    const anchor = recorderEls[id];

    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        recording = null;
        return;
      }
      held = modifiers(e);
      const combo = shortcutFromEvent(e);
      if (!combo) return; // a lone modifier, or a key with no ⌘/Ctrl/⌥: keep listening
      recording = null;
      if (combo === settings.shortcut(id)) return;

      const taken = BINDINGS.find(
        (b) => b.id !== id && settings.shortcut(b.id) === combo,
      );
      ctx.confirm({
        anchor,
        title: "Rebind shortcut",
        message: taken
          ? `${formatShortcut(combo)} becomes “${label}”, and stops being “${taken.label}”.`
          : `${formatShortcut(combo)} becomes “${label}”.`,
        confirmLabel: "Rebind",
        danger: false,
        onConfirm: () => settings.setShortcut(id, combo),
      });
    };

    // Letting go of a modifier before the key lands takes it back off the button.
    const onKeyUp = (e: KeyboardEvent) => {
      held = modifiers(e);
    };

    const onPointer = (e: PointerEvent) => {
      const t = e.target as Node | null;
      const el = recorderEls[id];
      if (t !== el && !el?.contains(t)) recording = null;
    };

    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("pointerdown", onPointer, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("pointerdown", onPointer, true);
    };
  });
</script>

<section class="set-section">
  <div class="set-section-head">
    <h3 class="set-section-title">Assignable</h3>
    <button
      type="button"
      class="control quiet reset"
      bind:this={resetEl}
      onclick={() =>
        ctx.confirm({
          anchor: resetEl,
          title: "Reset shortcuts",
          message: "Restore every default shortcut. This can't be undone.",
          confirmLabel: "Reset",
          danger: true,
          onConfirm: () => settings.resetShortcuts(),
        })}
    >
      Reset
    </button>
  </div>
  <div class="rows">
    {#each bindings as binding (binding.id)}
      <Field label={binding.label}>
        <button
          bind:this={recorderEls[binding.id]}
          type="button"
          class="control shortcut"
          class:recording={recording === binding.id}
          data-testid="shortcut-{binding.id}"
          onclick={() => (recording = binding.id)}
        >
          {recording === binding.id
            ? formatShortcut(held) || "Press keys"
            : formatShortcut(settings.shortcut(binding.id)) || "None"}
        </button>
      </Field>
    {/each}
  </div>
</section>
<section class="set-section">
  <div class="set-section-head">
    <h3 class="set-section-title">Fixed</h3>
  </div>
  <div class="rows">
    {#each FIXED as s (s.label)}
      <Field label={s.label}>
        <kbd class="shortcut-static">{formatShortcut(s.combo)}</kbd>
      </Field>
    {/each}
  </div>
</section>

<style>
  /* Only the button underlines the label; the row itself is not clickable. */
  .rows :global(.set-field-label) {
    border-bottom: 2px solid transparent;
    padding-bottom: 1px;
  }
  .rows :global(.set-field:has(.shortcut:hover) .set-field-label),
  .rows :global(.set-field:has(.shortcut:focus-visible) .set-field-label) {
    border-bottom-color: var(--accent);
  }

  .reset {
    font-size: 0.75rem;
    font-weight: 500;
    padding: 0.15rem 0.4rem;
  }

  .shortcut,
  .shortcut-static {
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 5.5rem;
    height: 1.9rem;
    padding: 0 0.7rem;
    font-family: var(--font-body);
    font-size: 0.8rem;
    border: 1px solid transparent;
    border-radius: var(--radius);
  }
  .shortcut-static {
    color: var(--text-muted);
    background: var(--bg-hover);
  }

  .shortcut.recording,
  .shortcut.recording:hover {
    background: var(--bg-hover);
    border-color: var(--accent);
    color: var(--text-muted);
  }
</style>
