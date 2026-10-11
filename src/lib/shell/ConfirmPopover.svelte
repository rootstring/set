<script lang="ts">
  import { tick } from "svelte";
  import Button from "./Button.svelte";
  import { confirms } from "$lib/state/confirm.svelte";
  import { dismissible } from "./dismiss.svelte";
  import { anchorRect, place } from "./popover";

  const request = $derived(confirms.request);

  let el = $state<HTMLDivElement>();
  let confirmButton = $state<HTMLButtonElement>();
  let cancelButton = $state<HTMLButtonElement>();
  let entryInput = $state<HTMLInputElement>();
  let dontAskAgain = $state(false);
  let entered = $state("");

  /** Only the digits count, so "123 456" and "123456" are the same. */
  const enteredDigits = $derived(entered.replace(/\D/g, ""));
  const entryDone = $derived(
    !request?.entry || enteredDigits.length === request.entry.digits,
  );

  function confirm(): void {
    if (!entryDone) return;
    confirms.confirm(dontAskAgain, request?.entry ? enteredDigits : undefined);
  }

  let top = $state(0);
  let left = $state(0);
  let caret = $state<number | null>(null);
  let above = $state(false);
  let placed = $state(false);

  function reposition(): void {
    if (!el) return;
    // Layout metrics, not a bounding rect: the open animation scales the popover.
    const spot = place(el.offsetWidth, el.offsetHeight, anchorRect(request?.anchor));
    top = spot.top;
    left = spot.left;
    caret = spot.caret;
    above = spot.above;
    placed = true;
  }

  // Keeps up with a list scrolling under it; `dismissible` closes on resize.
  $effect(() => {
    if (!request || !el) {
      placed = false;
      return;
    }
    dontAskAgain = false;
    entered = "";
    reposition();
    // After paint: the popover is `visibility: hidden` until measured, and a hidden button cannot
    // take focus.
    const wanted = request.entry
      ? entryInput
      : request.permanent
        ? cancelButton
        : confirmButton;
    void tick().then(() => wanted?.focus());

    const onScroll = () => reposition();
    window.addEventListener("scroll", onScroll, true);
    return () => window.removeEventListener("scroll", onScroll, true);
  });

  dismissible({
    isOpen: () => confirms.open,
    anchors: () => [el, request?.anchor],
    close: () => confirms.dismiss(),
    escape: (event) => {
      // The panel behind closes on Escape too.
      event.preventDefault();
      event.stopPropagation();
      confirms.dismiss();
    },
  });

  /** Three controls at most, so wrapping Tab is enough of a trap. */
  function onKeydown(event: KeyboardEvent): void {
    if (event.key !== "Tab") return;
    const focusable = [...(el?.querySelectorAll<HTMLElement>("button, input") ?? [])];
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
</script>

{#if request}
  <div
    bind:this={el}
    class="popover"
    class:above
    class:ready={placed}
    style="top: {top}px; left: {left}px"
    role="dialog"
    tabindex="-1"
    aria-label={request.title}
    onkeydown={onKeydown}
    data-testid="confirm-popover"
  >
    {#if caret !== null}
      <span class="caret" style="left: {caret}px" aria-hidden="true"></span>
    {/if}
    <p class="message">{request.message}</p>
    {#if request.entry}
      <input
        bind:this={entryInput}
        bind:value={entered}
        class="entry"
        aria-label={request.entry.label}
        placeholder={"0".repeat(request.entry.digits)}
        inputmode="numeric"
        autocomplete="off"
        spellcheck="false"
        maxlength={request.entry.digits + 4}
        onkeydown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            confirm();
          }
        }}
        data-testid="confirm-entry"
      />
    {/if}
    {#if request.remember}
      <label class="remember">
        <input type="checkbox" bind:checked={dontAskAgain} />
        <span>Don't ask again</span>
      </label>
    {/if}
    <div class="actions">
      <Button bind:ref={cancelButton} onclick={() => confirms.cancel()}>
        {request.cancelLabel ?? "Cancel"}
      </Button>
      <Button
        bind:ref={confirmButton}
        variant="primary"
        tone={request.danger === false ? "neutral" : "danger"}
        disabled={!entryDone}
        onclick={confirm}
      >
        {request.confirmLabel}
      </Button>
    </div>
  </div>
{/if}

<style>
  .popover {
    --popover-width: 272px;
    padding: 0.75rem;
  }

  .message {
    margin: 0 0 0.75rem;
    font-size: 0.8125rem;
    line-height: 1.45;
    color: var(--text);
  }

  .entry {
    display: block;
    width: 100%;
    box-sizing: border-box;
    margin: 0 0 0.75rem;
    padding: 0.4rem 0.5rem;
    font-size: 1rem;
    font-family: var(--font-mono);
    letter-spacing: 0.2em;
    text-align: center;
    color: var(--text);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 6px;
  }

  .entry:focus {
    outline: none;
    border-color: var(--accent);
  }

  .remember {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin-bottom: 0.75rem;
    font-size: 0.75rem;
    color: var(--text-muted);
    cursor: pointer;
    user-select: none;
  }

  .remember input {
    margin: 0;
    accent-color: var(--accent);
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.4rem;
  }
</style>
