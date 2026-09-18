<script lang="ts">
  import type { Snippet } from "svelte";

  interface Props {
    children: Snippet;
    onclick?: () => void;
    variant?: "secondary" | "primary";
    tone?: "neutral" | "danger";
    size?: "sm" | "md";
    title?: string;
    ariaLabel?: string;
    ref?: HTMLButtonElement;
    disabled?: boolean;
  }

  let {
    children,
    onclick,
    variant = "secondary",
    tone = "neutral",
    size = "sm",
    title,
    ariaLabel,
    ref = $bindable(),
    disabled = false,
  }: Props = $props();
</script>

<button
  bind:this={ref}
  type="button"
  class="btn {size} control {variant === 'primary' ? 'primary' : ''} {tone === 'danger'
    ? 'danger'
    : ''}"
  {title}
  aria-label={ariaLabel}
  {disabled}
  {onclick}
>
  {@render children()}
</button>

<style>
  .btn.sm {
    font-size: 0.8rem;
    padding: 0.3rem 0.7rem;
  }
  .btn.md {
    font-size: 0.875rem;
    padding: 0.4rem 0.85rem;
  }

  .btn:disabled {
    opacity: 0.45;
    cursor: default;
  }
</style>
