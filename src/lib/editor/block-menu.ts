export const TRASH_SVG =
  '<svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" ' +
  'stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M2.75 4.25h10.5"/>' +
  '<path d="M6.25 4.25V3c0-.69.56-1.25 1.25-1.25h1c.69 0 1.25.56 1.25 1.25v1.25"/>' +
  '<path d="m4 4.25.63 8.75c.05.66.6 1.17 1.25 1.17h4.24c.66 0 1.2-.51 1.25-1.17L12 4.25"/>' +
  '<path d="M6.75 7v4M9.25 7v4"/></svg>';

export const COPY_SVG =
  '<svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" ' +
  'stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="3.75" y="3" width="8.5" height="11" rx="1.5"/>' +
  '<path d="M6 3V2.25c0-.41.34-.75.75-.75h2.5c.41 0 .75.34.75.75V3"/></svg>';

export const MOVE_SVG =
  '<svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" ' +
  'stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M8.5 2.75H4.25c-.69 0-1.25.56-1.25 1.25v8c0 .69.56 1.25 1.25 1.25H10c.69 0 1.25-.56 1.25-1.25v-2"/>' +
  '<path d="M7 8h6.5"/><path d="M11.25 5.75 13.5 8l-2.25 2.25"/></svg>';

export const EDIT_SVG =
  '<svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" ' +
  'stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M11.2 2.8l2 2L6 12H4v-2z"/><path d="M2.5 14.5h11"/></svg>';

export const DUPLICATE_SVG =
  '<svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" ' +
  'stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="5.75" y="5.75" width="7.5" height="7.5" rx="1.25"/>' +
  '<path d="M10.25 5.75V4.5c0-.69-.56-1.25-1.25-1.25H4.5c-.69 0-1.25.56-1.25 1.25V9c0 .69.56 1.25 1.25 1.25h1.25"/></svg>';

export interface BlockMenuItem {
  label: string;
  icon: string;
  danger?: boolean;
  /** Greyed out on a locked page rather than missing. */
  disabled?: boolean;
  run: () => void;
}

let openMenuEl: HTMLElement | null = null;

function closeBlockMenu(): void {
  openMenuEl?.remove();
  openMenuEl = null;
  document.removeEventListener("pointerdown", onDocPointerDown, true);
  document.removeEventListener("keydown", onMenuKeydown, true);
}

function onDocPointerDown(event: PointerEvent): void {
  if (openMenuEl && !openMenuEl.contains(event.target as globalThis.Node)) {
    closeBlockMenu();
  }
}

function onMenuKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    event.preventDefault();
    closeBlockMenu();
  }
}

export function showBlockMenu(x: number, y: number, items: BlockMenuItem[]): void {
  closeBlockMenu();
  const el = document.createElement("div");
  el.className = "block-menu";

  for (const item of items) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `block-menu-item${item.danger ? " danger" : ""}`;
    button.disabled = !!item.disabled;
    button.innerHTML = `<span class="block-menu-icon">${item.icon}</span><span></span>`;

    button.lastElementChild!.textContent = item.label;
    button.addEventListener("click", () => {
      closeBlockMenu();
      item.run();
    });
    el.append(button);
  }
  document.body.append(el);

  const { offsetWidth: w, offsetHeight: h } = el;
  el.style.left = `${Math.min(x, window.innerWidth - w - 8)}px`;
  el.style.top = `${Math.min(y, window.innerHeight - h - 8)}px`;
  openMenuEl = el;

  document.addEventListener("pointerdown", onDocPointerDown, true);
  document.addEventListener("keydown", onMenuKeydown, true);
}
