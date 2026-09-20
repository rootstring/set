<script lang="ts">
  import { tick } from "svelte";
  import Button from "./Button.svelte";
  import { linkDialog } from "$lib/state/link-dialog.svelte";
  import { normalizeUrl } from "$lib/editor/url";
  import { dismissible } from "./dismiss.svelte";
  import { anchorRect, place } from "./popover";

  const request = $derived(linkDialog.request);

  let el = $state<HTMLDivElement>();
  let href = $state("");
  let text = $state("");
  let hrefEl = $state<HTMLInputElement>();

  let top = $state(0);
  let left = $state(0);
  let caret = $state<number | null>(null);
  let above = $state(false);
  let placed = $state(false);

  let camefrom: HTMLElement | null = null;

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

  // Each ask fills the fields again — the popover outlives one use.
  $effect(() => {
    const draft = request?.draft;
    if (!draft || !el) {
      camefrom = null;
      placed = false;
      return;
    }
    camefrom ??= document.activeElement as HTMLElement | null;
    href = draft.href;
    text = draft.text;
    reposition();
    // After paint: the popover is `visibility: hidden` until measured, and a hidden field cannot
    // hold the caret.
    void tick().then(() => {
      hrefEl?.focus();
      hrefEl?.select();
    });

    const onScroll = () => reposition();
    window.addEventListener("scroll", onScroll, true);
    return () => window.removeEventListener("scroll", onScroll, true);
  });

  const target = $derived(normalizeUrl(href));

  /** Before the answer, so the fields are not removed while one holds focus. */
  function handBack(): void {
    if (camefrom?.isConnected) camefrom.focus({ preventScroll: true });
  }

  function submit(): void {
    if (!target) return;
    handBack();
    linkDialog.confirm({ href: target, text: text.trim() });
  }

  function cancel(): void {
    handBack();
    linkDialog.cancel();
  }

  dismissible({
    isOpen: () => linkDialog.open,
    anchors: () => [el],
    close: cancel,
    escape: (event) => {
      // The editor behind reads Escape as its own.
      event.preventDefault();
      event.stopPropagation();
      cancel();
    },
  });

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === "Enter") {
      event.preventDefault();
      submit();
    } else if (event.key === "Tab") {
      // Four controls, so wrapping Tab is enough of a trap.
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
    data-testid="link-dialog"
  >
    {#if caret !== null}
      <span class="caret" style="left: {caret}px" aria-hidden="true"></span>
    {/if}
    <label class="field">
      <span class="label">Link</span>
      <input
        bind:this={hrefEl}
        bind:value={href}
        class="input"
        type="text"
        placeholder="example.com/page"
        spellcheck="false"
        autocomplete="off"
        data-testid="link-href"
      />
    </label>
    <label class="field">
      <span class="label">Text</span>
      <input
        bind:value={text}
        class="input"
        type="text"
        placeholder="Same as the link"
        spellcheck="false"
        autocomplete="off"
        data-testid="link-text"
      />
    </label>
    <div class="actions">
      <Button onclick={cancel}>Cancel</Button>
      <Button variant="primary" disabled={!target} onclick={submit}>
        {request.confirmLabel}
      </Button>
    </div>
  </div>
{/if}

<style>
  .popover {
    --popover-width: 320px;
    padding: 0.75rem;
  }

  .field {
    display: flex;
    align-items: center;
    gap: 0.65rem;
    margin-bottom: 0.5rem;
  }

  .label {
    flex: 0 0 2.75rem;
    font-size: 0.75rem;
    color: var(--text-subtle);
  }

  .input {
    flex: 1 1 auto;
    min-width: 0;
    padding: 0.4rem 0.55rem;
    border: 1px solid var(--border);
    border-radius: calc(var(--radius) - 2px);
    background: var(--surface);
    color: var(--text);
    font: inherit;
    font-size: 0.8125rem;
    outline: none;
  }
  .input:focus {
    border-color: var(--accent);
  }
  .input::placeholder {
    color: var(--text-subtle);
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.4rem;
    margin-top: 0.75rem;
  }
</style>
