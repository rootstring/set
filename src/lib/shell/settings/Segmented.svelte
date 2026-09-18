<script lang="ts">
  import type { Opt } from "./shared";

  interface Props {
    label: string;
    options: Opt[];
    value: string;
    choose: (value: string) => void;
  }

  let { label, options, value, choose }: Props = $props();
</script>

<div class="set-segmented" role="group" aria-label={label}>
  {#each options as opt (opt.value)}
    <button
      type="button"
      class="set-seg"
      aria-pressed={opt.value === value}
      onclick={() => choose(opt.value)}
    >
      {opt.label}
    </button>
  {/each}
</div>
