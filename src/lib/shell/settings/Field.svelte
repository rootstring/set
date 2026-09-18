<script lang="ts">
  import type { Snippet } from "svelte";

  interface Props {
    label: string;
    stack?: boolean;
    htmlFor?: string;
    children: Snippet;
  }

  let { label, stack = false, htmlFor, children }: Props = $props();
</script>

<div class="set-field" class:set-field-stack={stack}>
  {#if htmlFor}
    <label class="set-field-label" for={htmlFor}>{label}</label>
  {:else}
    <span class="set-field-label">{label}</span>
  {/if}
  {@render children()}
</div>
