# Search and indexing

The ⌘K switcher shows two sections, in this order:

1. **Titles:** matched against the in-memory page list. Synchronous and always current, including
   titles that haven't been saved yet.
2. **Content:** matched against page bodies from storage. Async, backed by the index.

## The index

A map of **page id → Markdown body**, frontmatter stripped so queries don't match ids or timestamps.
No tokens or postings lists (see [No inverted index](#no-inverted-index)). Titles aren't in it.

The Rust and TypeScript frontmatter strips are kept in step by
`strip_frontmatter_matches_the_typescript_split` in `src-tauri/src/scan.rs`.

### When it's built

- **Desktop:** during the startup scan (`scan_notes` in `src-tauri/src/scan.rs`), which already reads
  every file. No extra I/O.
- **Web:** on the first search, then updated in place.

### Keeping it current

| Event                         | Desktop                                                       | Web                                    |
| ----------------------------- | ------------------------------------------------------------- | -------------------------------------- |
| Page saved                    | `write_page` re-indexes the page                              | `put()` updates the cached body        |
| Page moved, restored, renamed | Same; every write goes through `atomicWrite` with the page id | Same; every write goes through `put()` |
| Page trashed or deleted       | Nothing (see below)                                           | `deleteForever` drops the body         |
| Notes folder changed          | Next scan replaces the map                                    | Store is rebuilt                       |
| Edited outside Set            | The folder watch (`watch.rs`) triggers a rescan               | n/a                                    |

- `write_page` re-indexes only after the write succeeds, so the index never holds text that isn't on
  disk.
- Deleted pages aren't evicted. `Workspace.searchContent` passes the live page ids as `only`, which
  covers trash, deletion and stale entries. A restored page is searchable immediately.
- `only` is applied before the limit, so pages outside the scope can't take up the 20 slots. The
  switcher narrows it further to the active context, minus pages already listed by title.
- Searches take a read lock and run off the main thread (`#[tauri::command(async)]`), so a long
  scan doesn't freeze the window. A save waits only for searches already running.
- Opening the switcher flushes pending autosave (`Workspace.openQuickSwitcher`), so unsaved edits
  are searchable. `loadBacklinks` flushes too.

## Ranking

### Titles

`src/lib/search/titles.ts`, over `workspace.pages`. Tiers are tried in order and the first match
wins:

| Tier                  | Matches                                          | Example, query `alpha`        |
| --------------------- | ------------------------------------------------ | ----------------------------- |
| exact                 | title is the query                               | `Alpha`                       |
| prefix                | title starts with it                             | `Alpha Rollout`               |
| word-prefix           | a word in the title starts with it               | `Project Alpha`               |
| all-terms word-prefix | every term starts a word, any order (multi-term) | `proj alph` → `Project Alpha` |
| substring             | anywhere, including mid-word                     | `Cephalopod`                  |
| all-terms             | every term appears somewhere (multi-term)        |                               |
| fuzzy                 | letters in order, not adjacent                   | `pjal` → `Project Alpha`      |
| path                  | an ancestor's title matches                      | `Alpha / Notes`               |

Ties break on shorter title, then alphabetically, so the order is stable while typing.

### Content

`src-tauri/src/index.rs` (desktop) and `src/lib/search/content.ts` (web) implement the same
algorithm, kept in step by mirrored test suites.

- Every term must appear in the page (AND).
- Matching is by substring: `serial` finds `serializer`.
- Case folding is ASCII-only: `TODO` finds `todo`, but `CAFÉ` doesn't find `café`. This keeps the
  folded text the same length as the original, so snippet offsets line up (Unicode folding can
  change length, e.g. `İ`). Tested on both sides.

| Score component   | Weight                 |
| ----------------- | ---------------------- |
| exact phrase      | +60                    |
| terms on one line | +20 each               |
| repetition        | +1 each, capped at 10  |
| position          | up to +5, near the top |

Ties break on page id so results don't reorder between identical queries.

### Snippet

The line with the most distinct terms (earliest wins ties), trimmed of indentation and cut to 160
characters around the first hit. It's returned as runs (`[{text, hit}]`) instead of offsets, because
Rust byte offsets don't match JavaScript string indices. Title highlighting uses the same format.

## Backlinks

A page's **Linked from** list (pages whose body contains a `[[wikilink]]` to it) comes from the same
id → body map via `PageStore.backlinks(title)`, with no separate index or I/O. It shows under the
title, up to three names, with `+N` opening the full list (`src/lib/page/Backlinks.svelte`).

- Results are filtered against the live page list (`Workspace.loadBacklinks`), like search.
- **Matching is by title**, since `[[Other]]` stores only a title:
  - Renaming a page changes its backlinks. The list is recomputed when the title changes (debounced).
  - If another page answers to the same title (`Workspace.pageIdByTitle` prefers the current
    context), the open page shows no backlinks.
  - Child pages (`[Title](page:<id>)`) aren't backlinks.

### Parsing links

`wiki_link_titles` (`index.rs`) and `wikiLinkTitles` (`src/lib/search/wiki-links.ts`) share one list
of test cases (`same_titles_as_the_typescript_scanner` / `matches the Rust scanner`). Both follow the
editor's rule (`editor/markdown/syntax-extras.ts`): drop the alias after `|` and the section after
`#`, trim, and skip fenced code blocks and backtick spans.

Known gap: indented (four-space) code blocks aren't skipped.

## No inverted index

- Search runs as you type and matches substrings (`proj` and `ject` both find `Projects`). A linear
  scan handles that directly; an inverted index would need n-grams or a radix tree.
- The scan is fast enough. `search_budget_switcher` measures it the way the switcher asks (20
  hits, median of 11 runs, release build); `search_budget_5000_pages` and `search_budget_long_notes`
  cover the same corpora with every hit returned. All three run in the `Performance` workflow.
  Measured on a MacBook Pro (13-inch, M1, 2020: 4 performance + 4 efficiency cores, 16 GB, macOS
  14.2.1, Rust 1.95.0):

  | Corpus                     | Query                    | Median  |
  | -------------------------- | ------------------------ | ------- |
  | 5,000 pages / 8 MB         | 1 page matches           | ~9 ms   |
  | 5,000 pages / 8 MB         | every page matches       | ~21 ms  |
  | 5,000 pages / 8 MB         | two terms + phrase check | ~51 ms  |
  | 2,000 pages / 20 MB        | 1 page matches           | ~23 ms  |
  | 2,000 pages / 20 MB        | common term, every page  | ~53 ms  |
  | 2,000 pages / 20 MB        | two terms + phrase check | ~125 ms |
  | 400 of those (one context) | two terms + phrase check | ~25 ms  |

- The time goes to scanning, not ranking or snippets: a two-term query makes about five passes over
  each matching page (term checks, best line per term, phrase). Building snippets only for the
  returned hits was tried and made no measurable difference. If the scan needs to get faster, start
  with `find_ci`, which compares one byte at a time.
- Web cost scales with total bytes, not page count. If that changes, revisit.
- With nothing derived, there's no on-disk cache to fall out of sync with the files.

## MCP search

`search_pages` runs the same `run_search`, adds title and breadcrumb matches, and returns one ranked
list. Hits whose title matched are labelled `(name matches)`.

- The `context` argument (also on `list_pages`) and the access scope both remove pages before
  `run_search` runs, so excluded pages can't affect ranking, counts or timing. Without `context`,
  every context is searched.
- `set-mcp` is a separate process with no persistent index. Each call rescans the folder (~70 ms for
  5,000 pages), so a page from `create_page` is searchable on the next call.

## Code

| Path                                 | Role                                                        |
| ------------------------------------ | ----------------------------------------------------------- |
| `src-tauri/src/scan.rs`              | Folder walk: page tree and bodies in one pass               |
| `src-tauri/src/index.rs`             | Content index and ranking; `search_notes`, `page_backlinks` |
| `src-tauri/src/write.rs`             | Atomic page write, re-indexes the page                      |
| `src/lib/search/titles.ts`           | Title and breadcrumb ranking                                |
| `src/lib/search/content.ts`          | TypeScript version of `index.rs` for web                    |
| `src/lib/search/wiki-links.ts`       | `[[wikilink]]` parsing, mirrors `wiki_link_titles`          |
| `src/lib/storage/store.ts`           | `PageStore.searchContent()` and `.backlinks()`              |
| `src/lib/shell/QuickSwitcher.svelte` | ⌘K switcher                                                 |
| `src-tauri/src/mcp/mod.rs`           | MCP server, reuses the scan and ranking                     |
| `src-tauri/src/mcp/access.rs`        | Agent access: on/off, access mode, context scope            |
| `src-tauri/src/mcp/log.rs`           | MCP activity log                                            |
| `src-tauri/src/mcp/write.rs`         | Creating pages and contexts (Read & add)                    |
| `src-tauri/src/paths.rs`             | Filenames and reserved names, mirrors `paths.ts`            |

Tests: `src/lib/search/*.test.ts` (`pnpm test:unit`), `mod tests` in `scan.rs`, `index.rs` and
`mcp/mod.rs` (`cargo test`), and `e2e/search.spec.ts`.
