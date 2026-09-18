import { Node, mergeAttributes } from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { formatTarget } from "$lib/storage/paths";
import { cachedAssetUrl, loadAssetUrl } from "./asset-urls";
import { imageFilesFrom, isImageFile } from "./image-files";
import { TRASH_SVG, DUPLICATE_SVG, showBlockMenu } from "./block-menu";
import { belowTable } from "./Table";
import type { BlockMenuItem } from "./block-menu";

const IMAGE_NODE = "image";

const MIN_WIDTH = 48;

export interface ImageOptions {
  resolveAssetUrl?: (ref: string) => Promise<string | null>;
  onInsertAsset?: (file: File) => Promise<string | null>;
}

export const Image = Node.create<ImageOptions>({
  name: IMAGE_NODE,
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,
  addOptions() {
    return {
      resolveAssetUrl: undefined,
      onInsertAsset: undefined,
    };
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
          const attr = Number.parseInt(el.getAttribute("width") ?? "", 10);
          if (Number.isFinite(attr) && attr > 0) return attr;

          const styled = Number.parseInt(
            (el as HTMLElement).style?.width?.replace("px", "") ?? "",
            10,
          );
          return Number.isFinite(styled) && styled > 0 ? styled : null;
        },
        renderHTML: (attrs) => (attrs.width ? { width: String(attrs.width) } : {}),
      },
    };
  },
  parseHTML() {
    return [{ tag: "img[src]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["img", mergeAttributes(HTMLAttributes)];
  },
  addNodeView() {
    return ({ node, getPos, editor }) => {
      let painted: string | null = null;

      const dom = document.createElement("div");
      dom.className = "image-block";
      dom.contentEditable = "false";

      const frame = document.createElement("div");
      frame.className = "image-frame";

      const img = document.createElement("img");

      img.draggable = false;

      frame.append(img);
      dom.append(frame);

      const applyWidth = (width: number | null) => {
        img.style.width = width ? `${width}px` : "";
      };

      const paint = (updated: typeof node) => {
        const src = String(updated.attrs.src ?? "");
        img.alt = String(updated.attrs.alt ?? "");
        applyWidth(updated.attrs.width as number | null);

        if (src === painted) return;
        painted = src;
        if (!src) return;

        const hit = cachedAssetUrl(src);
        if (hit !== undefined) {
          dom.classList.remove("missing");
          img.src = hit;
          return;
        }
        const resolve = this.options.resolveAssetUrl;
        if (!resolve) return;
        img.removeAttribute("src");
        void loadAssetUrl(src, resolve).then((url) => {
          if (painted !== src) return;
          if (url) {
            dom.classList.remove("missing");
            img.src = url;
          } else {
            dom.classList.add("missing");
          }
        });
      };

      paint(node);

      let drag: { x: number; y: number; width: number; aspect: number } | null = null;

      const maxWidth = () => editor.view.dom.clientWidth || Number.POSITIVE_INFINITY;

      const onPointerMove = (event: PointerEvent) => {
        if (!drag) return;
        const dx = event.clientX - drag.x;

        const dy = (event.clientY - drag.y) * drag.aspect;
        const delta = Math.abs(dy) > Math.abs(dx) ? dy : dx;
        const width = Math.round(
          Math.min(Math.max(drag.width + delta, MIN_WIDTH), maxWidth()),
        );
        img.style.width = `${width}px`;
      };

      const onPointerUp = () => {
        if (!drag) return;
        drag = null;
        dom.classList.remove("resizing");
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        window.removeEventListener("pointercancel", onPointerUp);

        const width = Math.round(img.getBoundingClientRect().width);
        const at = nodeHere();
        if (!at) return;
        if (at.node.attrs.width === width) return;
        editor.view.dispatch(
          editor.view.state.tr.setNodeMarkup(at.pos, undefined, {
            ...at.node.attrs,
            width,
          }),
        );
      };

      const grip = document.createElement("span");
      grip.className = "image-grip";
      grip.contentEditable = "false";
      grip.addEventListener("pointerdown", (event) => {
        if (!editor.isEditable || event.button !== 0) return;

        event.preventDefault();
        event.stopPropagation();
        const box = img.getBoundingClientRect();
        drag = {
          x: event.clientX,
          y: event.clientY,
          width: box.width,
          aspect: box.height > 0 ? box.width / box.height : 1,
        };
        dom.classList.add("resizing");
        window.addEventListener("pointermove", onPointerMove);
        window.addEventListener("pointerup", onPointerUp);
        window.addEventListener("pointercancel", onPointerUp);
      });
      frame.append(grip);

      const nodeHere = () => {
        if (typeof getPos !== "function") return null;
        const pos = getPos();
        if (pos == null) return null;
        const found = editor.view.state.doc.nodeAt(pos);
        return found && found.type.name === IMAGE_NODE ? { pos, node: found } : null;
      };

      dom.addEventListener("contextmenu", (event) => {
        if (!editor.isEditable) return;
        event.preventDefault();
        const items: BlockMenuItem[] = [
          {
            label: "Duplicate",
            icon: DUPLICATE_SVG,
            run: () => {
              const at = nodeHere();
              if (!at) return;
              editor
                .chain()
                .focus()
                .insertContentAt(at.pos + at.node.nodeSize, at.node.toJSON())
                .run();
            },
          },
        ];
        items.push({
          label: "Delete",
          icon: TRASH_SVG,
          danger: true,
          run: () => {
            const at = nodeHere();
            if (!at) return;

            editor.view.dispatch(
              editor.view.state.tr.delete(at.pos, at.pos + at.node.nodeSize),
            );
          },
        });
        showBlockMenu(event.clientX, event.clientY, items);
      });

      return {
        dom,
        update: (updated) => {
          if (updated.type.name !== this.name) return false;
          paint(updated);
          return true;
        },
        selectNode: () => dom.classList.add("selected"),
        deselectNode: () => dom.classList.remove("selected"),
        stopEvent: (event) =>
          event.target instanceof HTMLElement &&
          event.target.classList.contains("image-grip"),
        ignoreMutation: () => true,
        destroy: () => {
          window.removeEventListener("pointermove", onPointerMove);
          window.removeEventListener("pointerup", onPointerUp);
          window.removeEventListener("pointercancel", onPointerUp);
        },
      };
    };
  },
  addCommands() {
    return {
      insertImageFiles:
        (files: File[], at?: number | { from: number; to: number }) =>
        ({ editor, state }) => {
          const upload = this.options.onInsertAsset;
          if (!upload || files.length === 0) return false;
          const requested =
            at ?? ({ from: state.selection.from, to: state.selection.to } as const);
          // An image is a block, so one aimed into a table cell goes below it.
          const start = typeof requested === "number" ? requested : requested.from;
          const target = belowTable(state.doc, start) ?? requested;
          void insertFiles(editor, files, target, upload);
          return true;
        },
      pickImageFiles:
        () =>
        ({ editor }) => {
          if (!this.options.onInsertAsset) return false;
          void pickImageFiles().then((files) => {
            if (files.length) editor.commands.insertImageFiles(files);
          });
          return true;
        },
    };
  },
  addProseMirrorPlugins() {
    const editor = this.editor;
    const enabled = () => Boolean(this.options.onInsertAsset);

    return [
      new Plugin({
        key: new PluginKey("imageDropPaste"),
        props: {
          handlePaste: (_view, event) => {
            if (!enabled()) return false;
            const files = imageFilesFrom(event.clipboardData);
            if (files.length === 0) return false;
            event.preventDefault();
            return editor.commands.insertImageFiles(files);
          },
          handleDrop: (view, event, _slice, moved) => {
            if (moved || !enabled()) return false;
            const files = imageFilesFrom(event.dataTransfer);
            if (files.length === 0) return false;
            event.preventDefault();
            const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
            return editor.commands.insertImageFiles(files, at?.pos);
          },
        },
      }),
    ];
  },
  addStorage() {
    return {
      markdown: {
        serialize(
          state: { write(s: string): void; closeBlock(n: unknown): void },
          node: {
            attrs: {
              src: string | null;
              alt: string;
              title: string;
              width: number | null;
            };
          },
        ) {
          const src = String(node.attrs.src ?? "");
          const alt = String(node.attrs.alt ?? "").replace(/[[\]]/g, "");
          const width = node.attrs.width;
          if (width) {
            const title = node.attrs.title
              ? ` title="${escapeAttribute(String(node.attrs.title))}"`
              : "";
            state.write(
              `<img src="${escapeAttribute(src)}" alt="${escapeAttribute(alt)}"${title} ` +
                `width="${Math.round(width)}">`,
            );
          } else {
            const title = node.attrs.title
              ? ` "${String(node.attrs.title).replace(/"/g, '\\"')}"`
              : "";
            state.write(`![${alt}](${formatTarget(src)}${title})`);
          }
          state.closeBlock(node);
        },
        parse: {
          updateDOM(element: HTMLElement) {
            element.querySelectorAll("p").forEach((p) => {
              const images = p.querySelectorAll(":scope > img");
              if (images.length === 0) return;
              if ((p.textContent ?? "").trim() !== "") return;
              if (p.querySelectorAll(":scope > *").length !== images.length) return;
              p.replaceWith(...images);
            });
            // Inline images travel as `<span>`: tiptap-markdown lifts every `img` out of its
            // paragraph.
            element.querySelectorAll("img").forEach((img) => {
              if (!img.parentElement?.closest("p, h1, h2, h3, h4, h5, h6, td, th"))
                return;
              const span = img.ownerDocument.createElement("span");
              span.setAttribute("data-inline-image", "");
              for (const name of ["src", "alt", "title", "width"]) {
                const value = img.getAttribute(name);
                if (value !== null) span.setAttribute(name, value);
              }
              img.replaceWith(span);
            });
          },
        },
      },
    };
  },
});

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    image: {
      insertImageFiles: (
        files: File[],
        at?: number | { from: number; to: number },
      ) => ReturnType;
      pickImageFiles: () => ReturnType;
    };
  }
}

async function insertFiles(
  editor: Editor,
  files: File[],
  at: number | { from: number; to: number },
  upload: (file: File) => Promise<string | null>,
): Promise<void> {
  let target: number | { from: number; to: number } | null = at;
  for (const file of files) {
    const src = await upload(file);
    if (!src) continue;
    const content = {
      type: IMAGE_NODE,
      attrs: { src, alt: file.name.replace(/\.[^.]+$/, "") },
    };
    const chain = editor.chain().focus();

    if (target !== null) chain.insertContentAt(target, content);
    else chain.insertContent(content);
    chain.run();
    target = null;
  }
}

function pickImageFiles(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.multiple = true;
    input.style.display = "none";
    document.body.append(input);

    const finish = (files: File[]) => {
      input.remove();
      resolve(files);
    };
    input.addEventListener("change", () =>
      finish(Array.from(input.files ?? []).filter(isImageFile)),
    );

    input.addEventListener("cancel", () => finish([]));
    input.click();
  });
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
