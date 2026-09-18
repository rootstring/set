/**
 * A native tooltip waits about a second. One delegated listener borrows the `title` off the hovered
 * element and puts it back on leave, so the DOM at rest is what the markup says.
 *
 * A link in a note has no `title` (one would come back through copy and paste as the Markdown
 * `"title"`); its hint is the address it points to.
 */

/** Ours, versus roughly a second for the native one. */
const SHOW_DELAY = 500;

/** Between the element and its bubble. */
const GAP = 6;

/** Off the viewport edges. */
const MARGIN = 8;

let bubble: HTMLDivElement | null = null;
let anchor: HTMLElement | null = null;
/** What the bubble says. */
let text = "";
/** The `title` taken off the anchor, to hand back on leave. */
let borrowed = "";
let showTimer: ReturnType<typeof setTimeout> | null = null;
let watcher: MutationObserver | null = null;

function ensureBubble(): HTMLDivElement {
  if (!bubble) {
    bubble = document.createElement("div");
    bubble.className = "tip";
    bubble.setAttribute("role", "tooltip");
    bubble.setAttribute("aria-hidden", "true");
    document.body.append(bubble);
  }
  return bubble;
}

function place(el: HTMLElement, tip: HTMLDivElement): void {
  const rect = el.getBoundingClientRect();
  const { width, height } = tip.getBoundingClientRect();

  const below = rect.bottom + GAP;
  const above = rect.top - GAP - height;
  const top =
    below + height + MARGIN <= window.innerHeight || above < MARGIN ? below : above;

  const centered = rect.left + rect.width / 2 - width / 2;
  const left = Math.min(
    Math.max(centered, MARGIN),
    Math.max(MARGIN, window.innerWidth - width - MARGIN),
  );

  tip.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
}

/** The address a note's link shows, when its `title` doesn't say something else. */
function linkHint(el: HTMLElement): string {
  if (!(el instanceof HTMLAnchorElement) || !el.closest(".ProseMirror")) return "";
  return el.getAttribute("href") ?? "";
}

function hintOf(el: HTMLElement): string {
  return el.title || linkHint(el);
}

/**
 * Hold on to the element's `title` while the bubble stands in for it, so the
 * browser doesn't draw its own on top a second later.
 */
function borrow(el: HTMLElement): void {
  text = hintOf(el);
  borrowed = el.title;
  el.removeAttribute("title");

  // The title may be reactive; Svelte writes the attribute straight back, so watch and re-borrow.
  watcher = new MutationObserver(() => {
    if (!anchor || !anchor.title) return;
    text = borrowed = anchor.title;
    anchor.removeAttribute("title");
    if (bubble?.classList.contains("shown")) {
      bubble.textContent = text;
      place(anchor, bubble);
    }
  });
  watcher.observe(el, { attributes: true, attributeFilter: ["title"] });
}

function giveBack(): void {
  watcher?.disconnect();
  watcher = null;
  // Only if nothing has since written its own.
  if (anchor && borrowed && !anchor.title) anchor.title = borrowed;
  anchor = null;
  text = "";
  borrowed = "";
}

function show(): void {
  if (!anchor || !text) return;
  const tip = ensureBubble();
  tip.textContent = text;
  tip.classList.add("shown");
  tip.setAttribute("aria-hidden", "false");
  place(anchor, tip);
}

function hide(): void {
  if (showTimer) {
    clearTimeout(showTimer);
    showTimer = null;
  }
  if (bubble?.classList.contains("shown")) {
    bubble.classList.remove("shown");
    bubble.setAttribute("aria-hidden", "true");
  }
  giveBack();
}

function target(node: EventTarget | null): HTMLElement | null {
  if (!(node instanceof Element)) return null;
  const el = node.closest<HTMLElement>("[title], .ProseMirror a[href]");
  return el && hintOf(el) ? el : null;
}

function open(el: HTMLElement): void {
  if (el === anchor) return;
  hide();
  anchor = el;
  borrow(el);
  showTimer = setTimeout(show, SHOW_DELAY);
}

/**
 * Capture-phase, so a hint appears over elements that stop bubbling (sidebar rows while dragging).
 */
export function installTooltips(): () => void {
  const onOver = (event: PointerEvent) => {
    // Touch has no hover, and a long-press tooltip would fight the press.
    if (event.pointerType === "touch") return hide();
    const el = target(event.target);
    if (el) open(el);
    else if (anchor && !anchor.contains(event.target as Node)) hide();
  };

  // Keyboard users get the same hint, on the same timing, when a control they
  // tabbed to has one.
  const onFocusIn = (event: FocusEvent) => {
    const el = event.target;
    if (!(el instanceof HTMLElement)) return;
    if (!hintOf(el) || !el.matches(":focus-visible")) return hide();
    open(el);
  };

  const away = () => hide();

  document.addEventListener("pointerover", onOver, true);
  document.addEventListener("pointerdown", away, true);
  document.addEventListener("keydown", away, true);
  document.addEventListener("focusin", onFocusIn, true);
  document.addEventListener("focusout", away, true);
  document.addEventListener("scroll", away, true);
  window.addEventListener("blur", away);
  window.addEventListener("resize", away);

  return () => {
    hide();
    document.removeEventListener("pointerover", onOver, true);
    document.removeEventListener("pointerdown", away, true);
    document.removeEventListener("keydown", away, true);
    document.removeEventListener("focusin", onFocusIn, true);
    document.removeEventListener("focusout", away, true);
    document.removeEventListener("scroll", away, true);
    window.removeEventListener("blur", away);
    window.removeEventListener("resize", away);
    bubble?.remove();
    bubble = null;
  };
}
