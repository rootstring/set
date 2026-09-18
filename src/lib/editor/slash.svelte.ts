import { Extension } from "@tiptap/core";
import Suggestion from "@tiptap/suggestion";
import { PluginKey } from "@tiptap/pm/state";
import SlashMenu from "./SlashMenu.svelte";
import { outsideCode, suggestionMenu } from "./suggestion-menu.svelte";
import { filterSlashItems, type SlashContext, type SlashItem } from "./slash-commands";
import { settings } from "$lib/state/settings.svelte";

export interface SlashCommandOptions {
  createChildPage?: SlashContext["createChildPage"];
  openPage?: SlashContext["openPage"];
  resolveTitle?: SlashContext["resolveTitle"];
}

export const SlashCommand = Extension.create<SlashCommandOptions>({
  name: "slashCommand",
  addOptions() {
    return { createChildPage: undefined, openPage: undefined, resolveTitle: undefined };
  },
  addProseMirrorPlugins() {
    const context: SlashContext = {
      createChildPage: this.options.createChildPage,
      openPage: this.options.openPage,
      resolveTitle: this.options.resolveTitle,
    };
    return [
      Suggestion<SlashItem, SlashItem>({
        editor: this.editor,
        pluginKey: new PluginKey("slashSuggestion"),
        char: "/",
        allow: (props) => settings.slashMenu && outsideCode(props),
        items: ({ query, editor }) => filterSlashItems(query, editor),
        command: ({ editor, range, props }) => props.run(editor, range, context),
        render: suggestionMenu(SlashMenu),
      }),
    ];
  },
});
