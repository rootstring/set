# MCP server

`set-mcp` is a local [MCP](https://modelcontextprotocol.io) server that lets AI clients (Claude
Desktop, Claude Code, Cursor, …) search and read your notes. It's read-only by default. **Read &
add** also lets it create pages; it can't edit, move or delete them yet.

## Setup

1. Turn on **Settings → Agent access**.
2. Click **Copy prompt** and paste it to your agent. The agent adds the server to its own config:

   ```text
   I keep my notes in an app called Set. Add its MCP server so you can search and read them:

     name: set
     command: /absolute/path/to/set-mcp

   It runs locally over stdio and takes no arguments.
   ```

3. Choose an **Access mode**: _Read only_ (default) or _Read & add_.

- Changes apply on the client's next connection. They're stored in an access file, not the
  client's config.
- Set doesn't need to be running. The client spawns `set-mcp`, which reads the notes folder
  directly. It can miss unsaved edits on the open page (autosave runs after 1.5s idle).
- The access file records the notes folder. Set updates it when the notes folder changes and on
  launch, so configured clients follow a move. `--notes-dir` and `SET_NOTES_DIR` override it.

### Where `set-mcp` is

| Install         | Location                                                                         |
| --------------- | -------------------------------------------------------------------------------- |
| macOS           | `Set.app/Contents/MacOS/`                                                        |
| `.deb` / `.rpm` | `/usr/bin/`                                                                      |
| Windows         | install folder                                                                   |
| AppImage        | copied into Set's own folder, since the AppImage mount path changes every launch |
| Dev build       | `cd src-tauri && cargo build --release --bin set-mcp` → `target/release/set-mcp` |

## Tools

| Tool             | Mode       | Does                                                                     |
| ---------------- | ---------- | ------------------------------------------------------------------------ |
| `search_pages`   | read       | Ranked search over titles, breadcrumbs and body text. Optional `context` |
| `list_contexts`  | read       | Top-level contexts and their page counts                                 |
| `list_pages`     | read       | Page tree in sidebar order, paginated by cursor. Optional `context`      |
| `get_page`       | read       | A page's full Markdown                                                   |
| `create_page`    | read & add | New page: title, optional Markdown body, and a `parent_id` or `context`  |
| `create_context` | read & add | New top-level context (folder at the notes root)                         |

`context` is case-insensitive. An unknown context is refused with the list of valid ones.
Breadcrumbs start with the context (`Work / Standups`).

## Access

- **Off by default.** The switch writes an access file to the OS config dir
  (`src-tauri/src/mcp/access.rs`). `set-mcp` reads it at startup and exits unless access is on. A
  missing or malformed file counts as off.
- **Read is the fallback.** A missing or invalid mode means read tools only. In read mode the create
  tools aren't listed or callable.
- **Context scope (not in Settings yet).** If the access file's `allowedContexts` lists contexts,
  only those are visible. `list_contexts`, `list_pages` and `get_page` are filtered, and
  out-of-scope pages are removed before `search_pages` runs. A scoped session can only create pages
  in its contexts and can't use `create_context`.
- **Activity log.** Every call is appended to a capped log in the same config folder
  (`src-tauri/src/mcp/log.rs`): queries, pages read or created, refused connections. Settings shows
  recent entries.

## No authentication

`set-mcp` speaks JSON-RPC over stdio, with no port or socket. The process that spawns it runs as you
and can already read the notes folder, so a token wouldn't add protection:

| Threat                                | Does a token help?                                                                            |
| ------------------------------------- | --------------------------------------------------------------------------------------------- |
| Another local process reads the notes | No, it can read the folder directly                                                           |
| A configured client is malicious      | No, it would have the token from its config                                                   |
| Prompt injection in a note            | No. Read only has nothing to misuse, and Read & add can at most create a page you didn't want |
| The connected AI leaks your notes     | No, that's the access you granted                                                             |

The switch isn't a security boundary: anyone who can run `set-mcp` can read the folder directly. A
network transport would need real auth, `Origin` validation and DNS-rebinding protection.

## Tests

- `src-tauri/src/mcp/` unit tests run the server in-process: ranking, pagination, scope, Read & add,
  refusals.
- `src-tauri/tests/mcp_stdio.rs` spawns the real binary: access gate, one-reply-per-line framing, no
  reply to notifications, notes-folder resolution, a created page found by a later session, and the
  activity log. Each test uses a temp home directory.

Don't wrap `io::stdout()` in a `BufWriter`. Unit tests still pass, but real clients hang waiting for
a buffered reply. The stdio tests catch this.
