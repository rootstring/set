/** Breathing room between a popover and the thing it belongs to. */
const GAP = 8;

/** How close to the window edge a popover may sit. */
const EDGE = 8;

/** Keeps the caret off the rounded corners. */
const CARET_INSET = 18;

export interface Placement {
  top: number;
  left: number;
  /** Where the little arrow points, or null when it would sit on a corner. */
  caret: number | null;
  above: boolean;
}

/**
 * Under if there is room, over if not, centred with nothing to point at. Measurements, not
 * elements, so the caret can anchor too.
 */
export function place(width: number, height: number, anchor: DOMRect | null): Placement {
  if (!anchor) {
    return {
      top: Math.max(EDGE, (window.innerHeight - height) / 2),
      left: Math.max(EDGE, (window.innerWidth - width) / 2),
      caret: null,
      above: false,
    };
  }

  const below = anchor.bottom + GAP;
  const above =
    below + height > window.innerHeight - EDGE && anchor.top - GAP - height >= EDGE;
  let top = above ? anchor.top - GAP - height : below;
  top = Math.min(Math.max(top, EDGE), Math.max(EDGE, window.innerHeight - height - EDGE));

  const centred = anchor.left + anchor.width / 2 - width / 2;
  const left = Math.min(
    Math.max(centred, EDGE),
    Math.max(EDGE, window.innerWidth - width - EDGE),
  );

  const point = anchor.left + anchor.width / 2 - left;
  const caret =
    point < CARET_INSET || point > width - CARET_INSET ? null : Math.round(point);

  return { top, left, caret, above };
}

/**
 * A detached or hidden element measures as nothing and would pin the popover top-left; `null`
 * centres.
 */
export function anchorRect(
  anchor: HTMLElement | DOMRect | null | undefined,
): DOMRect | null {
  if (!anchor) return null;
  if (anchor instanceof HTMLElement) {
    if (!anchor.isConnected) return null;
    const box = anchor.getBoundingClientRect();
    return box.width === 0 && box.height === 0 ? null : box;
  }
  return anchor;
}
