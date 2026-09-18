use serde_json::{json, Value};

use super::{MAX_PAGE_LIMIT, MAX_SEARCH_LIMIT};

pub fn list(writable: bool) -> Value {
    let mut tools = read_tools();
    if writable {
        if let (Some(tools), Some(mut writes)) =
            (tools.as_array_mut(), write_tools().as_array().cloned())
        {
            tools.append(&mut writes);
        }
    }
    json!({ "tools": tools })
}

fn read_tools() -> Value {
    json!([
        {
            "name": "search_pages",
            "description": "Search the user's notes by title and body text, best match first. \
    Use this first whenever you need something from the notes and don't already have a page id; \
    it is the fastest way in. Matches anywhere in a word, so partial words work. Multiple words \
    are required together (AND). Returns page ids to pass to get_page, with the matching line under \
    each body hit.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Words to look for. At least 2 characters.",
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Maximum pages to return (default 20, maximum 50).",
                        "minimum": 1,
                        "maximum": MAX_SEARCH_LIMIT,
                    },
                    "context": {
                        "type": "string",
                        "description": "Search only inside this top-level context, as \
    list_contexts spells it. Omit to search every context at once, which is usually what you \
    want. Narrow only when the same words could mean different things in different parts of \
    the notes.",
                    },
                },
                "required": ["query"],
            },
        },
        {
            "name": "list_contexts",
            "description": "List the user's top-level contexts: the groupings (\"Work\", \
    \"Personal\", …) they switch between in the app, each holding its own tree of pages. Start \
    here when the request is about one area of the notes: take a name from this list and pass it \
    as `context` to search_pages or list_pages to stay inside it. It is also how a context is \
    spelled for create_page. Shows how many pages each one holds.",
            "inputSchema": {
                "type": "object",
                "properties": {},
            },
        },
        {
            "name": "list_pages",
            "description": "List every page in the notes, across every context, in the order \
    the app's sidebar shows them, with each page's path, which begins with the context it is in. Use this to browse the structure of the notes or when the \
    user refers to their notes as a whole; prefer search_pages when looking for a specific topic. \
    Paginated: pass the cursor from a previous call to continue.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "cursor": {
                        "type": "string",
                        "description": "Opaque cursor from a previous list_pages result. Omit to \
    start from the first page.",
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Maximum pages per call (default 50, maximum 200).",
                        "minimum": 1,
                        "maximum": MAX_PAGE_LIMIT,
                    },
                    "context": {
                        "type": "string",
                        "description": "List only the pages in this top-level context, as \
    list_contexts spells it. Omit to list every context. A cursor belongs to the call that \
    issued it, so keep the same context when continuing one.",
                    },
                },
            },
        },
        {
            "name": "get_page",
            "description": "Read one page's full Markdown, given its id. Use after search_pages \
    or list_pages has given you an id. A search snippet is one line, and this is how you read the \
    rest of the page.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": {
                        "type": "string",
                        "description": "Page id, as returned by search_pages or list_pages.",
                    },
                },
                "required": ["id"],
            },
        },
    ])
}

fn write_tools() -> Value {
    json!([
        {
            "name": "create_page",
            "description": "Create a new page in the user's notes. Use this when the user asks \
    you to write something down, save a note, or remember something for later. Adds only: it \
    cannot change or delete a page that already exists, so search_pages first when the note \
    might belong on a page that is already there. A second page on the same subject is the only \
    other outcome available. Give it a specific title; that is how it will be found again. \
    Returns the new page's id and path.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "title": {
                        "type": "string",
                        "description": "The page's title, and the name it will be found by. \
    Specific beats generic: \"Q3 budget decisions\", not \"Notes\".",
                    },
                    "text": {
                        "type": "string",
                        "description": "The page's content, as Markdown. Headings, lists, links, \
    tables and code blocks all work. Optional; a page can start empty.",
                    },
                    "parent_id": {
                        "type": "string",
                        "description": "Nest the new page under this existing page, as its \
    child. Take the id from search_pages or list_pages. Omit to put the page at the top of a \
    context.",
                    },
                    "context": {
                        "type": "string",
                        "description": "Which top-level context to put it in (\"Work\", \
    \"Personal\", …), as list_contexts spells it. Omit when passing parent_id, since a child is always \
    in its parent's context. If there is exactly one context, this can be omitted too.",
                    },
                },
                "required": ["title"],
            },
        },
        {
            "name": "create_context",
            "description": "Create a new top-level context, one of the groupings (\"Work\", \
    \"Personal\", …) the user switches between in the app, holding its own tree of pages. Reach \
    for this only for a genuinely new area of someone's notes, and never as a place to put one \
    page: a context is a decision about how the notes are organized, and pages belong inside the \
    ones that already exist. An existing name is refused rather than duplicated.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "The context's name, which is also its folder name in \
    the notes.",
                    },
                },
                "required": ["name"],
            },
        },
    ])
}
