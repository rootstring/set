<script lang="ts">
  import {
    settings,
    ACCENTS,
    SURFACE_TINTS,
    asHex,
    FONT_SIZE_STOPS,
    type Theme,
    type Density,
    type ReadingWidth,
    type BodyFont,
  } from "$lib/state/settings.svelte";
  import Field from "./Field.svelte";
  import Segmented from "./Segmented.svelte";
  import type { Opt } from "./shared";

  interface Props {
    reset?: (scope: string, apply: () => void, anchor: HTMLElement) => void;
  }

  let { reset }: Props = $props();

  const THEME_OPTS: Opt[] = [
    { value: "system", label: "System" },
    { value: "light", label: "Light" },
    { value: "dark", label: "Dark" },
  ];
  const DENSITY_OPTS: Opt[] = [
    { value: "comfortable", label: "Comfortable" },
    { value: "compact", label: "Compact" },
  ];
  const WIDTH_OPTS: Opt[] = [
    { value: "normal", label: "Normal" },
    { value: "wide", label: "Wide" },
  ];
  const BODY_FONT_OPTS: Opt[] = [
    { value: "sans", label: "Default" },
    { value: "serif", label: "Serif" },
    { value: "mono", label: "Mono" },
    { value: "system", label: "System" },
  ];
  const TOGGLE_OPTS: Opt[] = [
    { value: "on", label: "On" },
    { value: "off", label: "Off" },
  ];

  const sizeIndex = $derived.by(() => {
    const i = FONT_SIZE_STOPS.indexOf(settings.fontSize);
    return i === -1 ? FONT_SIZE_STOPS.indexOf(16) : i;
  });
  const sizeFill = $derived((sizeIndex / (FONT_SIZE_STOPS.length - 1)) * 100);

  interface CustomSwatch {
    /** The remembered custom colour, if one has been picked. */
    saved: string | null;
    /** What the circle is filled with: the saved colour as it will show. */
    swatch: string;
    /** The saved colour is the one in use. */
    active: boolean;
    /** Where the picker opens with nothing saved yet. */
    start: string;
    name: string;
    select: () => void;
    pick: (hex: string) => void;
  }
</script>

{#snippet custom(c: CustomSwatch)}
  <!-- Nothing saved is the empty picker even when a custom colour is in use: there is no hex to name. -->
  {@const state = c.saved === null ? "empty" : c.active ? "active" : "saved"}
  {@const hex = c.saved === null ? "" : asHex(c.saved)}
  <!-- Empty, it is the picker. Holding an unused colour, a click uses it; only once in use does a click open the picker. -->
  <label
    class="swatch custom"
    class:filled={c.saved !== null}
    class:active={c.active}
    style={c.saved ? `--swatch: ${c.swatch}` : ""}
    title={state === "empty"
      ? `Pick a ${c.name}`
      : state === "saved"
        ? `Use your ${c.name} (${hex})`
        : `Change your ${c.name} (${hex})`}
    data-state={state}
  >
    <span class="custom-glyph" aria-hidden="true">+</span>
    <input
      type="color"
      value={state === "empty" ? c.start : hex}
      aria-label={state === "empty"
        ? `Pick a ${c.name}`
        : state === "saved"
          ? `Use your ${c.name}`
          : `Change your ${c.name}`}
      onclick={(e) => {
        if (state !== "saved") return;
        e.preventDefault();
        c.select();
      }}
      oninput={(e) => c.pick(e.currentTarget.value)}
    />
  </label>
{/snippet}

<section class="set-section">
  <div class="set-section-head">
    <h3 class="set-section-title">Theme</h3>
    {#if reset}
      <button
        type="button"
        class="control quiet reset"
        onclick={(e) =>
          reset?.("appearance", () => settings.resetAppearance(), e.currentTarget)}
      >
        Reset
      </button>
    {/if}
  </div>
  <Field label="Theme">
    <Segmented
      label="Theme"
      options={THEME_OPTS}
      value={settings.theme}
      choose={(v) => settings.setTheme(v as Theme)}
    />
  </Field>
  <Field label="Accent">
    <div class="swatches" role="group" aria-label="Accent color">
      {#each ACCENTS as a (a.id)}
        <button
          type="button"
          class="swatch"
          class:active={settings.accent === a.id}
          style="--swatch: {settings.isDarkTheme ? a.dark : a.light}"
          aria-label={a.label}
          aria-pressed={settings.accent === a.id}
          onclick={() => settings.setAccent(a.id)}
        ></button>
      {/each}
      <span class="swatch-divider" aria-hidden="true"></span>
      {@render custom({
        saved: settings.customAccent,
        swatch: settings.customAccent ?? "",
        active: settings.isCustomAccent,
        start: settings.accentPickerValue,
        name: "custom accent color",
        select: () => settings.setAccent({ custom: settings.customAccent! }),
        pick: (hex) => settings.setAccent({ custom: hex }),
      })}
    </div>
  </Field>
  <Field label="Tint">
    <div class="swatches" role="group" aria-label="Tint">
      <button
        type="button"
        class="swatch plain"
        class:active={settings.surfaceTint === null}
        style="--swatch: var(--bg)"
        aria-label="No tint"
        aria-pressed={settings.surfaceTint === null}
        onclick={() => settings.setSurfaceTint(null)}
      ></button>
      {#each SURFACE_TINTS as t (t.id)}
        <button
          type="button"
          class="swatch"
          class:active={settings.surfaceTint === t.color}
          style="--swatch: {t.color}"
          aria-label={t.label}
          aria-pressed={settings.surfaceTint === t.color}
          onclick={() => settings.setSurfaceTint(t.color)}
        ></button>
      {/each}
      <span class="swatch-divider" aria-hidden="true"></span>
      {@render custom({
        saved: settings.customTint,
        swatch: settings.customTint ?? "",
        active: settings.isCustomTint,
        start: settings.tintPickerValue,
        name: "custom tint",
        select: () => settings.setSurfaceTint(settings.customTint),
        pick: (hex) => settings.setSurfaceTint(hex),
      })}
    </div>
  </Field>
  <Field label="Font color">
    <div class="swatches" role="group" aria-label="Font color">
      <button
        type="button"
        class="swatch plain"
        class:active={settings.fontColor === null}
        style="--swatch: {settings.defaultTextColor}"
        aria-label="Default color"
        aria-pressed={settings.fontColor === null}
        onclick={() => settings.setFontColor(null)}
      ></button>
      {#each ACCENTS as a (a.id)}
        <button
          type="button"
          class="swatch"
          class:active={settings.fontColor === a.id}
          style="--swatch: {settings.fontInk(a.id)}"
          aria-label={a.label}
          aria-pressed={settings.fontColor === a.id}
          onclick={() => settings.setFontColor(a.id)}
        ></button>
      {/each}
      <span class="swatch-divider" aria-hidden="true"></span>
      {@render custom({
        saved: settings.customFontColor,
        swatch: settings.customFontColor
          ? settings.fontInk({ custom: settings.customFontColor })
          : "",
        active: settings.isCustomFontColor,
        start: settings.fontColorValue,
        name: "custom text color",
        select: () => settings.setFontColor({ custom: settings.customFontColor! }),
        pick: (hex) => settings.setFontColor({ custom: hex }),
      })}
    </div>
  </Field>
  <Field label="Density">
    <Segmented
      label="Density"
      options={DENSITY_OPTS}
      value={settings.density}
      choose={(v) => settings.setDensity(v as Density)}
    />
  </Field>
</section>
<section class="set-section">
  <div class="set-section-head">
    <h3 class="set-section-title">Editor</h3>
    {#if reset}
      <button
        type="button"
        class="control quiet reset"
        onclick={(e) => reset?.("editor", () => settings.resetEditor(), e.currentTarget)}
      >
        Reset
      </button>
    {/if}
  </div>
  <Field label="Font size" htmlFor="font-size">
    <div class="slider">
      <div class="track">
        <div class="rail">
          <span class="fill" style="width: {sizeFill}%"></span>
        </div>
        <input
          id="font-size"
          type="range"
          min="0"
          max={FONT_SIZE_STOPS.length - 1}
          step="1"
          value={sizeIndex}
          aria-valuetext="{settings.fontSize} pixels"
          oninput={(e) =>
            settings.setFontSize(FONT_SIZE_STOPS[e.currentTarget.valueAsNumber])}
        />
      </div>
      <span class="slider-value">{settings.fontSize}px</span>
    </div>
  </Field>
  <Field label="Reading width">
    <Segmented
      label="Reading width"
      options={WIDTH_OPTS}
      value={settings.readingWidth}
      choose={(v) => settings.setReadingWidth(v as ReadingWidth)}
    />
  </Field>
  <Field label="Body font">
    <Segmented
      label="Body font"
      options={BODY_FONT_OPTS}
      value={settings.bodyFont}
      choose={(v) => settings.setBodyFont(v as BodyFont)}
    />
  </Field>
  <Field label="Drag handle">
    <Segmented
      label="Drag handle"
      options={TOGGLE_OPTS}
      value={settings.dragHandle ? "on" : "off"}
      choose={(v) => settings.setDragHandle(v === "on")}
    />
  </Field>
  <Field label="Slash menu">
    <Segmented
      label="Slash menu"
      options={TOGGLE_OPTS}
      value={settings.slashMenu ? "on" : "off"}
      choose={(v) => settings.setSlashMenu(v === "on")}
    />
  </Field>
  <Field label="Date mention (@)">
    <Segmented
      label="Date mention"
      options={TOGGLE_OPTS}
      value={settings.dateMention ? "on" : "off"}
      choose={(v) => settings.setDateMention(v === "on")}
    />
  </Field>
  <Field label="Confirm before deleting">
    <Segmented
      label="Confirm before deleting"
      options={TOGGLE_OPTS}
      value={settings.confirmDelete ? "on" : "off"}
      choose={(v) => settings.setConfirmDelete(v === "on")}
    />
  </Field>
</section>

<style>
  .reset {
    font-size: 0.75rem;
    font-weight: 500;
    padding: 0.15rem 0.4rem;
  }

  .swatches {
    display: inline-flex;
    gap: 0.4rem;
    flex-wrap: wrap;
    justify-content: flex-end;
  }
  .swatch {
    position: relative;
    width: 22px;
    height: 22px;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: var(--swatch);
    cursor: pointer;
    box-shadow: inset 0 0 0 1px oklch(0% 0 0 / 0.12);
  }
  .swatch.active {
    box-shadow:
      0 0 0 2px var(--bg-elevated),
      0 0 0 4px var(--swatch);
  }

  .swatch.plain {
    box-shadow: inset 0 0 0 1px var(--border);
  }
  .swatch.plain.active {
    box-shadow:
      0 0 0 2px var(--bg-elevated),
      0 0 0 4px var(--accent),
      inset 0 0 0 1px var(--border);
  }

  .swatch.custom {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    background: transparent;
    box-shadow: inset 0 0 0 1px var(--border);
    color: var(--text-subtle);
  }
  .swatch.custom:hover {
    color: var(--accent);
    box-shadow: inset 0 0 0 1px var(--accent);
  }

  .swatch.custom.filled {
    background: var(--swatch);
    box-shadow: inset 0 0 0 1px oklch(0% 0 0 / 0.12);
  }
  .swatch.custom.filled .custom-glyph {
    opacity: 0;
  }
  /* Could be the page background itself, so the ring is the accent. */
  .swatch.custom.active {
    box-shadow:
      0 0 0 2px var(--bg-elevated),
      0 0 0 4px var(--accent),
      inset 0 0 0 1px oklch(0% 0 0 / 0.12);
  }
  .custom-glyph {
    font-size: 0.9rem;
    line-height: 1;
    pointer-events: none;
  }

  .swatch-divider {
    width: 1px;
    height: 18px;
    align-self: center;
    background: var(--border);
  }
  .swatch.custom input {
    position: absolute;
    inset: 0;
    opacity: 0;
    width: 100%;
    height: 100%;
    border: none;
    padding: 0;
    cursor: pointer;
  }

  .slider {
    --thumb: 14px;
    display: inline-flex;
    align-items: center;
    gap: 0.7rem;
  }
  .track {
    position: relative;
    width: 10rem;
    height: 1.5rem;
  }
  .rail {
    position: absolute;
    top: 0;
    bottom: 0;
    left: calc(var(--thumb) / 2);
    right: calc(var(--thumb) / 2);
  }

  .rail::before {
    content: "";
    position: absolute;
    top: calc(50% - 1.5px);
    left: 0;
    right: 0;
    height: 3px;
    border-radius: 999px;
    background: var(--bg-active);
  }
  .fill {
    position: absolute;
    top: calc(50% - 1.5px);
    left: 0;
    height: 3px;
    border-radius: 999px;
    background: var(--accent);
  }
  .track input[type="range"] {
    position: absolute;
    top: calc(50% - var(--thumb) / 2);
    left: 0;
    width: 100%;
    height: var(--thumb);
    margin: 0;
    appearance: none;
    -webkit-appearance: none;
    background: transparent;
    cursor: pointer;
  }

  .track input[type="range"]::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: var(--thumb);
    height: var(--thumb);
    border-radius: 50%;
    background: var(--control);
    border: 1px solid var(--control-border);
    box-shadow: var(--shadow-control);
  }
  .track input[type="range"]::-moz-range-thumb {
    width: var(--thumb);
    height: var(--thumb);
    border-radius: 50%;
    background: var(--control);
    border: 1px solid var(--control-border);
  }
  .slider-value {
    min-width: 2.9rem;
    text-align: right;
    font-size: 0.8rem;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
</style>
