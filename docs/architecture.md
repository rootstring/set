# Architecture

## Stack

- **Shell:** Tauri 2 (Rust)
- **Frontend:** Svelte 5, SvelteKit (SPA mode), TypeScript, Vite
- **Editor:** TipTap (ProseMirror)
- **Storage:** Markdown files on desktop (`~/Documents/Set` by default), IndexedDB on the web. Both
  use the same file format.
- **Styling:** scoped Svelte CSS and CSS-variable tokens (`packages/design/tokens.css`), light and
  dark
- **Fonts:** Manrope and Roboto Serif, self-hosted (`packages/design/fonts/`)
- **Sync:** [iroh](https://www.iroh.computer/), see [sync.md](sync.md)
- **Dictation:** [whisper.cpp](https://github.com/ggml-org/whisper.cpp) via `whisper-rs`, behind the
  optional `dictation` cargo feature

## Targets

One SvelteKit SPA with two backends behind the same `PageStore` interface:

- **Desktop (Tauri):** Markdown files in a folder you choose.
- **Web:** IndexedDB, byte-compatible with the desktop files.

## Project layout

```
set/
├── src/
│   ├── app.css              # global styles entry
│   ├── styles/              # app CSS: controls, popovers, the editor's editing-only rules
│   ├── routes/              # SvelteKit routes (thin: wire state to components)
│   │   ├── +layout.svelte   # app shell (+layout.ts loads the workspace)
│   │   ├── +page.ts         # `/`, redirects to the last open page or its context
│   │   ├── +error.svelte    # unknown page URL
│   │   ├── [context]/       # /<context>: its last page, or its empty state
│   │   │   └── pages/[slug]/  # /<context>/pages/<title>-<id>
│   │   └── pages/[slug]/    # /pages/<title>-<id>, the old address: redirects
│   └── lib/
│       ├── editor/          # TipTap wrapper, block schema, slash menu, drag handle, links
│       ├── page/            # PageView: title + editor
│       ├── shell/           # app chrome: AppLayout, Sidebar, Titlebar, TrashView,
│       │   │                #   ConfirmPopover, icons
│       │   ├── settings/    # settings tabs and shared controls
│       │   └── onboarding/  # first-run setup
│       ├── search/          # title and body ranking (mirrors src-tauri/src/index.rs)
│       ├── state/           # workspace controller (runes), navigation, view state
│       ├── storage/         # PageStore + backends, Markdown/frontmatter serialization
│       ├── types/           # shared domain types
│       └── utils/           # generic helpers
├── packages/                # shared with anything that publishes a note (see below)
│   ├── design/              # tokens, fonts, content.css (how a note looks)
│   └── markdown/            # Set's Markdown dialect + renderHtml for publishing
├── static/                  # favicon
├── e2e/                     # Playwright suites, run against the built web app
├── scripts/                 # release, bundle-check and dev helpers
├── docs/
└── src-tauri/
    ├── src/
    │   ├── scan.rs          # notes-folder walk (tree + bodies)
    │   ├── watch.rs         # detects edits made outside Set
    │   ├── index.rs         # in-memory content index + ranking
    │   ├── write.rs         # atomic page write
    │   ├── paths.rs         # filenames + reserved names (mirrors paths.ts)
    │   ├── page_id.rs       # random and derived page ids (mirrors utils/id.ts)
    │   ├── updates.rs       # in-app updates
    │   ├── log.rs           # the app log (Help → Show Log)
    │   ├── mcp/             # MCP server (see mcp.md)
    │   │   ├── access.rs    # on/off, access mode, context scope
    │   │   ├── write.rs     # creating pages and contexts
    │   │   └── log.rs       # activity log
    │   ├── sync/            # device sync (see sync.md)
    │   ├── dictation/       # on-device speech-to-text (`dictation` feature)
    │   │   ├── model.rs     # model selection, download, verification
    │   │   ├── audio.rs     # microphone input, resampled to 16 kHz mono
    │   │   └── engine.rs    # whisper.cpp
    │   └── bin/set-mcp.rs   # MCP stdio binary
    └── tests/
        ├── app_log.rs       # the app log against a real home directory
        └── mcp_stdio.rs     # drives the MCP binary like a client
```

### Storage (`src/lib/storage`)

```
storage/
├── index.ts             # picks the backend (fs / IndexedDB)
├── store.ts             # PageStore interface
├── markdown.ts          # doc ↔ Markdown via a headless TipTap editor
├── frontmatter.ts       # frontmatter, body, signature
├── serialize.ts         # page ↔ file
├── paths.ts             # names, paths, contexts, image refs
├── bundle.ts            # export/import bundle (web → desktop)
├── fs-store.ts          # desktop backend
└── indexeddb-store.ts   # web backend
```

## On disk

```
Notes/
├── Work/                        # a context
│   ├── Projects.md              # a page: Markdown + YAML frontmatter
│   ├── Projects/                # its children
│   │   ├── Launch.md
│   │   └── Set-page-assets/     # images used on Projects
│   └── Set-Trash/               # this context's trash, same layout
├── Personal/
│   └── …
└── Set-Trash/                   # deleted contexts
```

- A page is `Title.md`; its children are in a sibling `Title/` folder.
- A context is a top-level folder, with no metadata file or id.
- Deleting a page moves it and its children into the context's `Set-Trash/`. Deleting a context moves
  it into the root `Set-Trash/`.
- Images are stored next to the page and referenced by relative path.
- Saves write a temp file and rename it over the target, so a crash never leaves a truncated file.

## Rules

- **The UI never touches storage.** Components go through `workspace` (`src/lib/state`), the only
  caller of `PageStore`.
- **The backend is picked at startup** in `src/lib/storage/index.ts`. Nothing above `PageStore` knows
  which one it got.
- **One file format.** `serialize.ts` and `markdown.ts` are backend-agnostic.
- **Frontmatter keys are defined only in `frontmatter.ts`** (`id`, `title`, `parentId`, `order`,
  `createdAt`, `updatedAt`, `locked`). Add new page metadata there. It has no DOM dependency, so it
  can be unit-tested.
- **Contexts are derived, not stored.** A page's context is the first segment of its path.
  `parentId: null` means the top of its context. `list()` returns pages from all contexts; callers
  filter to one.
- **Imported Markdown round-trips.** Content without an editor block (HTML blocks, reference-link
  definitions, …) is kept as source, and the file's syntax choices (`_em_` vs `*em*`, `~~~` fences,
  wrapped lines) are preserved. Covered by `src/lib/storage/markdown.test.ts`.
- **Set ignores its own writes.** `watch.rs` coalesces events and skips files matching the length
  and mtime of Set's last write. If the open page changes outside Set while it has unsaved edits, the
  user chooses what to keep.
- **The dialect is shared, the HTML isn't.** `packages/markdown`'s `setDialect` tokenizes Set's
  Markdown for both the editor and `renderHtml`. Syntax changes go there, with a test in each. The
  editor's renderer rules (the HTML its schema parses, and `data-md` for round-trips) stay in
  `editor/markdown/syntax.ts`.
- **A note looks the same everywhere.** How a note's blocks look goes in `packages/design/content.css`,
  under `:is(.ProseMirror, .set-content)`, and `renderHtml` emits the DOM the node views draw.
  Selection, drag and menu styles stay in `src/styles/editor.css`.
- **The editor doesn't know about pages.** `Editor.svelte` takes a document and emits changes.
  Blocks and slash commands are registered in `extensions.ts`.
- **Editor prompts go through state.** Block menus render outside Svelte, so "which page?"
  (`state/page-picker.svelte.ts`), "what link?" (`state/link-dialog.svelte.ts`) and "what
  equation?" (`state/math-dialog.svelte.ts`) are promises answered by panels mounted once in
  `AppLayout`. `workspace` applies the result.

## Further

- [search.md](search.md): indexing and ranking
- [sync.md](sync.md): device sync
- [mcp.md](mcp.md): the MCP server

## Packages

`packages/design` and `packages/markdown` are consumed by the app through the pnpm workspace and
by other sites (the blog) as git dependencies pinned to a release tag:

```json
"@rootstring/set-markdown": "github:rootstring/set#v0.0.3&path:packages/markdown"
```

They ship source (TypeScript and CSS) with no build step, so a consumer's bundler compiles them
(Vite: `ssr.noExternal`). Keep them free of `$lib`, Svelte and DOM dependencies.
