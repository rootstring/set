<script lang="ts">
  import { toasts } from "$lib/state/toasts.svelte";
  import Icon from "./Icon.svelte";
</script>

<div class="toaster" role="region" aria-label="Notifications">
  {#each toasts.items as toast (toast.id)}
    {@const actions = toast.actions ?? []}
    <div class="toast" class:stacked={actions.length > 1} role="alert">
      <span
        class="mark"
        class:plain={toast.tone === "plain"}
        class:good={toast.icon === "check"}
      >
        <Icon name={toast.icon ?? (toast.tone === "plain" ? "trash" : "alert")} />
      </span>
      <p class="message">{toast.message}</p>
      {#if actions.length === 1}
        <button
          class="control quiet action"
          onclick={() => toasts.act(toast.id)}
          data-testid="toast-action"
        >
          {actions[0].label}
        </button>
      {/if}
      <button
        class="control quiet dismiss"
        title="Dismiss"
        aria-label="Dismiss notification"
        onclick={() => toasts.dismiss(toast.id)}
      >
        <Icon name="close" />
      </button>
      <!-- More than one answer needs a line of its own. -->
      {#if actions.length > 1}
        <div class="actions">
          {#each actions as action, i (action.label)}
            <button
              class="control quiet action"
              class:asked={i === actions.length - 1}
              onclick={() => toasts.act(toast.id, i)}
              data-testid="toast-action"
            >
              {action.label}
            </button>
          {/each}
        </div>
      {/if}
    </div>
  {/each}
</div>

<style>
  .toaster {
    position: fixed;
    right: 1rem;
    bottom: 1rem;

    z-index: 300;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 0.5rem;

    pointer-events: none;
  }

  .toast {
    pointer-events: auto;
    box-sizing: border-box;
    width: min(320px, calc(100vw - 2rem));

    /* Mark, message, the single action, dismiss — and, when there is more than
       one answer, a second row for them spanning the whole width. */
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto auto;
    align-items: center;
    gap: 0.5rem;
    padding: 0.6rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: calc(var(--radius) * 1.5);
    box-shadow: var(--shadow-pop);
    animation: toast-in 140ms ease-out;
  }

  .stacked {
    width: min(360px, calc(100vw - 2rem));
    row-gap: 0.55rem;
  }

  .actions {
    grid-column: 1 / -1;
    display: flex;
    justify-content: flex-end;
    gap: 0.3rem;
  }

  .mark {
    display: flex;
    font-size: 1rem;
    color: var(--danger);
  }

  .mark.plain {
    color: var(--text-subtle);
  }

  .mark.good {
    color: var(--accent-ink);
  }

  .action {
    padding: 0.2rem 0.5rem;
    font-size: 0.8rem;
    font-weight: 500;
    color: var(--text-muted);
  }

  /* Left alone on hover, where the control's own filled look takes over. */
  .action.asked:not(:hover),
  .toast:not(.stacked) .action:not(:hover) {
    color: var(--accent-ink);
  }

  .message {
    margin: 0;

    font-size: 0.85rem;
    line-height: 1.4;
    color: var(--text);
  }

  .dismiss {
    width: 1.4rem;
    height: 1.4rem;
    font-size: 0.8rem;
  }

  @keyframes toast-in {
    from {
      opacity: 0;
      transform: translateY(6px);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .toast {
      animation: none;
    }
  }
</style>
