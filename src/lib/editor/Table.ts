import { Extension, InputRule, getHTMLFromFragment, type Editor } from "@tiptap/core";
import {
  Table as BaseTable,
  TableCell as BaseCell,
  TableHeader as BaseHeader,
  TableRow,
} from "@tiptap/extension-table";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection, type Transaction } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { CellSelection, cellAround, nextCell, selectedRect } from "@tiptap/pm/tables";
import { TRASH_SVG, showBlockMenu, type BlockMenuItem } from "./block-menu";

const HEADER_NODE = "tableHeader";

const ALIGNMENTS = ["left", "center", "right"];

const icon = (body: string) =>
  '<svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" ' +
  'stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  body +
  "</svg>";

const ROW_ABOVE_SVG = icon(
  '<rect x="2.5" y="8.5" width="11" height="5" rx="1"/><path d="M8 2.25v4M6 4.25h4"/>',
);
const ROW_BELOW_SVG = icon(
  '<rect x="2.5" y="2.5" width="11" height="5" rx="1"/><path d="M8 9.75v4M6 11.75h4"/>',
);
const COLUMN_LEFT_SVG = icon(
  '<rect x="8.5" y="2.5" width="5" height="11" rx="1"/><path d="M2.25 8h4M4.25 6v4"/>',
);
const COLUMN_RIGHT_SVG = icon(
  '<rect x="2.5" y="2.5" width="5" height="11" rx="1"/><path d="M9.75 8h4M11.75 6v4"/>',
);
const PLUS_SVG = icon('<path d="M8 3.5v9M3.5 8h9"/>');

const ALIGN_SVG: Record<string, string> = {
  left: icon('<path d="M2.5 4h11M2.5 7h7M2.5 10h11M2.5 13h7"/>'),
  center: icon('<path d="M2.5 4h11M4.5 7h7M2.5 10h11M4.5 13h7"/>'),
  right: icon('<path d="M2.5 4h11M6.5 7h7M2.5 10h11M6.5 13h7"/>'),
};

interface MarkdownState {
  out: string;
  inTable: boolean;
  write(content?: string): void;
  renderInline(parent: PMNode, fromBlockStart?: boolean): void;
  ensureNewLine(): void;
  closeBlock(node: PMNode): void;
}

/** markdown-it hands alignment back per cell; the header's is what is written out. */
const align = {
  default: null,
  parseHTML: (el: HTMLElement) => {
    const value = el.style.textAlign || el.getAttribute("align") || "";
    return ALIGNMENTS.includes(value) ? value : null;
  },
  renderHTML: (attrs: Record<string, unknown>) =>
    attrs.align ? { style: `text-align: ${attrs.align}` } : {},
};

/** A GFM cell is one line of inline Markdown: Enter moves down a row, Shift-Enter writes `<br>`. */
const TableCell = BaseCell.extend({
  content: "paragraph",
  addAttributes() {
    return { ...this.parent?.(), align };
  },
});

const TableHeader = BaseHeader.extend({
  content: "paragraph",
  addAttributes() {
    return { ...this.parent?.(), align };
  },
});

/** One header row on top, no merged cells. Otherwise written as HTML so nothing is lost. */
function isGfm(table: PMNode): boolean {
  let fits = true;
  table.forEach((row, _offset, index) => {
    row.forEach((cell) => {
      const header = cell.type.name === HEADER_NODE;
      if (header !== (index === 0) || cell.attrs.colspan > 1 || cell.attrs.rowspan > 1) {
        fits = false;
      }
    });
  });
  return fits;
}

function delimiter(alignment: unknown): string {
  if (alignment === "left") return ":---";
  if (alignment === "center") return ":---:";
  if (alignment === "right") return "---:";
  return "---";
}

function writeGfm(state: MarkdownState, table: PMNode): void {
  // Read by tiptap-markdown's hard break, which then writes `<br>`.
  state.inTable = true;
  table.forEach((row, _offset, index) => {
    state.write("|");
    row.forEach((cell) => {
      state.write(" ");
      const start = state.out.length;
      // Not at a line start, so `- ` needs no escaping.
      state.renderInline(cell.firstChild!, false);
      // GFM strips one backslash off a pipe before anything else reads the cell, code spans
      // included.
      state.out =
        state.out.slice(0, start) + state.out.slice(start).replace(/\|/g, "\\|");
      state.write(" |");
    });
    state.ensureNewLine();
    if (index === 0) {
      let line = "|";
      row.forEach((cell) => {
        line += ` ${delimiter(cell.attrs.align)} |`;
      });
      state.write(line);
      state.ensureNewLine();
    }
  });
  state.inTable = false;
}

/** No colgroup or min-width: those are the editor's, not the note's. */
function writeHtml(state: MarkdownState, table: PMNode): void {
  const lines = ["<table>"];
  table.forEach((row) => {
    let cells = "";
    row.forEach((cell) => {
      const tag = cell.type.name === HEADER_NODE ? "th" : "td";
      let attrs = "";
      if (cell.attrs.colspan > 1) attrs += ` colspan="${cell.attrs.colspan}"`;
      if (cell.attrs.rowspan > 1) attrs += ` rowspan="${cell.attrs.rowspan}"`;
      if (cell.attrs.align) attrs += ` style="text-align: ${cell.attrs.align}"`;
      const inner = getHTMLFromFragment(cell.firstChild!.content, table.type.schema);
      cells += `<${tag}${attrs}>${inner}</${tag}>`;
    });
    lines.push(`<tr>${cells}</tr>`);
  });
  lines.push("</table>");
  // Line by line, so that inside a list each line gets the item's indent.
  lines.forEach((line, i) => {
    if (i) state.ensureNewLine();
    state.write(line);
  });
}

const Table = BaseTable.extend({
  addStorage() {
    return {
      ...this.parent?.(),
      markdown: {
        serialize(state: MarkdownState, node: PMNode) {
          if (isGfm(node)) writeGfm(state, node);
          else writeHtml(state, node);
          state.closeBlock(node);
        },
        parse: {},
      },
    };
  },
}).configure({
  // A column width has nowhere to go in GFM.
  resizable: false,
  // The drag handle selects the table as one block, as it does any other.
  allowTableNodeSelection: true,
});

export const tableExtensions = [Table, TableRow, TableHeader, TableCell];

/**
 * A cell holds one paragraph; a block forced in splits the table. `null` when `pos` is not in a
 * cell.
 */
export function belowTable(doc: PMNode, pos: number): number | null {
  const $cell = cellAround(doc.resolve(pos));
  return $cell ? $cell.after($cell.depth - 1) : null;
}

/** Input rules stand aside in a cell so what was typed stays text. */
export function outsideCells(rules: InputRule[]): InputRule[] {
  return rules.map(
    (rule) =>
      new InputRule({
        find: rule.find,
        undoable: rule.undoable,
        handler: (props) =>
          cellAround(props.state.doc.resolve(props.range.from))
            ? null
            : rule.handler(props),
      }),
  );
}

function isHeaderRow(row: PMNode | null | undefined): boolean {
  return row?.firstChild?.type.name === HEADER_NODE;
}

function cellAt(view: EditorView, x: number, y: number) {
  const at = view.posAtCoords({ left: x, top: y });
  if (!at) return null;
  const { doc } = view.state;
  // A click on a cell's padding lands between cells rather than in one; the
  // node it is inside says which.
  return (
    cellAround(doc.resolve(at.pos)) ??
    (at.inside >= 0 ? cellAround(doc.resolve(at.inside + 1)) : null)
  );
}

/** Deleting the header row promotes the row below it. */
function deleteRows(editor: Editor): void {
  const rect = selectedRect(editor.state);
  const tablePos = rect.tableStart - 1;
  const takesHeader = rect.top === 0 && isHeaderRow(rect.table.firstChild);
  editor
    .chain()
    .focus()
    .deleteRow()
    .command(({ tr }) => {
      if (takesHeader) promoteHeaderRow(tr, tablePos);
      return true;
    })
    .run();
}

function promoteHeaderRow(tr: Transaction, tablePos: number): void {
  const row = tr.doc.nodeAt(tablePos)?.firstChild;
  const header = tr.doc.type.schema.nodes[HEADER_NODE];
  if (!row || isHeaderRow(row)) return;
  // One step into the table, one more into its first row.
  row.forEach((cell, offset) => {
    tr.setNodeMarkup(tablePos + 2 + offset, header, cell.attrs);
  });
}

/** GFM keeps one alignment per column. */
function alignColumns(editor: Editor, align: string): void {
  const { map, table, tableStart, left, right } = selectedRect(editor.state);
  editor
    .chain()
    .focus()
    .command(({ tr }) => {
      const seen = new Set<number>();
      for (let row = 0; row < map.height; row++) {
        for (let col = left; col < right; col++) {
          const offset = map.map[row * map.width + col];
          if (seen.has(offset)) continue;
          seen.add(offset);
          const cell = table.nodeAt(offset);
          if (cell)
            tr.setNodeMarkup(tableStart + offset, undefined, { ...cell.attrs, align });
        }
      }
      return true;
    })
    .run();
}

function tableMenu(editor: Editor): BlockMenuItem[] {
  const rect = selectedRect(editor.state);
  const items: BlockMenuItem[] = [];

  // A row above the header would be a plain row on top of it, which GFM cannot write.
  if (!(rect.top === 0 && isHeaderRow(rect.table.firstChild))) {
    items.push({
      label: "Insert row above",
      icon: ROW_ABOVE_SVG,
      run: () => editor.chain().focus().addRowBefore().run(),
    });
  }
  items.push(
    {
      label: "Insert row below",
      icon: ROW_BELOW_SVG,
      run: () => editor.chain().focus().addRowAfter().run(),
    },
    {
      label: "Insert column left",
      icon: COLUMN_LEFT_SVG,
      run: () => editor.chain().focus().addColumnBefore().run(),
    },
    {
      label: "Insert column right",
      icon: COLUMN_RIGHT_SVG,
      run: () => editor.chain().focus().addColumnAfter().run(),
    },
    ...ALIGNMENTS.map((alignment) => ({
      label: `Align column ${alignment}`,
      icon: ALIGN_SVG[alignment],
      run: () => alignColumns(editor, alignment),
    })),
  );
  // Neither will take away the last row or column; that is "Delete table".
  if (editor.can().deleteRow()) {
    items.push({
      label: "Delete row",
      icon: TRASH_SVG,
      danger: true,
      run: () => deleteRows(editor),
    });
  }
  if (editor.can().deleteColumn()) {
    items.push({
      label: "Delete column",
      icon: TRASH_SVG,
      danger: true,
      run: () => editor.chain().focus().deleteColumn().run(),
    });
  }
  items.push({
    label: "Delete table",
    icon: TRASH_SVG,
    danger: true,
    run: () => editor.chain().focus().deleteTable().run(),
  });
  return items;
}

/** The table a DOM element belongs to, as the position it sits at. */
function tableAt(view: EditorView, table: Element): { pos: number; node: PMNode } | null {
  let at: number;
  try {
    at = view.posAtDOM(table, 0);
  } catch {
    return null;
  }
  if (at < 0) return null;
  const $at = view.state.doc.resolve(at);
  for (let depth = $at.depth; depth > 0; depth--) {
    const node = $at.node(depth);
    if (node.type.name === "table") return { pos: $at.before(depth), node };
  }
  return null;
}

/** The first cell of the last row: what a row added "after" is added after. */
function lastRowCell(table: PMNode, pos: number): number {
  let offset = pos + 1;
  let row = offset;
  table.forEach((child) => {
    row = offset;
    offset += child.nodeSize;
  });
  return row + 1;
}

/** The last cell of the first row, for the same reason in the other axis. */
function lastColumnCell(table: PMNode, pos: number): number {
  const first = table.firstChild;
  if (!first) return pos + 2;
  let offset = pos + 2;
  let cell = offset;
  first.forEach((child) => {
    cell = offset;
    offset += child.nodeSize;
  });
  return cell;
}

/** One chain, so one undo. */
function addFrom(editor: Editor, cell: number, axis: "row" | "column"): void {
  if (cell + 1 > editor.state.doc.content.size) return;
  const chain = editor
    .chain()
    .focus()
    .command(({ tr }) => {
      tr.setSelection(TextSelection.near(tr.doc.resolve(cell + 1)));
      return true;
    });
  (axis === "row" ? chain.addRowAfter() : chain.addColumnAfter()).run();
}

/**
 * Drawn over the page, not in the document: a control in the document would be a node Markdown
 * cannot write.
 */
function tableControls(editor: Editor, view: EditorView) {
  let wrapper: Element | null = null;

  function bar(kind: string, label: string): HTMLButtonElement {
    const el = document.createElement("button");
    el.type = "button";
    el.className = `table-add ${kind}`;
    el.title = label;
    el.setAttribute("aria-label", label);
    el.innerHTML = PLUS_SVG;
    // The caret stays where it is until the command itself moves it.
    el.addEventListener("mousedown", (event) => event.preventDefault());
    document.body.append(el);
    return el;
  }

  const addRow = bar("table-add-row", "Add row below");
  const addColumn = bar("table-add-col", "Add column right");

  function hide(): void {
    wrapper = null;
    addRow.style.visibility = "hidden";
    addColumn.style.visibility = "hidden";
  }

  function position(): void {
    const table = wrapper?.querySelector("table");
    if (!wrapper || !table || !editor.isEditable) {
      hide();
      return;
    }
    const box = table.getBoundingClientRect();
    // The bars follow the part of a scrolling table that is on screen.
    const clip = wrapper.getBoundingClientRect();
    const left = Math.max(box.left, clip.left);
    const right = Math.min(box.right, clip.right);
    if (right - left <= 0 || box.height <= 0) {
      hide();
      return;
    }

    // Under the wrapper, so the bar does not cover the scrollbar.
    addRow.style.visibility = "visible";
    addRow.style.top = `${clip.bottom + 4}px`;
    addRow.style.left = `${left}px`;
    addRow.style.width = `${right - left}px`;

    addColumn.style.visibility = "visible";
    addColumn.style.top = `${box.top}px`;
    addColumn.style.left = `${right + 4}px`;
    addColumn.style.height = `${box.height}px`;
  }

  function grow(axis: "row" | "column"): void {
    const table = wrapper?.querySelector("table");
    const hit = table ? tableAt(view, table) : null;
    if (!hit) return;
    addFrom(
      editor,
      axis === "row" ? lastRowCell(hit.node, hit.pos) : lastColumnCell(hit.node, hit.pos),
      axis,
    );
    position();
  }

  addRow.addEventListener("click", () => grow("row"));
  addColumn.addEventListener("click", () => grow("column"));

  /** The gaps between the table and its bars count as inside. */
  function inReach(x: number, y: number): boolean {
    if (!wrapper) return false;
    const clip = wrapper.getBoundingClientRect();
    return (
      x >= clip.left &&
      x <= addColumn.getBoundingClientRect().right &&
      y >= clip.top &&
      y <= addRow.getBoundingClientRect().bottom
    );
  }

  function onMove(event: MouseEvent): void {
    const target = event.target as Element | null;
    if (!target || !editor.isEditable) {
      hide();
      return;
    }
    // Moving onto a bar is not leaving the table it belongs to.
    if (addRow.contains(target) || addColumn.contains(target)) return;
    const next = target.closest?.(".tableWrapper") ?? null;
    if (next === wrapper) return;
    if (!next && inReach(event.clientX, event.clientY)) return;
    wrapper = next;
    if (next) position();
    else hide();
  }

  const onScroll = () => {
    if (wrapper) position();
  };

  document.addEventListener("mousemove", onMove);
  document.addEventListener("scroll", onScroll, true);
  window.addEventListener("resize", onScroll);

  return {
    // Every change to the document: a table that grew under the pointer, or
    // started to scroll, takes its bars with it.
    update: () => {
      if (wrapper?.isConnected) position();
      else if (wrapper) hide();
    },
    destroy: () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
      addRow.remove();
      addColumn.remove();
    },
  };
}

/** Enter moves down the column, and from the last row leaves the table. */
export const TableTools = Extension.create({
  name: "tableTools",

  addKeyboardShortcuts() {
    return {
      Enter: () => {
        const { selection, schema } = this.editor.state;
        if (!selection.empty) return false;
        const $cell = cellAround(selection.$from);
        if (!$cell) return false;
        const $below = nextCell($cell, "vert", 1);

        return this.editor.commands.command(({ tr, dispatch }) => {
          if (!dispatch) return true;
          if ($below) {
            tr.setSelection(TextSelection.near(tr.doc.resolve($below.pos + 1)));
          } else {
            const afterTable = $cell.after($cell.depth - 1);
            tr.insert(afterTable, schema.nodes.paragraph.create());
            tr.setSelection(TextSelection.create(tr.doc, afterTable + 1));
          }
          tr.scrollIntoView();
          return true;
        });
      },
    };
  },

  addProseMirrorPlugins() {
    const editor = this.editor;

    return [
      new Plugin({
        key: new PluginKey("tableTools"),
        view: (view) => tableControls(editor, view),
        props: {
          handleDOMEvents: {
            contextmenu: (view, event) => {
              if (!editor.isEditable) return false;
              // A link in a cell keeps its own menu (`links.ts`).
              if ((event.target as Element | null)?.closest?.("a")) return false;
              const $cell = cellAt(view, event.clientX, event.clientY);
              if (!$cell) return false;
              event.preventDefault();

              // A multi-cell selection the click landed in stays, for the row and column verbs.
              const { selection } = view.state;
              const kept =
                selection instanceof CellSelection &&
                $cell.pos >= selection.from &&
                $cell.pos < selection.to;
              if (!kept) {
                view.dispatch(
                  view.state.tr.setSelection(
                    TextSelection.near(view.state.doc.resolve($cell.pos + 1)),
                  ),
                );
              }
              showBlockMenu(event.clientX, event.clientY, tableMenu(editor));
              return true;
            },
          },
        },
      }),
    ];
  },
});
