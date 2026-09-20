<script lang="ts">
  import { tick } from "svelte";
  import Button from "./Button.svelte";
  import { mathDialog } from "$lib/state/math-dialog.svelte";
  import { checkMath } from "$lib/editor/math-render";
  import { dismissible } from "./dismiss.svelte";
  import { anchorRect, place } from "./popover";

  const request = $derived(mathDialog.request);

  let el = $state<HTMLDivElement>();
  let source = $state("");
  let sourceEl = $state<HTMLTextAreaElement>();

  /** What KaTeX made of the source, or what it objected to. */
  let preview = $state("");
  let error = $state<string | null>(null);

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

  function fit(): void {
    if (!sourceEl) return;
    sourceEl.style.height = "0";
    sourceEl.style.height = `${sourceEl.scrollHeight}px`;
  }

  // Each ask fills the field again — the popover outlives one use.
  $effect(() => {
    const current = request;
    if (!current || !el) {
      camefrom = null;
      placed = false;
      return;
    }
    camefrom ??= document.activeElement as HTMLElement | null;
    source = current.source;
    preview = "";
    error = null;
    reposition();
    // After paint: the popover is `visibility: hidden` until measured, and a hidden field cannot
    // hold the caret.
    void tick().then(() => {
      fit();
      sourceEl?.focus();
      sourceEl?.select();
    });

    const onScroll = () => reposition();
    window.addEventListener("scroll", onScroll, true);
    return () => window.removeEventListener("scroll", onScroll, true);
  });

  // KaTeX answers out of order when it is still downloading; only the latest source counts.
  let sequence = 0;
  $effect(() => {
    const text = source.trim();
    const display = request?.display ?? false;
    const mine = ++sequence;
    if (!request) return;
    if (!text) {
      preview = "";
      error = null;
      return;
    }
    void checkMath(text, display).then((result) => {
      if (mine !== sequence) return;
      if ("error" in result) {
        error = result.error;
      } else {
        preview = result.html;
        error = null;
      }
      // The preview changes the popover's height.
      void tick().then(reposition);
    });
  });

  const ready = $derived(source.trim() !== "" && error === null);

  /** Before the answer, so the field is not removed while it holds focus. */
  function handBack(): void {
    if (camefrom?.isConnected) camefrom.focus({ preventScroll: true });
  }

  function submit(): void {
    if (!ready) return;
    handBack();
    mathDialog.confirm(source.trim());
  }

  function cancel(): void {
    handBack();
    mathDialog.cancel();
  }

  dismissible({
    isOpen: () => mathDialog.open,
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
    // Shift+Enter is a new line, for a formula that spans several.
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    } else if (event.key === "Tab") {
      const focusable = [
        ...(el?.querySelectorAll<HTMLElement>("button, textarea") ?? []),
      ].filter((control) => !control.hasAttribute("disabled"));
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
    data-testid="math-dialog"
  >
    {#if caret !== null}
      <span class="caret" style="left: {caret}px" aria-hidden="true"></span>
    {/if}
    <textarea
      bind:this={sourceEl}
      bind:value={source}
      oninput={fit}
      class="input"
      rows="4"
      placeholder={request.display ? "\\int_0^1 x^2 \\, dx" : "E = mc^2"}
      spellcheck="false"
      autocomplete="off"
      aria-label="LaTeX"
      data-testid="math-source"></textarea>
    {#if error}
      <p class="error" data-testid="math-error">{error}</p>
    {:else if preview}
      <!-- eslint-disable-next-line svelte/no-at-html-tags -- KaTeX's own output, from the source above. -->
      <div class="preview" class:display={request.display} data-testid="math-preview">
        {@html preview}
      </div>
    {/if}
    <div class="actions">
      <span class="keys">Shift+Enter for a new line</span>
      <Button onclick={cancel}>Cancel</Button>
      <Button variant="primary" disabled={!ready} onclick={submit}>
        {request.confirmLabel}
      </Button>
    </div>
  </div>
{/if}

<style>
  .popover {
    --popover-width: 440px;
    padding: 0.75rem;
  }

  .input {
    display: block;
    width: 100%;
    padding: 0.4rem 0.55rem;
    border: 1px solid var(--border);
    border-radius: calc(var(--radius) - 2px);
    background: var(--surface);
    color: var(--text);
    font-family: var(--font-mono);
    font-size: 0.8125rem;
    line-height: 1.5;
    /* Four lines to start with; `fit` grows it past that as the source does. */
    min-height: calc(4 * 1.5em + 0.8rem + 2px);
    resize: none;
    outline: none;
  }
  .input:focus {
    border-color: var(--accent);
  }
  .input::placeholder {
    color: var(--text-subtle);
  }

  .preview {
    margin-top: 0.6rem;
    padding: 0.35rem 0.25rem;
    color: var(--text);
    overflow-x: auto;
  }
  .preview.display {
    text-align: center;
  }
  .preview :global(.katex-display) {
    margin: 0;
  }

  .error,
  .hint {
    margin: 0.5rem 0 0;
    font-size: 0.75rem;
    line-height: 1.4;
  }
  .error {
    color: var(--danger);
    font-family: var(--font-mono);
    word-break: break-word;
  }
  .hint {
    color: var(--text-subtle);
  }

  .actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 0.4rem;
    margin-top: 0.75rem;
  }
  .keys {
    margin-right: auto;
    font-size: 0.6875rem;
    color: var(--text-subtle);
  }
</style>
