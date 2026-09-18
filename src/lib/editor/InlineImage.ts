import { Node } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { formatTarget } from "$lib/storage/paths";
import { cachedAssetUrl, loadAssetUrl } from "./asset-urls";

export interface InlineImageOptions {
  resolveAssetUrl?: (ref: string) => Promise<string | null>;
}

interface State {
  text(text: string, escape?: boolean): void;
}

const attr = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

/** An image inside a line of text; `Image.ts` is the block form. */
export const InlineImage = Node.create<InlineImageOptions>({
  name: "inlineImage",
  group: "inline",
  inline: true,
  atom: true,
  draggable: true,
  selectable: true,

  addOptions() {
    return { resolveAssetUrl: undefined };
  },

  addAttributes() {
    return {
      src: {
        default: null,
        parseHTML: (el) => el.getAttribute("src"),
        renderHTML: (attrs) => (attrs.src ? { src: attrs.src } : {}),
      },
      alt: {
        default: "",
        parseHTML: (el) => el.getAttribute("alt") ?? "",
        renderHTML: (attrs) => (attrs.alt ? { alt: attrs.alt } : {}),
      },
      title: {
        default: "",
        parseHTML: (el) => el.getAttribute("title") ?? "",
        renderHTML: (attrs) => (attrs.title ? { title: attrs.title } : {}),
      },
      width: {
        default: null,
        parseHTML: (el) => {
          const width = Number.parseInt(el.getAttribute("width") ?? "", 10);
          return Number.isFinite(width) && width > 0 ? width : null;
        },
        renderHTML: (attrs) => (attrs.width ? { width: String(attrs.width) } : {}),
      },
    };
  },

  parseHTML() {
    return [
      { tag: "span[data-inline-image]", priority: 60 },
      { tag: "img[src][data-inline]", priority: 60 },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return ["img", { ...HTMLAttributes, "data-inline": "" }];
  },

  addNodeView() {
    return ({ node }) => {
      const img = document.createElement("img");
      img.className = "inline-image";
      img.draggable = false;
      let painted: string | null = null;

      const paint = (current: PMNode) => {
        img.alt = String(current.attrs.alt ?? "");
        img.style.width = current.attrs.width ? `${current.attrs.width}px` : "";
        const src = String(current.attrs.src ?? "");
        if (src === painted) return;
        painted = src;
        const hit = cachedAssetUrl(src);
        if (hit !== undefined) {
          img.src = hit;
          return;
        }
        const resolve = this.options.resolveAssetUrl;
        if (!resolve) return;
        void loadAssetUrl(src, resolve).then((url) => {
          if (painted !== src) return;
          if (url) img.src = url;
          else img.classList.add("missing");
        });
      };
      paint(node);

      return {
        dom: img,
        update: (updated) => {
          if (updated.type.name !== "inlineImage") return false;
          paint(updated);
          return true;
        },
      };
    };
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: State, node: PMNode) {
          const src = String(node.attrs.src ?? "");
          const alt = String(node.attrs.alt ?? "").replace(/[[\]]/g, "");
          const title = String(node.attrs.title ?? "");
          if (node.attrs.width) {
            const titled = title ? ` title="${attr(title)}"` : "";
            state.text(
              `<img src="${attr(src)}" alt="${attr(alt)}"${titled} width="${Math.round(node.attrs.width)}">`,
              false,
            );
            return;
          }
          const titled = title ? ` "${title.replace(/"/g, '\\"')}"` : "";
          state.text(`![${alt}](${formatTarget(src)}${titled})`, false);
        },
        parse: {},
      },
    };
  },
});
