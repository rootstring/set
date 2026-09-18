import { mount, unmount } from "svelte";
import MentionMenu from "./MentionMenu.svelte";
import type { MenuState } from "./suggestion-menu.svelte";
import { buildDateItems, formatDateAbsolute, type DateMenuItem } from "./date-format";
import { showDatePicker } from "./date-picker";
import { settings } from "$lib/state/settings.svelte";

export interface DateMentionController {
  onInput(): void;
  onKeydown(event: KeyboardEvent): boolean;
  destroy(): void;
}

interface ActiveMatch {
  start: number;
  end: number;
}

function findMatch(el: HTMLTextAreaElement): ActiveMatch | null {
  const pos = el.selectionStart;
  if (pos === null || el.selectionEnd !== pos) return null;
  const uptoCaret = el.value.slice(0, pos);
  const m = uptoCaret.match(/(?:^|\s)@([^\s@]*)$/);
  if (!m) return null;
  const start = pos - m[0].length + (m[0].startsWith("@") ? 0 : 1);
  return { start, end: pos };
}

type MentionComponent = { onKeyDown: (event: KeyboardEvent) => boolean };

export function createDateMentionField(el: HTMLTextAreaElement): DateMentionController {
  let component: MentionComponent | undefined;
  let target: HTMLElement | undefined;
  let match: ActiveMatch | null = null;

  const menu: MenuState<DateMenuItem> = $state({
    items: [],
    command: () => {},
    rect: null,
  });

  function close() {
    if (component) unmount(component);
    component = undefined;
    target?.remove();
    target = undefined;
    match = null;
  }

  function replaceRange(start: number, end: number, text: string) {
    el.focus();
    el.setSelectionRange(start, end);
    const ok = document.execCommand("insertText", false, text);
    if (!ok) {
      el.value = el.value.slice(0, start) + text + el.value.slice(end);
      const caret = start + text.length;
      el.setSelectionRange(caret, caret);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  function commit(item: DateMenuItem) {
    if (!match) return;
    const { start, end } = match;
    const text = formatDateAbsolute(item.iso);
    replaceRange(start, end, text);
    close();
    if (!item.pick) return;

    // The picker can rewrite the date more than once while open.
    let insertEnd = start + text.length;
    const rewrite = (next: string) => {
      // The picker's time field, mid-edit, gets focus straight back.
      const active = document.activeElement;
      replaceRange(start, insertEnd, next);
      insertEnd = start + next.length;
      if (active instanceof HTMLElement && active !== el && active.isConnected) {
        active.focus({ preventScroll: true });
      }
    };
    const rect = el.getBoundingClientRect();
    showDatePicker(rect.left, rect.bottom + 6, {
      value: item.iso,
      onSelect: (iso) => rewrite(formatDateAbsolute(iso)),
      onClear: () => rewrite(""),
    });
  }

  function sync() {
    const m = settings.dateMention ? findMatch(el) : null;
    if (!m) {
      close();
      return;
    }
    match = m;
    const query = el.value.slice(m.start + 1, m.end);
    menu.items = buildDateItems(query);
    menu.command = commit;

    const rect = el.getBoundingClientRect();
    menu.rect = rect;
    if (!component) {
      target = document.createElement("div");
      document.body.appendChild(target);
      component = mount(MentionMenu, { target, props: { menu } }) as MentionComponent;
    }
  }

  function onBlur() {
    close();
  }
  el.addEventListener("blur", onBlur);

  return {
    onInput: sync,
    onKeydown: (event) => {
      if (!component) return false;
      if (event.key === "Escape") {
        close();
        return true;
      }
      if (component.onKeyDown(event)) {
        event.preventDefault();
        return true;
      }
      return false;
    },
    destroy: () => {
      close();
      el.removeEventListener("blur", onBlur);
    },
  };
}
