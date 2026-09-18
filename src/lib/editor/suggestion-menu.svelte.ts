import type { Range } from "@tiptap/core";
import type { EditorState } from "@tiptap/pm/state";
import type { SuggestionProps } from "@tiptap/suggestion";
import { mount, unmount, type Component } from "svelte";

/**
 * Whether `range` starts outside code, fenced or inline, where a trigger character is just text.
 */
export function outsideCode({
  state,
  range,
}: {
  state: EditorState;
  range: Range;
}): boolean {
  const from = state.doc.resolve(range.from);
  if (from.parent.type.spec.code) return false;
  const codeMark = state.schema.marks.code;
  return !(codeMark && codeMark.isInSet(from.marks()));
}

/** What a suggestion menu is given: the matches, how to pick one, and the caret's rect. */
export interface MenuState<Item> {
  items: Item[];
  command: (item: Item) => void;
  rect: DOMRect | null;
}

/** Escape is left to TipTap, which closes the suggestion. */
export function suggestionMenu<Item>(Menu: Component<{ menu: MenuState<Item> }>) {
  return () => {
    let target: HTMLElement | undefined;
    let component: { onKeyDown: (event: KeyboardEvent) => boolean } | undefined;

    const menu: MenuState<Item> = $state({ items: [], command: () => {}, rect: null });

    function sync(props: SuggestionProps<Item, Item>) {
      menu.items = props.items;
      menu.command = props.command;
      menu.rect = props.clientRect?.() ?? null;
    }

    return {
      onStart: (props: SuggestionProps<Item, Item>) => {
        sync(props);
        target = document.createElement("div");
        document.body.appendChild(target);
        component = mount(Menu, { target, props: { menu } }) as typeof component;
      },
      onUpdate: sync,
      onKeyDown: (props: { event: KeyboardEvent }) => {
        if (props.event.key === "Escape") return false;
        return component?.onKeyDown(props.event) ?? false;
      },
      onExit: () => {
        if (component) unmount(component);
        component = undefined;
        target?.remove();
        target = undefined;
      },
    };
  };
}
