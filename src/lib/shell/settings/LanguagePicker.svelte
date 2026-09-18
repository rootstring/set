<script lang="ts">
  import { settings, DICTATION_LANGUAGES } from "$lib/state/settings.svelte";

  interface Props {
    id: string;
  }

  let { id }: Props = $props();
</script>

<div class="picker">
  <select
    {id}
    value={settings.dictationLanguage}
    onchange={(e) => settings.setDictationLanguage(e.currentTarget.value)}
  >
    {#each DICTATION_LANGUAGES as language (language.id)}
      <option value={language.id}>{language.label}</option>
    {/each}
  </select>
  <svg
    viewBox="0 0 16 16"
    width="1em"
    height="1em"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M4.5 6.5 8 10l3.5-3.5" />
  </svg>
</div>

<style>
  .picker {
    position: relative;
    display: inline-flex;
    align-items: center;
    box-sizing: border-box;
    height: 1.9rem;

    background: var(--bg-hover);
    border: 1px solid transparent;
    border-radius: var(--radius);
    color: var(--text);
    cursor: pointer;
  }

  .picker:hover {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--on-accent);
  }

  .picker:focus-within {
    border-color: var(--accent);
  }

  .picker select {
    appearance: none;
    -webkit-appearance: none;
    margin: 0;
    /* The inset is the select's own, so the chevron side of the box still opens the menu. */
    padding: 0 1.6rem 0 0.6rem;
    border: none;
    background: none;
    color: inherit;
    font: inherit;
    font-size: 0.8rem;

    line-height: 1.5;
    cursor: inherit;

    box-sizing: border-box;
    width: 100%;
    height: 100%;
  }
  .picker select:focus {
    outline: none;
  }

  .picker option {
    background: var(--bg-elevated);
    color: var(--text);
  }

  .picker svg {
    position: absolute;
    right: 0.5rem;
    pointer-events: none;
    opacity: 0.7;
  }
</style>
