import { Extension } from "@tiptap/core";
import Suggestion from "@tiptap/suggestion";
import { PluginKey } from "@tiptap/pm/state";
import MentionMenu from "./MentionMenu.svelte";
import { outsideCode, suggestionMenu } from "./suggestion-menu.svelte";
import { buildDateItems, type DateMenuItem } from "./date-format";
import { insertDateMention } from "./DateMention";
import { settings } from "$lib/state/settings.svelte";

export const DateMentionCommand = Extension.create({
  name: "dateMentionCommand",
  addProseMirrorPlugins() {
    return [
      Suggestion<DateMenuItem, DateMenuItem>({
        editor: this.editor,
        pluginKey: new PluginKey("dateMentionSuggestion"),
        char: "@",
        allow: (props) => settings.dateMention && outsideCode(props),
        items: ({ query }) => buildDateItems(query),
        command: ({ editor, range, props }) =>
          insertDateMention(editor, range, props.iso, props.pick ?? false),
        render: suggestionMenu(MentionMenu),
      }),
    ];
  },
});
