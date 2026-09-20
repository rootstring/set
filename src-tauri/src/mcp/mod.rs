use std::collections::{HashMap, HashSet};
use std::io::{BufRead, Write};
use std::path::PathBuf;

use serde_json::{json, Map, Value};

use crate::index::{find_ci, run_search, MIN_QUERY_CHARS};
use crate::paths::context_of;
use crate::scan::{scan_tree, ScanEntry};

pub mod access;
pub mod log;
mod rpc;
mod tools;
mod write;

const DEFAULT_PAGE_LIMIT: usize = 50;
const MAX_PAGE_LIMIT: usize = 200;
const DEFAULT_SEARCH_LIMIT: usize = 20;
const MAX_SEARCH_LIMIT: usize = 50;

const TITLE_SCORE: f64 = 1000.0;

const PATH_SCORE: f64 = 500.0;

pub trait Journal: Send + Sync {
    fn record(&self, tool: &str, detail: &str, results: usize);
}

pub struct Server {
    root: PathBuf,

    /// `None` for all. Scoped per context, since that is the unit the user grants.
    scope: Option<HashSet<String>>,

    writable: bool,
    journal: Option<Box<dyn Journal>>,
}

struct Hit<'a> {
    page: &'a Page,
    score: f64,

    snippet: Option<&'a str>,

    named: bool,
}

struct Page {
    id: String,
    title: String,

    path: String,

    rel: String,

    locked: bool,
}

impl Server {
    pub fn new(root: PathBuf) -> Self {
        Server {
            root,
            scope: None,
            writable: false,
            journal: None,
        }
    }

    pub fn with_scope(mut self, contexts: Option<Vec<String>>) -> Self {
        self.scope = contexts.map(|names| names.into_iter().collect());
        self
    }

    pub fn with_write(mut self, writable: bool) -> Self {
        self.writable = writable;
        self
    }

    pub fn with_journal(mut self, journal: Box<dyn Journal>) -> Self {
        self.journal = Some(journal);
        self
    }

    fn record(&self, tool: &str, detail: &str, results: usize) {
        if let Some(journal) = &self.journal {
            journal.record(tool, detail, results);
        }
    }

    fn readable(&self) -> (Vec<Page>, HashMap<String, String>) {
        let (entries, bodies) = scan_tree(&self.root.to_string_lossy());
        let mut pages = in_tree_order(&entries);
        if let Some(scope) = &self.scope {
            pages.retain(|page| scope.contains(context_of(&page.rel)));
        }
        (pages, bodies)
    }

    fn in_scope(&self, context: &str) -> bool {
        self.scope
            .as_ref()
            .is_none_or(|scope| scope.contains(context))
    }

    pub fn serve(&self, input: impl BufRead, mut output: impl Write) -> std::io::Result<()> {
        for line in input.lines() {
            let line = line?;
            if line.trim().is_empty() {
                continue;
            }
            if let Some(reply) = self.handle(&line) {
                writeln!(output, "{reply}")?;

                output.flush()?;
            }
        }
        Ok(())
    }

    pub fn handle(&self, line: &str) -> Option<String> {
        let message: Value = match serde_json::from_str(line) {
            Ok(value) => value,
            Err(err) => {
                return Some(rpc::error(
                    Value::Null,
                    -32700,
                    &format!("parse error: {err}"),
                ))
            }
        };

        let method = message.get("method").and_then(Value::as_str).unwrap_or("");
        let id = match message.get("id") {
            Some(Value::Null) | None => return None,
            Some(id) => id.clone(),
        };

        let result = match method {
            "initialize" => Ok(self.initialize(message.get("params"))),

            "ping" => Ok(json!({})),
            "tools/list" => Ok(tools::list(self.writable)),
            "tools/call" => self.tools_call(message.get("params")),
            _ => Err(rpc::RpcError::new(
                -32601,
                format!("unknown method: {method}"),
            )),
        };

        Some(match result {
            Ok(value) => rpc::result(id, value),
            Err(err) => rpc::error(id, err.code, &err.message),
        })
    }

    fn initialize(&self, params: Option<&Value>) -> Value {
        let version = rpc::negotiate(
            params
                .and_then(|p| p.get("protocolVersion"))
                .and_then(Value::as_str),
        );
        json!({
            "protocolVersion": version,

            "capabilities": { "tools": {} },
            "serverInfo": {
                "name": "set",
                "version": env!("CARGO_PKG_VERSION"),
            },
            "instructions": self.instructions(),
        })
    }

    fn instructions(&self) -> String {
        let shared = "Access to the user's Set notes: a tree of Markdown pages, grouped into \
top-level contexts (\"Work\", \"Personal\", …) that the user switches between in the app. Every \
page's path begins with its context, and all contexts are searched together unless you narrow to \
one. Use search_pages to find pages by title or body text, list_pages to browse the tree, and \
get_page to read one page in full. Page ids come from list_pages and search_pages. list_contexts \
names the contexts; pass one as `context` to search_pages or list_pages when the request is about \
a single area of the notes, and leave it off otherwise.";
        let shared = match &self.scope {
            Some(_) => format!(
                "{shared} The user has shared only some of their contexts with you; \
list_contexts names exactly the ones you can reach, and the rest are not yours to see."
            ),
            None => shared.to_string(),
        };
        if self.writable {
            format!(
                "{shared} You may also add to these notes: create_page writes a new page and \
create_context makes a new top-level context. A page created under a parent is listed at the \
end of that parent; beyond that, nothing here can change or delete a page that already exists. \
Before writing something the user has told you before, search for it, since adding a second \
page is all you can do. Search first anyway when the user asks you to remember something: the \
right place is usually inside a page that is already there."
            )
        } else {
            format!("{shared} This server cannot create, edit, or delete anything.")
        }
    }

    fn tools_call(&self, params: Option<&Value>) -> Result<Value, rpc::RpcError> {
        let params = params.cloned().unwrap_or(Value::Null);
        let Some(name) = params.get("name").and_then(Value::as_str) else {
            return Err(rpc::RpcError::new(
                -32602,
                "tools/call requires a `name`".into(),
            ));
        };
        let empty = Map::new();
        let args = params
            .get("arguments")
            .and_then(Value::as_object)
            .unwrap_or(&empty);

        let outcome = match name {
            "list_contexts" => self.list_contexts(),
            "list_pages" => self.list_pages(args),
            "search_pages" => self.search_pages(args),
            "get_page" => self.get_page(args),

            "create_page" | "create_context" if !self.writable => Err(format!(
                "{name} needs write access, which is off. This server can only read the \
notes right now. The user can allow new pages in Set under Settings → Agent access."
            )),
            "create_page" => self.create_page(args),
            "create_context" => self.create_context(args),
            other => Err(format!(
                "unknown tool: {other}. Available: {}.",
                self.tool_names().join(", ")
            )),
        };

        Ok(match outcome {
            Ok(text) => json!({ "content": [{ "type": "text", "text": text }] }),
            Err(message) => json!({
                "content": [{ "type": "text", "text": message }],
                "isError": true,
            }),
        })
    }

    fn list_contexts(&self) -> Result<String, String> {
        let (pages, _) = self.readable();
        let names = self.contexts(&pages);
        if names.is_empty() {
            self.record("list_contexts", "", 0);
            return Ok(self.nothing_readable("This notes folder has no contexts yet."));
        }

        let mut out = String::new();
        for name in &names {
            let pages = pages
                .iter()
                .filter(|page| context_of(&page.rel) == name)
                .count();
            out.push_str(&match pages {
                0 => format!("{name}  (no pages)\n"),
                1 => format!("{name}  (1 page)\n"),
                n => format!("{name}  ({n} pages)\n"),
            });
        }
        out.push_str(&format!(
            "\n{} {}. Pass one as `context` to search_pages or list_pages to stay inside it.",
            names.len(),
            if names.len() == 1 {
                "context"
            } else {
                "contexts"
            }
        ));

        self.record("list_contexts", "", names.len());
        Ok(out)
    }

    fn list_pages(&self, args: &Map<String, Value>) -> Result<String, String> {
        let limit = clamp_limit(args.get("limit"), DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT)?;
        let offset = match args.get("cursor") {
            None | Some(Value::Null) => 0,
            Some(Value::String(s)) => s
                .parse::<usize>()
                .map_err(|_| format!("cursor is not one this server issued: {s}"))?,
            Some(other) => return Err(format!("cursor must be a string, got {other}")),
        };

        let (pages, _) = self.readable();
        if pages.is_empty() {
            self.record("list_pages", "", 0);
            return Ok(self.nothing_readable("This notes folder has no pages."));
        }
        let context = self.asked_context(args, &pages)?;
        let pages = retain_context(pages, context.as_deref());
        if pages.is_empty() {
            let name = context.unwrap_or_default();
            self.record("list_pages", &name, 0);
            return Ok(format!("No pages in the {name:?} context."));
        }
        if offset >= pages.len() {
            return Err(format!(
                "cursor {offset} is past the end; there are {} pages{}.",
                pages.len(),
                in_context(context.as_deref())
            ));
        }

        let window = &pages[offset..pages.len().min(offset + limit)];
        let mut out = String::new();
        for page in window {
            out.push_str(&format!("{}  [id: {}]\n", display_name(page), page.id));
        }
        out.push_str(&format!(
            "\nShowing {}-{} of {}{}.",
            offset + 1,
            offset + window.len(),
            pages.len(),
            in_context(context.as_deref())
        ));
        if offset + window.len() < pages.len() {
            out.push_str(&format!(
                " More pages remain: call list_pages again with cursor \"{}\"{}.",
                offset + window.len(),
                match &context {
                    Some(name) => format!(" and context {name:?}"),
                    None => String::new(),
                }
            ));
        }
        self.record(
            "list_pages",
            context.as_deref().unwrap_or_default(),
            window.len(),
        );
        Ok(out)
    }

    fn search_pages(&self, args: &Map<String, Value>) -> Result<String, String> {
        let query = args
            .get("query")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|q| !q.is_empty())
            .ok_or("search_pages requires a non-empty `query`.")?;
        if query.chars().count() < MIN_QUERY_CHARS {
            return Err(format!(
                "query must be at least {MIN_QUERY_CHARS} characters; got {query:?}."
            ));
        }
        let limit = clamp_limit(args.get("limit"), DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT)?;
        let detail = match args.get("context").and_then(Value::as_str) {
            Some(name) if !name.trim().is_empty() => format!("{query} (in {})", name.trim()),
            _ => query.to_string(),
        };

        let (pages, bodies) = self.readable();
        if pages.is_empty() {
            self.record("search_pages", &detail, 0);
            return Ok(self.nothing_readable("This notes folder has no pages."));
        }

        let context = self.asked_context(args, &pages)?;
        let scoped_to = in_context(context.as_deref());
        let narrowed = self.scope.is_some() || context.is_some();
        let pages = retain_context(pages, context.as_deref());
        if pages.is_empty() {
            self.record("search_pages", &detail, 0);
            return Ok(format!("There are no pages{scoped_to} to search."));
        }

        // A narrowed session never sees the body of a page it cannot return.
        let bodies: HashMap<String, String> = if narrowed {
            pages
                .iter()
                .filter_map(|page| bodies.get_key_value(&page.id))
                .map(|(id, body)| (id.clone(), body.clone()))
                .collect()
        } else {
            bodies
        };

        let mut scores: HashMap<String, (f64, Option<String>)> = HashMap::new();
        for hit in run_search(&bodies, query, pages.len().max(1)) {
            let snippet = hit
                .snippet
                .iter()
                .map(|segment| segment.text.as_str())
                .collect::<String>();
            scores.insert(hit.id, (hit.score, Some(snippet)));
        }
        let lowered = query.to_lowercase();
        let mut named: HashSet<String> = HashSet::new();
        for page in &pages {
            let bonus = if find_ci(&page.title, &lowered, 0).is_some() {
                TITLE_SCORE
            } else if !page.path.is_empty() && find_ci(&page.path, &lowered, 0).is_some() {
                PATH_SCORE
            } else {
                continue;
            };
            scores.entry(page.id.clone()).or_insert((0.0, None)).0 += bonus;
            named.insert(page.id.clone());
        }

        let mut ranked: Vec<Hit> = pages
            .iter()
            .filter_map(|page| {
                scores.get(&page.id).map(|(score, snippet)| Hit {
                    page,
                    score: *score,
                    snippet: snippet.as_deref(),
                    named: named.contains(&page.id),
                })
            })
            .collect();
        if ranked.is_empty() {
            self.record("search_pages", &detail, 0);
            return Ok(format!("No pages match {query:?}{scoped_to}."));
        }

        ranked.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.page.id.cmp(&b.page.id))
        });
        let total = ranked.len();
        ranked.truncate(limit);

        let mut out = String::new();
        for (i, hit) in ranked.iter().enumerate() {
            out.push_str(&format!(
                "{}. {}  [id: {}]{}\n",
                i + 1,
                display_name(hit.page),
                hit.page.id,
                if hit.named { "  (name matches)" } else { "" },
            ));
            match hit.snippet {
                Some(line) => out.push_str(&format!("   {line}\n")),
                None => out.push_str("   (no match in the body; matched on the name)\n"),
            }
        }
        if total > limit {
            out.push_str(&format!(
                "\nShowing the top {limit} of {total} matching pages{scoped_to}."
            ));
        }

        self.record("search_pages", &detail, ranked.len());
        Ok(out)
    }

    fn get_page(&self, args: &Map<String, Value>) -> Result<String, String> {
        let id = args
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .ok_or("get_page requires an `id`. Get one from list_pages or search_pages.")?;

        let (pages, bodies) = self.readable();
        let page = pages.iter().find(|page| page.id == id).ok_or_else(|| {
            if self.scope.is_some() && self.knows_of(id) {
                self.record("get_page", "(refused: out of scope)", 0);
                format!(
                    "The page {id:?} exists but is in a context outside the ones you've \
allowed agent access to. Ask the user to widen the scope in Set under Settings → Agent access."
                )
            } else {
                format!("No page has id {id:?}. List or search for a current id.")
            }
        })?;

        let body = bodies.get(id).map(String::as_str).unwrap_or("");
        let mut out = format!("# {}\n", page.title);
        if !page.path.is_empty() {
            out.push_str(&format!("Path: {}\n", page.path));
        }
        out.push_str(&format!("Id: {}\n\n", page.id));
        if body.trim().is_empty() {
            out.push_str("(This page is empty.)");
        } else {
            out.push_str(body);
        }

        self.record("get_page", &display_name(page), 1);
        Ok(out)
    }

    fn create_page(&self, args: &Map<String, Value>) -> Result<String, String> {
        let title = args
            .get("title")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .ok_or(
                "create_page requires a non-empty `title`. It is how the page is found \
later, so make it specific.",
            )?;
        let body = args.get("text").and_then(Value::as_str).unwrap_or("");
        let parent_id = args
            .get("parent_id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|id| !id.is_empty());
        let context = args
            .get("context")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|c| !c.is_empty());

        if parent_id.is_some() && context.is_some() {
            return Err(
                "Pass `parent_id` or `context`, not both. A child page is always \
in its parent's context."
                    .into(),
            );
        }

        let (pages, _) = self.readable();

        let (folder, breadcrumb) = match parent_id {
            Some(id) => {
                let parent = pages.iter().find(|page| page.id == id).ok_or_else(|| {
                    if self.scope.is_some() && self.knows_of(id) {
                        format!(
                            "The page {id:?} exists but is in a context outside the ones \
you've been allowed. Ask the user to widen the scope in Set under Settings → Agent access."
                        )
                    } else {
                        format!("No page has id {id:?}. List or search for a current id.")
                    }
                })?;
                // A sub-page is linked from its parent's body, which a locked parent won't take.
                if parent.locked {
                    return Err(format!(
                        "The page {} is locked, so nothing can be added under it. Ask the user \
to unlock it in Set, or create the page somewhere else.",
                        display_name(parent)
                    ));
                }
                (
                    write::child_folder_of(&parent.rel).to_string(),
                    display_name(parent),
                )
            }

            None => {
                let context = self.context_for_new_page(context, &pages)?;
                (context.clone(), context)
            }
        };

        let made = write::create_page(&self.root, &folder, title, body, parent_id)?;
        let where_it_is = format!("{breadcrumb} / {title}");
        self.record("create_page", &where_it_is, 1);

        // The child is a file already; a parent that couldn't be written leaves it unlisted,
        // which is worth saying, not worth a retry that would make a second one.
        let unlinked = parent_id
            .and_then(|id| pages.iter().find(|page| page.id == id))
            .and_then(|parent| write::link_child(&self.root, &parent.rel, &made.id, title).err());

        let mut reply = format!(
            "Created {where_it_is}  [id: {}]\nIt is in the {} context, and the user will see \
it in Set within a moment. Read it back with get_page.",
            made.id,
            context_of(&made.rel_path),
        );
        if let Some(err) = unlinked {
            reply.push_str(&format!(
                "\nThe page is on disk, but its parent couldn't be updated to list it ({err}). \
Tell the user, and don't create it again."
            ));
        }
        Ok(reply)
    }

    /// A scoped session is never told other contexts exist, not even one it named.
    fn context_for_new_page(&self, asked: Option<&str>, pages: &[Page]) -> Result<String, String> {
        if self.scope.is_none() {
            return write::context_folder(&self.root, asked);
        }
        let shared = self.contexts(pages);
        let nowhere = || {
            format!(
                "Ask the user to widen the scope in Set under Settings → Agent access, \
or pass `parent_id` to nest the page under a page you can already read. Shared contexts: {}.",
                write::name_list(&shared)
            )
        };
        match asked {
            Some(name) => shared
                .iter()
                .find(|shared| shared.as_str() == name)
                .or_else(|| {
                    shared
                        .iter()
                        .find(|shared| shared.eq_ignore_ascii_case(name))
                })
                .cloned()
                .ok_or_else(|| {
                    format!(
                        "No context named {name:?} is shared with you. {}",
                        nowhere()
                    )
                }),
            None => match shared.as_slice() {
                [only] => Ok(only.clone()),
                [] => Err(format!(
                    "Agent access is on, but no context is shared, so there is nowhere to \
put a new page. {}",
                    nowhere()
                )),
                _ => Err(format!(
                    "Agent access is scoped, so a new page needs a `context` naming one of \
the shared ones: {}. (Or pass `parent_id` to nest it under an existing page.)",
                    write::name_list(&shared)
                )),
            },
        }
    }

    fn create_context(&self, args: &Map<String, Value>) -> Result<String, String> {
        let name = args
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|n| !n.is_empty())
            .ok_or("create_context requires a non-empty `name`.")?;

        if self.scope.is_some() {
            return Err(
                "Agent access is scoped to the contexts the user picked, so it can't \
make a new one. Ask the user to allow all contexts in Set under Settings → Agent access first."
                    .into(),
            );
        }
        let created = write::create_context(&self.root, name)?;
        self.record("create_context", &created, 1);
        Ok(format!(
            "Created the context {created:?}. Put pages in it with create_page and \
context: {created:?}."
        ))
    }

    /// Includes the context of every readable page, which covers a page loose at the root.
    fn contexts(&self, pages: &[Page]) -> Vec<String> {
        let mut names = write::contexts(&self.root);
        for page in pages {
            let context = context_of(&page.rel);
            if !names.iter().any(|name| name == context) {
                names.push(context.to_string());
            }
        }
        names.retain(|name| self.in_scope(name));
        names.sort();
        names
    }

    /// `None` is every context.
    fn asked_context(
        &self,
        args: &Map<String, Value>,
        pages: &[Page],
    ) -> Result<Option<String>, String> {
        let asked = match args.get("context") {
            None | Some(Value::Null) => return Ok(None),
            Some(Value::String(name)) => name.trim(),
            Some(other) => return Err(format!("context must be a string, got {other}")),
        };
        if asked.is_empty() {
            return Ok(None);
        }

        let known = self.contexts(pages);
        known
            .iter()
            .find(|name| name.as_str() == asked)
            .or_else(|| known.iter().find(|name| name.eq_ignore_ascii_case(asked)))
            .cloned()
            .map(Some)
            .ok_or_else(|| {
                format!(
                    "No context named {asked:?}. These notes have: {}. Call list_contexts for \
the current list, or leave `context` off to cover all of them.",
                    write::name_list(&known)
                )
            })
    }

    fn knows_of(&self, id: &str) -> bool {
        let (entries, _) = scan_tree(&self.root.to_string_lossy());
        entries.iter().any(|entry| entry.id == id)
    }

    fn tool_names(&self) -> Vec<&'static str> {
        let mut names = vec!["list_contexts", "list_pages", "search_pages", "get_page"];
        if self.writable {
            names.extend(["create_page", "create_context"]);
        }
        names
    }

    fn nothing_readable(&self, empty_notes: &str) -> String {
        match &self.scope {
            Some(scope) if scope.is_empty() => "Agent access is on, but no contexts are in \
scope. Choose which contexts to share in Set under Settings → Agent access."
                .to_string(),
            Some(_) => "None of the contexts you've allowed agent access to have any pages. \
Check the scope in Set under Settings → Agent access."
                .to_string(),
            None => empty_notes.to_string(),
        }
    }
}

fn in_tree_order(entries: &[ScanEntry]) -> Vec<Page> {
    let mut children: HashMap<Option<&str>, Vec<&ScanEntry>> = HashMap::new();
    for entry in entries {
        children
            .entry(entry.parent_id.as_deref())
            .or_default()
            .push(entry);
    }
    for group in children.values_mut() {
        group.sort_by(|a, b| {
            let key = |e: &ScanEntry| e.order.unwrap_or(e.created_at);
            key(a)
                .partial_cmp(&key(b))
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.id.cmp(&b.id))
        });
    }

    let mut out = Vec::with_capacity(entries.len());
    let mut seen: HashSet<&str> = HashSet::new();

    let mut stack: Vec<(&ScanEntry, String)> = Vec::new();

    for entry in children.get(&None).into_iter().flatten().rev() {
        stack.push((entry, context_of(&entry.rel_path).to_string()));
    }

    while let Some((entry, path)) = stack.pop() {
        if !seen.insert(&entry.id) {
            continue;
        }
        let title = if entry.title.trim().is_empty() {
            "Untitled"
        } else {
            entry.title.trim()
        };
        let child_path = if path.is_empty() {
            title.to_string()
        } else {
            format!("{path} / {title}")
        };
        out.push(Page {
            id: entry.id.clone(),
            title: title.to_string(),
            path,
            rel: entry.rel_path.clone(),
            locked: entry.locked,
        });
        for child in children
            .get(&Some(entry.id.as_str()))
            .into_iter()
            .flatten()
            .rev()
        {
            stack.push((child, child_path.clone()));
        }
    }
    out
}

fn retain_context(pages: Vec<Page>, context: Option<&str>) -> Vec<Page> {
    let Some(context) = context else {
        return pages;
    };
    pages
        .into_iter()
        .filter(|page| context_of(&page.rel) == context)
        .collect()
}

/// The tail of a count, so one sentence covers both the narrowed and the
/// whole-notes case: `12 pages` or `12 pages in the "Work" context`.
fn in_context(context: Option<&str>) -> String {
    match context {
        Some(name) => format!(" in the {name:?} context"),
        None => String::new(),
    }
}

fn display_name(page: &Page) -> String {
    if page.path.is_empty() {
        page.title.clone()
    } else {
        format!("{} / {}", page.path, page.title)
    }
}

fn clamp_limit(value: Option<&Value>, default: usize, max: usize) -> Result<usize, String> {
    match value {
        None | Some(Value::Null) => Ok(default),
        Some(v) => {
            let n = v
                .as_u64()
                .ok_or_else(|| format!("limit must be a positive integer, got {v}"))?;
            if n == 0 {
                return Err("limit must be at least 1.".into());
            }
            Ok((n as usize).min(max))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::TempDir;
    use std::fs;

    fn page(id: &str, title: &str, order: u32, body: &str) -> String {
        format!(
            "---\nid: {id:?}\ntitle: {title:?}\norder: {order}\ncreatedAt: 1000\nupdatedAt: 2000\n---\n\n{body}"
        )
    }

    fn notes() -> (TempDir, Server) {
        let d = TempDir::new("mcp");
        d.write(
            "Work/Projects.md",
            &page("p", "Projects", 0, "Top level container.\n"),
        );
        d.write(
            "Work/Projects/Project Alpha.md",
            &page(
                "a",
                "Project Alpha",
                0,
                "The alpha rollout plan.\nBudget approved.\n",
            ),
        );
        d.write(
            "Work/Projects/Project Beta.md",
            &page(
                "b",
                "Project Beta",
                1,
                "Beta is blocked on the alpha rollout.\n",
            ),
        );
        d.write(
            "Work/Meeting Notes.md",
            &page("n", "Meeting Notes", 1, "Discussed the alpha rollout.\n"),
        );
        d.write(
            "Personal/Groceries.md",
            &page("g", "Groceries", 2, "Milk, eggs.\n"),
        );
        let server = Server::new(d.0.clone());
        (d, server)
    }

    fn scoped(contexts: &[&str]) -> (TempDir, Server) {
        let (d, server) = notes();
        let scope = contexts.iter().map(|s| (*s).to_owned()).collect();
        (d, server.with_scope(Some(scope)))
    }

    fn writable() -> (TempDir, Server) {
        let (d, server) = notes();
        (d, server.with_write(true))
    }

    #[derive(Default)]
    struct Recorder(std::sync::Mutex<Vec<(String, String, usize)>>);

    impl Journal for std::sync::Arc<Recorder> {
        fn record(&self, tool: &str, detail: &str, results: usize) {
            if let Ok(mut entries) = self.0.lock() {
                entries.push((tool.to_owned(), detail.to_owned(), results));
            }
        }
    }

    fn journalled() -> (TempDir, Server, std::sync::Arc<Recorder>) {
        let (d, server) = notes();
        let recorder = std::sync::Arc::new(Recorder::default());
        let server = server.with_journal(Box::new(recorder.clone()));
        (d, server, recorder)
    }

    fn call(server: &Server, request: Value) -> Value {
        let raw = server.handle(&request.to_string()).expect("a reply");
        serde_json::from_str(&raw).unwrap()
    }

    fn tool(server: &Server, name: &str, args: Value) -> (String, bool) {
        let reply = call(
            server,
            json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                   "params": {"name": name, "arguments": args}}),
        );
        let result = &reply["result"];
        let text = result["content"][0]["text"].as_str().unwrap().to_string();
        (text, result["isError"].as_bool().unwrap_or(false))
    }

    #[test]
    fn initialize_declares_tools_and_agrees_a_version() {
        let (_d, server) = notes();
        let reply = call(
            &server,
            json!({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                   "params": {"protocolVersion": "2024-11-05"}}),
        );
        let result = &reply["result"];

        assert_eq!(result["protocolVersion"], "2024-11-05");
        assert!(result["capabilities"]["tools"].is_object());
        assert_eq!(result["serverInfo"]["name"], "set");

        assert!(result["capabilities"]["sampling"].is_null());
        assert!(result["capabilities"]["resources"].is_null());
    }

    #[test]
    fn an_unknown_protocol_version_gets_ours() {
        let (_d, server) = notes();
        let reply = call(
            &server,
            json!({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                   "params": {"protocolVersion": "1999-01-01"}}),
        );
        assert_eq!(reply["result"]["protocolVersion"], rpc::PROTOCOL_VERSION);
    }

    #[test]
    fn notifications_are_never_answered() {
        let (_d, server) = notes();

        assert!(server
            .handle(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#)
            .is_none());
        assert!(server
            .handle(r#"{"jsonrpc":"2.0","id":null,"method":"notifications/cancelled"}"#)
            .is_none());
    }

    #[test]
    fn malformed_json_gets_a_parse_error_not_a_panic() {
        let (_d, server) = notes();
        let raw = server.handle("{not json").expect("a reply");
        let reply: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(reply["error"]["code"], -32700);
    }

    #[test]
    fn an_unknown_method_is_a_protocol_error() {
        let (_d, server) = notes();
        let reply = call(
            &server,
            json!({"jsonrpc": "2.0", "id": 7, "method": "resources/list"}),
        );
        assert_eq!(reply["error"]["code"], -32601);
        assert_eq!(reply["id"], 7);
    }

    #[test]
    fn ping_answers_empty() {
        let (_d, server) = notes();
        let reply = call(
            &server,
            json!({"jsonrpc": "2.0", "id": 2, "method": "ping"}),
        );
        assert_eq!(reply["result"], json!({}));
    }

    fn listed(server: &Server) -> Vec<String> {
        call(
            server,
            json!({"jsonrpc": "2.0", "id": 3, "method": "tools/list"}),
        )["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap().to_owned())
            .collect()
    }

    #[test]
    fn tools_list_offers_the_four_reads_and_nothing_else_by_default() {
        let (_d, server) = notes();
        assert_eq!(
            listed(&server),
            ["search_pages", "list_contexts", "list_pages", "get_page"]
        );

        let reply = call(
            &server,
            json!({"jsonrpc": "2.0", "id": 3, "method": "tools/list"}),
        );
        for t in reply["result"]["tools"].as_array().unwrap() {
            assert_eq!(t["inputSchema"]["type"], "object");
            assert!(t["description"].as_str().unwrap().len() > 40);
        }
    }

    #[test]
    fn write_mode_adds_the_two_creates_and_keeps_the_reads() {
        let (_d, server) = writable();
        assert_eq!(
            listed(&server),
            [
                "search_pages",
                "list_contexts",
                "list_pages",
                "get_page",
                "create_page",
                "create_context"
            ]
        );
        let reply = call(
            &server,
            json!({"jsonrpc": "2.0", "id": 3, "method": "tools/list"}),
        );
        for t in reply["result"]["tools"].as_array().unwrap() {
            assert_eq!(t["inputSchema"]["type"], "object");
            assert!(t["description"].as_str().unwrap().len() > 40);
        }
    }

    #[test]
    fn no_tool_can_change_or_remove_anything_in_either_mode() {
        for (_d, server) in [notes(), writable()] {
            let reply = call(
                &server,
                json!({"jsonrpc": "2.0", "id": 3, "method": "tools/list"}),
            );
            let listed = reply["result"]["tools"].to_string().to_lowercase();
            for verb in [
                "write", "update", "delete", "remove", "edit", "move", "rename", "trash", "append",
            ] {
                assert!(
                    !listed.contains(&format!("\"name\":\"{verb}")),
                    "exposes {verb}"
                );
            }
            for name in [
                "write_page",
                "delete_page",
                "update_page",
                "edit_page",
                "move_page",
                "append_to_page",
                "delete_context",
            ] {
                let (text, is_error) = tool(&server, name, json!({}));
                assert!(is_error, "{name} was accepted");
                assert!(text.contains("unknown tool"), "{name}: {text}");
            }
        }
    }

    #[test]
    fn read_mode_hides_the_creates_and_refuses_them_by_name() {
        let (_d, server) = notes();
        for name in ["create_page", "create_context"] {
            let (text, is_error) = tool(&server, name, json!({"title": "x", "name": "x"}));
            assert!(is_error, "{name} was accepted in read mode");

            assert!(text.contains("write access"), "{text}");
            assert!(text.contains("Settings → Agent access"), "{text}");
        }

        let (pages, _) = server.readable();
        assert_eq!(pages.len(), 5);
    }

    #[test]
    fn every_context_is_searched_and_each_hit_says_which() {
        let d = TempDir::new("mcp");
        d.write(
            "Work/Standups.md",
            &page("w", "Standups", 0, "Sprint standup notes.\n"),
        );
        d.write(
            "Personal/Standups.md",
            &page("p", "Standups", 0, "Standup comedy nights.\n"),
        );
        let server = Server::new(d.0.clone());

        let (text, is_error) = tool(&server, "search_pages", json!({"query": "standup"}));
        assert!(!is_error);
        assert!(text.contains("Work / Standups"), "got {text}");
        assert!(text.contains("Personal / Standups"), "got {text}");

        let (page_text, _) = tool(&server, "get_page", json!({"id": "p"}));
        assert!(page_text.contains("Path: Personal\n"), "got {page_text}");
    }

    #[test]
    fn list_contexts_names_each_one_with_how_much_is_in_it() {
        let (_d, server) = notes();
        let (text, is_error) = tool(&server, "list_contexts", json!({}));
        assert!(!is_error);
        assert!(text.contains("Personal  (1 page)"), "got {text}");
        assert!(text.contains("Work  (4 pages)"), "got {text}");
        assert!(text.contains("2 contexts"), "got {text}");

        // Alphabetical, so the list is the same from one call to the next.
        assert!(
            text.find("Personal") < text.find("Work"),
            "not sorted: {text}"
        );
    }

    #[test]
    fn a_context_with_nothing_in_it_yet_is_still_listed() {
        let (d, server) = notes();
        fs::create_dir_all(d.0.join("Archive")).unwrap();

        let (text, _) = tool(&server, "list_contexts", json!({}));
        assert!(text.contains("Archive  (no pages)"), "got {text}");
        assert!(text.contains("3 contexts"), "got {text}");
    }

    #[test]
    fn the_context_a_root_page_reads_as_is_listed_even_though_no_folder_holds_it() {
        let d = TempDir::new("mcp");
        d.write("Loose.md", &page("l", "Loose", 0, "body\n"));
        let server = Server::new(d.0.clone());

        let (text, _) = tool(&server, "list_contexts", json!({}));
        assert!(text.contains("Set  (1 page)"), "got {text}");
        assert!(text.contains("1 context."), "got {text}");
    }

    #[test]
    fn an_empty_notes_folder_has_no_contexts_to_name() {
        let d = TempDir::new("mcp");
        let server = Server::new(d.0.clone());
        let (text, is_error) = tool(&server, "list_contexts", json!({}));
        assert!(!is_error);
        assert!(text.contains("no contexts"), "got {text}");
    }

    #[test]
    fn list_pages_can_be_held_to_one_context() {
        let (_d, server) = notes();
        let (text, is_error) = tool(&server, "list_pages", json!({"context": "Personal"}));
        assert!(!is_error);
        assert!(text.contains("Personal / Groceries"), "got {text}");
        assert!(!text.contains("Work"), "got {text}");
        assert!(
            text.contains("Showing 1-1 of 1 in the \"Personal\" context."),
            "got {text}"
        );
    }

    #[test]
    fn a_narrowed_listing_keeps_its_context_across_the_cursor() {
        let (_d, server) = notes();
        let (first, _) = tool(
            &server,
            "list_pages",
            json!({"context": "Work", "limit": 2}),
        );
        assert!(
            first.contains("Showing 1-2 of 4 in the \"Work\" context."),
            "got {first}"
        );
        assert!(
            first.contains("cursor \"2\" and context \"Work\""),
            "got {first}"
        );

        let (second, is_error) = tool(
            &server,
            "list_pages",
            json!({"context": "Work", "cursor": "2"}),
        );
        assert!(!is_error);
        assert!(second.contains("Meeting Notes"), "got {second}");
        assert!(!second.contains("Groceries"), "got {second}");
    }

    #[test]
    fn search_can_be_held_to_one_context() {
        let d = TempDir::new("mcp");
        d.write(
            "Work/Standups.md",
            &page("w", "Standups", 0, "Sprint standup notes.\n"),
        );
        d.write(
            "Personal/Standups.md",
            &page("p", "Standups", 0, "Standup comedy nights.\n"),
        );
        let server = Server::new(d.0.clone());

        let (text, is_error) = tool(
            &server,
            "search_pages",
            json!({"query": "standup", "context": "Personal"}),
        );
        assert!(!is_error);
        assert!(text.contains("Personal / Standups"), "got {text}");
        assert!(!text.contains("Work"), "the other context leaked: {text}");
    }

    #[test]
    fn a_narrowed_search_says_where_it_looked_when_it_finds_nothing() {
        let (_d, server) = notes();
        let (text, is_error) = tool(
            &server,
            "search_pages",
            json!({"query": "milk", "context": "Work"}),
        );
        assert!(!is_error);
        assert!(
            text.contains("No pages match \"milk\" in the \"Work\" context."),
            "got {text}"
        );
    }

    #[test]
    fn a_context_is_matched_however_it_is_cased() {
        let (_d, server) = notes();
        let (text, is_error) = tool(&server, "list_pages", json!({"context": "personal"}));
        assert!(!is_error);
        assert!(text.contains("Groceries"), "got {text}");

        // …and the reply spells it the way the notes do, not the way it was asked for.
        assert!(text.contains("\"Personal\" context"), "got {text}");
    }

    #[test]
    fn an_unknown_context_is_refused_with_the_ones_that_exist() {
        let (_d, server) = notes();
        for tool_name in ["list_pages", "search_pages"] {
            let (text, is_error) = tool(
                &server,
                tool_name,
                json!({"query": "alpha", "context": "Archive"}),
            );
            assert!(is_error, "{tool_name} accepted a context that isn't there");
            assert!(text.contains("No context named \"Archive\""), "got {text}");
            assert!(text.contains("\"Work\""), "got {text}");
            assert!(text.contains("\"Personal\""), "got {text}");
            assert!(text.contains("list_contexts"), "got {text}");
        }
    }

    #[test]
    fn a_context_left_off_is_every_context() {
        let (_d, server) = notes();
        for asked in [
            json!({}),
            json!({"context": null}),
            json!({"context": "  "}),
        ] {
            let (text, is_error) = tool(&server, "list_pages", asked.clone());
            assert!(!is_error, "got {text}");
            assert!(text.contains("Showing 1-5 of 5."), "{asked}: got {text}");
        }
    }

    #[test]
    fn a_context_that_isnt_a_string_is_refused_rather_than_ignored() {
        let (_d, server) = notes();
        let (text, is_error) = tool(&server, "list_pages", json!({"context": 7}));
        assert!(is_error);
        assert!(text.contains("context must be a string"), "got {text}");
    }

    #[test]
    fn a_scoped_session_names_only_the_contexts_it_was_allowed() {
        let (_d, server) = scoped(&["Personal"]);
        let (text, _) = tool(&server, "list_contexts", json!({}));
        assert!(text.contains("Personal  (1 page)"), "got {text}");
        assert!(
            !text.contains("Work"),
            "a context outside the scope leaked: {text}"
        );

        let (refused, is_error) = tool(&server, "list_pages", json!({"context": "Work"}));
        assert!(is_error);
        assert!(
            refused.contains("No context named \"Work\""),
            "got {refused}"
        );
    }

    #[test]
    fn a_narrowed_call_records_the_context_it_was_given() {
        let (_d, server, log) = journalled();
        tool(&server, "list_contexts", json!({}));
        tool(&server, "list_pages", json!({"context": "Work"}));
        tool(
            &server,
            "search_pages",
            json!({"query": "alpha", "context": "Work"}),
        );

        let entries = log.0.lock().unwrap().clone();
        assert_eq!(entries[0], ("list_contexts".into(), String::new(), 2));
        assert_eq!(entries[1], ("list_pages".into(), "Work".into(), 4));
        assert_eq!(entries[2].0, "search_pages");
        assert_eq!(entries[2].1, "alpha (in Work)");
    }

    #[test]
    fn a_page_at_the_root_reads_as_the_default_context() {
        let d = TempDir::new("mcp");
        d.write("Loose.md", &page("l", "Loose", 0, "old body\n"));
        let server = Server::new(d.0.clone());

        let (text, is_error) = tool(&server, "list_pages", json!({}));
        assert!(!is_error);
        assert!(text.starts_with("Set / Loose"), "got {text}");
    }

    #[test]
    fn list_pages_reads_like_the_sidebar() {
        let (_d, server) = notes();
        let (text, is_error) = tool(&server, "list_pages", json!({}));
        assert!(!is_error);

        let lines: Vec<&str> = text.lines().take(5).collect();
        assert!(
            lines[0].starts_with("Work / Projects "),
            "got {:?}",
            lines[0]
        );
        assert!(lines[1].starts_with("Work / Projects / Project Alpha"));
        assert!(lines[2].starts_with("Work / Projects / Project Beta"));
        assert!(lines[3].starts_with("Work / Meeting Notes"));
        assert!(lines[4].starts_with("Personal / Groceries"));
        assert!(text.contains("[id: a]"));
        assert!(text.contains("Showing 1-5 of 5."));
    }

    #[test]
    fn list_pages_paginates_and_hands_back_a_cursor() {
        let (_d, server) = notes();
        let (first, _) = tool(&server, "list_pages", json!({"limit": 2}));
        assert!(first.contains("Showing 1-2 of 5."));
        assert!(first.contains("cursor \"2\""));

        let (second, _) = tool(&server, "list_pages", json!({"limit": 2, "cursor": "2"}));
        assert!(second.contains("Showing 3-4 of 5."));

        assert!(!second.contains("Project Alpha"));

        let (last, _) = tool(&server, "list_pages", json!({"limit": 2, "cursor": "4"}));
        assert!(last.contains("Showing 5-5 of 5."));
        assert!(!last.contains("cursor"), "offered a cursor past the end");
    }

    #[test]
    fn list_pages_rejects_a_bad_cursor_without_failing_the_call() {
        let (_d, server) = notes();
        let (text, is_error) = tool(&server, "list_pages", json!({"cursor": "banana"}));
        assert!(is_error);
        assert!(text.contains("cursor"));

        let (text, is_error) = tool(&server, "list_pages", json!({"cursor": "999"}));
        assert!(is_error);
        assert!(text.contains("past the end"));
    }

    #[test]
    fn list_pages_caps_an_oversized_limit() {
        let (_d, server) = notes();
        let (text, is_error) = tool(&server, "list_pages", json!({"limit": 100_000}));
        assert!(!is_error, "an oversized limit should clamp, not fail");
        assert!(text.contains("Showing 1-5 of 5."));

        let (_, is_error) = tool(&server, "list_pages", json!({"limit": 0}));
        assert!(is_error, "a zero limit is a mistake worth reporting");
    }

    #[test]
    fn an_empty_notes_folder_says_so() {
        let d = TempDir::new("mcp");
        let server = Server::new(d.0.clone());
        let (text, is_error) = tool(&server, "list_pages", json!({}));
        assert!(!is_error);
        assert!(text.contains("no pages"));
    }

    #[test]
    fn search_ranks_a_title_match_above_body_matches() {
        let (_d, server) = notes();
        let (text, is_error) = tool(&server, "search_pages", json!({"query": "alpha"}));
        assert!(!is_error);
        let first = text.lines().next().unwrap();
        assert!(first.contains("Project Alpha"), "got {first:?}");

        assert!(first.contains("(name matches)"), "got {first:?}");
        assert!(text.contains("The alpha rollout plan."));

        assert!(text.contains("Meeting Notes"));
        assert!(text.contains("Discussed the alpha rollout."));
        let notes_line = text
            .lines()
            .find(|l| l.contains("Meeting Notes"))
            .expect("a line for Meeting Notes");
        assert!(!notes_line.contains("(name matches)"), "got {notes_line:?}");
    }

    #[test]
    fn search_finds_pages_by_body_text_alone() {
        let (_d, server) = notes();
        let (text, _) = tool(&server, "search_pages", json!({"query": "rollout"}));
        assert!(text.contains("Project Alpha"));
        assert!(text.contains("Project Beta"));
        assert!(!text.contains("Groceries"));
    }

    #[test]
    fn search_finds_a_page_through_its_parents_title() {
        let (_d, server) = notes();
        let (text, _) = tool(&server, "search_pages", json!({"query": "projects"}));
        assert!(text.contains("Projects / Project Alpha"));
    }

    #[test]
    fn search_reports_no_matches_as_a_result_not_an_error() {
        let (_d, server) = notes();
        let (text, is_error) = tool(&server, "search_pages", json!({"query": "zzzznothing"}));
        assert!(!is_error, "an empty result set is not a failure");
        assert!(text.contains("No pages match"));
    }

    #[test]
    fn search_requires_a_usable_query() {
        let (_d, server) = notes();
        for args in [json!({}), json!({"query": ""}), json!({"query": "   "})] {
            let (text, is_error) = tool(&server, "search_pages", args);
            assert!(is_error);
            assert!(text.contains("query"));
        }
        let (text, is_error) = tool(&server, "search_pages", json!({"query": "a"}));
        assert!(is_error);
        assert!(text.contains("2 characters"));
    }

    #[test]
    fn search_orders_deterministically() {
        let (_d, server) = notes();
        let (a, _) = tool(&server, "search_pages", json!({"query": "rollout"}));
        let (b, _) = tool(&server, "search_pages", json!({"query": "rollout"}));
        assert_eq!(a, b);
    }

    #[test]
    fn get_page_returns_the_body_and_its_breadcrumb() {
        let (_d, server) = notes();
        let (text, is_error) = tool(&server, "get_page", json!({"id": "a"}));
        assert!(!is_error);
        assert!(text.starts_with("# Project Alpha\n"));
        assert!(text.contains("Path: Work / Projects\n"));
        assert!(text.contains("Id: a\n"));
        assert!(text.contains("The alpha rollout plan."));
        assert!(text.contains("Budget approved."));

        assert!(!text.contains("createdAt"));
        assert!(!text.contains("---"));
    }

    #[test]
    fn get_page_reports_an_unknown_id_to_the_model() {
        let (_d, server) = notes();
        let (text, is_error) = tool(&server, "get_page", json!({"id": "nope"}));
        assert!(is_error);
        assert!(text.contains("No page has id"));

        let (text, is_error) = tool(&server, "get_page", json!({}));
        assert!(is_error);
        assert!(text.contains("requires an `id`"));
    }

    #[test]
    fn get_page_never_reaches_outside_the_notes_folder() {
        let (_d, server) = notes();
        for id in [
            "../../../etc/passwd",
            "/etc/passwd",
            "Projects/Project Alpha.md",
        ] {
            let (text, is_error) = tool(&server, "get_page", json!({"id": id}));
            assert!(is_error, "{id} resolved to something");
            assert!(text.contains("No page has id"));
        }
    }

    #[test]
    fn trashed_pages_are_not_readable() {
        let d = TempDir::new("mcp");
        d.write("Kept.md", &page("k", "Kept", 0, "here\n"));
        d.write("Set-Trash/Deleted.md", &page("z", "Deleted", 0, "secret\n"));
        d.write(
            "Work/Set-Trash/Dropped.md",
            &page("y", "Dropped", 0, "secret\n"),
        );
        let server = Server::new(d.0.clone());

        let (list, _) = tool(&server, "list_pages", json!({}));
        assert!(!list.contains("Deleted"));
        assert!(!list.contains("Dropped"));
        let (search, _) = tool(&server, "search_pages", json!({"query": "secret"}));
        assert!(search.contains("No pages match"));
        for id in ["z", "y"] {
            let (get, is_error) = tool(&server, "get_page", json!({"id": id}));
            assert!(is_error);
            assert!(get.contains("No page has id"));
        }
    }

    #[test]
    fn a_page_edited_between_calls_is_read_fresh() {
        let d = TempDir::new("mcp");
        d.write("Note.md", &page("x", "Note", 0, "before\n"));
        let server = Server::new(d.0.clone());
        let (first, _) = tool(&server, "get_page", json!({"id": "x"}));
        assert!(first.contains("before"));

        d.write("Note.md", &page("x", "Note", 0, "after\n"));
        let (second, _) = tool(&server, "get_page", json!({"id": "x"}));
        assert!(second.contains("after"));
        assert!(!second.contains("before"));
    }

    #[test]
    fn an_unscoped_server_reads_everything() {
        let (_d, server) = notes();
        let (text, _) = tool(&server, "list_pages", json!({}));
        assert!(text.contains("Showing 1-5 of 5."));
    }

    #[test]
    fn scoping_to_a_context_hides_everything_outside_it() {
        let (_d, server) = scoped(&["Work"]);
        let (text, _) = tool(&server, "list_pages", json!({}));
        assert!(text.contains("Projects"));
        assert!(text.contains("Project Alpha"), "subtree not included");
        assert!(text.contains("Project Beta"));
        assert!(text.contains("Meeting Notes"));
        assert!(!text.contains("Groceries"), "out-of-scope page listed");
        assert!(text.contains("Showing 1-4 of 4."));
    }

    #[test]
    fn a_context_is_shared_whole_or_not_at_all() {
        let (_d, server) = scoped(&["Personal"]);
        let (text, _) = tool(&server, "list_pages", json!({}));
        assert!(text.contains("Groceries"));
        assert!(!text.contains("Project"), "{text}");
        assert!(text.contains("Showing 1-1 of 1."));
    }

    #[test]
    fn search_never_returns_an_out_of_scope_page() {
        let (_d, server) = scoped(&["Work"]);

        let (text, _) = tool(&server, "search_pages", json!({"query": "alpha"}));
        assert!(text.contains("Project Alpha"));

        let (text, _) = tool(&server, "search_pages", json!({"query": "milk"}));
        assert!(
            text.contains("No pages match"),
            "leaked an out-of-scope hit: {text}"
        );

        let (_d, server) = scoped(&["Personal"]);
        let (text, _) = tool(&server, "search_pages", json!({"query": "alpha"}));
        assert!(
            text.contains("No pages match"),
            "leaked an out-of-scope hit: {text}"
        );
    }

    #[test]
    fn get_page_refuses_an_out_of_scope_id_and_says_why() {
        let (_d, server) = scoped(&["Work"]);
        let (text, is_error) = tool(&server, "get_page", json!({"id": "g"}));
        assert!(is_error);
        assert!(
            text.contains("in a context outside the ones you've allowed"),
            "got {text:?}"
        );
        assert!(text.contains("Settings"), "no way to act on it: {text:?}");

        let (text, is_error) = tool(&server, "get_page", json!({"id": "no-such-id"}));
        assert!(is_error);
        assert!(text.contains("No page has id"));
    }

    #[test]
    fn an_empty_scope_says_so_rather_than_faking_an_empty_notes_folder() {
        let (_d, server) = scoped(&[]);
        let (list, _) = tool(&server, "list_pages", json!({}));
        assert!(list.contains("no contexts are in scope"), "got {list:?}");
        assert!(!list.contains("has no pages"));
        let (search, _) = tool(&server, "search_pages", json!({"query": "alpha"}));
        assert!(search.contains("no contexts are in scope"));
    }

    #[test]
    fn a_scope_naming_only_a_context_that_is_gone_is_distinguished_too() {
        let (_d, server) = scoped(&["Long Gone"]);
        let (text, _) = tool(&server, "list_pages", json!({}));
        assert!(text.contains("Check the scope"), "got {text:?}");
        assert!(!text.contains("has no pages"), "got {text:?}");
    }

    #[test]
    fn a_created_page_is_immediately_readable_through_the_read_tools() {
        let (_d, server) = writable();
        let (text, is_error) = tool(
            &server,
            "create_page",
            json!({"title": "Retro actions", "text": "Ship the migration first.",
                   "context": "Work"}),
        );
        assert!(!is_error, "{text}");
        assert!(text.contains("Work / Retro actions"), "{text}");
        assert!(text.contains("Work context"), "{text}");

        let id = text
            .split("[id: ")
            .nth(1)
            .and_then(|rest| rest.split(']').next())
            .expect("an id in the reply");
        let (page, is_error) = tool(&server, "get_page", json!({"id": id}));
        assert!(!is_error, "{page}");
        assert!(page.contains("# Retro actions"), "{page}");
        assert!(page.contains("Ship the migration first."), "{page}");

        let (found, _) = tool(&server, "search_pages", json!({"query": "migration"}));
        assert!(found.contains("Retro actions"), "{found}");
    }

    #[test]
    fn a_page_can_be_created_as_a_child_of_one_that_exists() {
        let (_d, server) = writable();
        let (text, is_error) = tool(
            &server,
            "create_page",
            json!({"title": "Gamma", "parent_id": "p"}),
        );
        assert!(!is_error, "{text}");
        assert!(text.contains("Work / Projects / Gamma"), "{text}");

        let (list, _) = tool(&server, "list_pages", json!({}));
        assert!(list.contains("Work / Projects / Gamma"), "{list}");

        // The parent lists it, the way the app's sidebar and page find sub-pages.
        let id = text
            .split("[id: ")
            .nth(1)
            .and_then(|rest| rest.split(']').next())
            .expect("an id in the reply");
        let (parent, _) = tool(&server, "get_page", json!({"id": "p"}));
        assert!(parent.contains("Top level container."), "{parent}");
        assert!(parent.contains(&format!("[Gamma](page:{id})")), "{parent}");
        assert!(!text.contains("couldn't be updated"), "{text}");
    }

    #[test]
    fn a_locked_parent_takes_no_children() {
        let (d, server) = writable();
        d.write(
            "Work/Locked.md",
            "---\nid: \"l\"\ntitle: \"Locked\"\nlocked: true\ncreatedAt: 1\nupdatedAt: 2\n---\n\nKeep.\n",
        );
        let (text, is_error) = tool(
            &server,
            "create_page",
            json!({"title": "Nope", "parent_id": "l"}),
        );
        assert!(is_error, "{text}");
        assert!(text.contains("locked"), "{text}");
        assert!(!d.0.join("Work/Locked").exists());
        assert_eq!(
            std::fs::read_to_string(d.0.join("Work/Locked.md")).unwrap(),
            "---\nid: \"l\"\ntitle: \"Locked\"\nlocked: true\ncreatedAt: 1\nupdatedAt: 2\n---\n\nKeep.\n"
        );
    }

    #[test]
    fn creating_needs_a_title_and_an_id_that_exists() {
        let (_d, server) = writable();
        for args in [
            json!({}),
            json!({"title": "   "}),
            json!({"text": "orphan"}),
        ] {
            let (text, is_error) = tool(&server, "create_page", args.clone());
            assert!(is_error, "{args} was accepted");
            assert!(text.contains("`title`"), "{text}");
        }

        let (text, is_error) = tool(
            &server,
            "create_page",
            json!({"title": "x", "parent_id": "nope"}),
        );
        assert!(is_error);
        assert!(text.contains("No page has id"), "{text}");

        let (text, is_error) = tool(
            &server,
            "create_page",
            json!({"title": "x", "parent_id": "p", "context": "Personal"}),
        );
        assert!(is_error);
        assert!(text.contains("not both"), "{text}");
    }

    #[test]
    fn several_contexts_asks_which_one_rather_than_guessing() {
        let (_d, server) = writable();
        let (text, is_error) = tool(&server, "create_page", json!({"title": "Where?"}));
        assert!(is_error, "{text}");

        assert!(text.contains("\"Work\""), "{text}");
        assert!(text.contains("\"Personal\""), "{text}");

        let (text, is_error) = tool(
            &server,
            "create_page",
            json!({"title": "Where?", "context": "Archive"}),
        );
        assert!(is_error);
        assert!(text.contains("create_context"), "{text}");

        let (text, is_error) = tool(
            &server,
            "create_page",
            json!({"title": "Fine", "context": "personal"}),
        );
        assert!(!is_error, "{text}");
        assert!(text.contains("Personal / Fine"), "{text}");
    }

    #[test]
    fn a_new_context_is_created_once_and_then_refused() {
        let (_d, server) = writable();
        let (text, is_error) = tool(&server, "create_context", json!({"name": "Reading"}));
        assert!(!is_error, "{text}");
        assert!(text.contains("Reading"), "{text}");

        let (text, is_error) = tool(&server, "create_context", json!({"name": "Work"}));
        assert!(is_error);
        assert!(text.contains("already exists"), "{text}");

        let (text, is_error) = tool(
            &server,
            "create_page",
            json!({"title": "Dune", "context": "Reading"}),
        );
        assert!(!is_error, "{text}");
        assert!(text.contains("Reading / Dune"), "{text}");
    }

    #[test]
    fn a_narrowed_scope_confines_writing_the_way_it_confines_reading() {
        let (_d, server) = scoped(&["Work"]);
        let server = server.with_write(true);

        let (text, is_error) = tool(&server, "create_context", json!({"name": "Elsewhere"}));
        assert!(is_error, "{text}");
        assert!(text.contains("scoped"), "{text}");

        let (text, is_error) = tool(
            &server,
            "create_page",
            json!({"title": "Sneaky", "context": "Personal"}),
        );
        assert!(is_error, "{text}");
        assert!(
            text.contains("No context named \"Personal\" is shared"),
            "{text}"
        );

        let (text, is_error) = tool(
            &server,
            "create_page",
            json!({"title": "Sneaky", "parent_id": "g"}),
        );
        assert!(is_error, "{text}");
        assert!(text.contains("in a context outside the ones"), "{text}");

        let (text, is_error) = tool(
            &server,
            "create_page",
            json!({"title": "Allowed", "parent_id": "a"}),
        );
        assert!(!is_error, "{text}");
        assert!(text.contains("Project Alpha / Allowed"), "{text}");
    }

    #[test]
    fn a_shared_context_is_writable_without_naming_a_parent() {
        let (_d, server) = scoped(&["Work"]);
        let server = server.with_write(true);

        // The one shared context is where a page with no `context` lands.
        let (text, is_error) = tool(&server, "create_page", json!({"title": "Standup"}));
        assert!(!is_error, "{text}");
        assert!(text.contains("Work / Standup"), "{text}");

        let (text, is_error) = tool(
            &server,
            "create_page",
            json!({"title": "Retro", "context": "Work"}),
        );
        assert!(!is_error, "{text}");
        assert!(text.contains("Work / Retro"), "{text}");
    }

    #[test]
    fn several_shared_contexts_make_the_context_argument_required() {
        let (_d, server) = scoped(&["Work", "Personal"]);
        let server = server.with_write(true);

        let (text, is_error) = tool(&server, "create_page", json!({"title": "Somewhere"}));
        assert!(is_error, "{text}");
        assert!(text.contains("needs a `context`"), "{text}");
        assert!(text.contains("\"Personal\", \"Work\""), "{text}");
    }

    #[test]
    fn a_scope_that_shares_nothing_has_nowhere_to_write() {
        let (_d, server) = scoped(&[]);
        let server = server.with_write(true);

        let (text, is_error) = tool(&server, "create_page", json!({"title": "Nowhere"}));
        assert!(is_error, "{text}");
        assert!(text.contains("no context is shared"), "{text}");
    }

    #[test]
    fn creating_is_recorded_the_way_reading_is() {
        let (d, server) = notes();
        let recorder = std::sync::Arc::new(Recorder::default());
        let server = server
            .with_write(true)
            .with_journal(Box::new(recorder.clone()));

        tool(
            &server,
            "create_page",
            json!({"title": "Logged", "context": "Work"}),
        );
        tool(&server, "create_context", json!({"name": "Ideas"}));

        tool(&server, "create_context", json!({"name": "Work"}));

        let entries = recorder.0.lock().unwrap().clone();
        assert_eq!(
            entries,
            vec![
                ("create_page".into(), "Work / Logged".into(), 1),
                ("create_context".into(), "Ideas".into(), 1),
            ]
        );
        drop(d);
    }

    #[test]
    fn the_instructions_say_what_the_session_may_do() {
        let handshake = |server: &Server| {
            call(
                server,
                json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}),
            )["result"]["instructions"]
                .as_str()
                .unwrap()
                .to_owned()
        };

        let (_d, reader) = notes();
        let read = handshake(&reader);
        assert!(read.contains("cannot create, edit, or delete"), "{read}");
        assert!(!read.contains("create_page"), "{read}");

        let (_d, writer) = writable();
        let write = handshake(&writer);
        assert!(write.contains("create_page"), "{write}");

        assert!(
            write.contains("listed at the end of that parent"),
            "{write}"
        );
        assert!(
            write.contains("nothing here can change or delete"),
            "{write}"
        );
    }

    #[test]
    fn every_tool_call_is_recorded_with_what_it_returned() {
        let (_d, server, log) = journalled();
        tool(&server, "list_pages", json!({}));
        tool(&server, "search_pages", json!({"query": "alpha"}));
        tool(&server, "get_page", json!({"id": "a"}));

        let entries = log.0.lock().unwrap().clone();
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0], ("list_pages".into(), String::new(), 5));

        assert_eq!(entries[1].0, "search_pages");
        assert_eq!(entries[1].1, "alpha");
        assert!(entries[1].2 >= 1);

        assert_eq!(
            entries[2],
            (
                "get_page".into(),
                "Work / Projects / Project Alpha".into(),
                1
            )
        );
    }

    #[test]
    fn a_search_that_found_nothing_is_still_recorded() {
        let (_d, server, log) = journalled();
        tool(&server, "search_pages", json!({"query": "zzzznothing"}));
        let entries = log.0.lock().unwrap().clone();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].2, 0);
    }

    #[test]
    fn a_refused_out_of_scope_read_is_recorded() {
        let (_d, server) = notes();
        let recorder = std::sync::Arc::new(Recorder::default());
        let server = server
            .with_scope(Some(vec!["Work".into()]))
            .with_journal(Box::new(recorder.clone()));
        tool(&server, "get_page", json!({"id": "g"}));
        let entries = recorder.0.lock().unwrap().clone();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].0, "get_page");
        assert!(entries[0].1.contains("refused"));
        assert_eq!(entries[0].2, 0);
    }

    #[test]
    fn protocol_traffic_is_not_recorded() {
        let (_d, server, log) = journalled();
        call(
            &server,
            json!({"jsonrpc": "2.0", "id": 1, "method": "initialize"}),
        );
        call(
            &server,
            json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}),
        );
        call(
            &server,
            json!({"jsonrpc": "2.0", "id": 3, "method": "ping"}),
        );
        assert!(log.0.lock().unwrap().is_empty());
    }

    #[test]
    fn a_server_with_no_journal_still_works() {
        let (_d, server) = notes();
        let (_, is_error) = tool(&server, "list_pages", json!({}));
        assert!(!is_error);
    }

    #[test]
    fn a_parent_cycle_terminates() {
        let d = TempDir::new("mcp");
        d.write("A.md", &page("a", "A", 0, "one\n"));
        d.write("A/B.md", &page("b", "B", 0, "two\n"));
        d.write("A/B/A.md", &page("a", "A again", 0, "three\n"));
        let server = Server::new(d.0.clone());
        let (text, is_error) = tool(&server, "list_pages", json!({}));
        assert!(!is_error);
        assert!(text.contains("Showing"));
    }
}
