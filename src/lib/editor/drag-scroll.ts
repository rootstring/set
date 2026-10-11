import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";

/** How close to the top or bottom of the scrolling area a drag starts to scroll it. */
const EDGE = 72;

/** Pixels a second: at the start of the edge band, and at its end or past it. */
const SPEED = { min: 120, max: 1400 };

/** The longest step a single frame may take, so a stalled tab does not jump on waking. */
const MAX_FRAME_MS = 50;

/**
 * How fast to scroll for a pointer at `y` in an area running from `top` to `bottom`: negative is
 * up, zero is not at all. Quadratic, so the first few pixels of the band are easy to hold.
 */
export function scrollSpeed(y: number, top: number, bottom: number): number {
  const edge = Math.min(EDGE, (bottom - top) / 3);
  if (edge <= 0) return 0;

  const up = top + edge - y;
  const down = y - (bottom - edge);
  const depth = Math.max(up, down);
  if (depth <= 0) return 0;

  const ratio = Math.min(1, depth / edge);
  const speed = SPEED.min + (SPEED.max - SPEED.min) * ratio * ratio;
  return up > down ? -speed : speed;
}

function scrollParentOf(el: HTMLElement): HTMLElement | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === "auto" || overflow === "scroll") return node;
  }
  return null;
}

/**
 * Scrolls the page while a drag is held near its top or bottom edge, so a block can be dropped
 * somewhere that was out of view when it was picked up. The webview does not do this on its own.
 */
export const DragScroll = Extension.create({
  name: "dragScroll",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("dragScroll"),
        view(view) {
          /** Where the drag last was. It only reports while it moves, so this is held between. */
          let at: { x: number; y: number } | null = null;
          let frame = 0;
          let last = 0;
          /** The fraction of a pixel a slow frame leaves over; `scrollTop` takes whole ones. */
          let carry = 0;

          const stop = (): void => {
            at = null;
            carry = 0;
            if (frame) cancelAnimationFrame(frame);
            frame = 0;
          };

          const tick = (now: number): void => {
            frame = 0;
            const parent = scrollParentOf(view.dom);
            if (!at || !parent) return;

            const rect = parent.getBoundingClientRect();
            // Only for a drag over the page's own column, not one passing down the sidebar.
            const over = at.x >= rect.left && at.x <= rect.right;
            const speed = over ? scrollSpeed(at.y, rect.top, rect.bottom) : 0;
            if (speed === 0) {
              carry = 0;
              return;
            }

            const elapsed = Math.min(now - last, MAX_FRAME_MS);
            last = now;
            const move = (speed * elapsed) / 1000 + carry;
            const whole = Math.trunc(move);
            carry = move - whole;
            parent.scrollTop += whole;

            frame = requestAnimationFrame(tick);
          };

          const onDragOver = (event: DragEvent): void => {
            at = { x: event.clientX, y: event.clientY };
            if (frame) return;
            last = performance.now();
            frame = requestAnimationFrame(tick);
          };

          document.addEventListener("dragover", onDragOver, true);
          document.addEventListener("dragend", stop, true);
          document.addEventListener("drop", stop, true);

          return {
            destroy() {
              document.removeEventListener("dragover", onDragOver, true);
              document.removeEventListener("dragend", stop, true);
              document.removeEventListener("drop", stop, true);
              stop();
            },
          };
        },
      }),
    ];
  },
});
