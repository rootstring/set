use std::fs;
use std::path::Path;

use serde_json::json;

use crate::paths::{
    is_reserved, join_rel, sanitize_context_name, sanitize_title, ASSETS_DIR, TRASH_DIR,
};

const MAX_NAME_ATTEMPTS: usize = 1000;

pub struct Created {
    pub id: String,

    pub rel_path: String,
}

pub fn create_page(
    root: &Path,
    folder: &str,
    title: &str,
    body: &str,
    parent_id: Option<&str>,
) -> Result<Created, String> {
    let dir = root.join(folder);
    fs::create_dir_all(&dir).map_err(|e| format!("creating {}: {e}", dir.display()))?;

    let rel_path = allocate(root, folder, title)?;
    let id = crate::page_id::random();
    let abs = crate::root::contain(root, &root.join(&rel_path).to_string_lossy())?;

    let now = crate::clock::now_ms();
    let contents = compose_file(&id, title, parent_id, now, body);
    crate::write::write_atomically(&abs, contents.as_bytes())?;
    Ok(Created { id, rel_path })
}

/// Adds `[title](page:id)` to the end of the parent's body, the block the app appends when a
/// sub-page is made in it. The sidebar and the page both list sub-pages from these links, so a
/// child without one is on disk but nowhere to be seen. Bumps `updatedAt` as a save would, so
/// sync and the folder watch treat it as an edit.
pub fn link_child(
    root: &Path,
    parent_rel: &str,
    child_id: &str,
    child_title: &str,
) -> Result<(), String> {
    let abs = crate::root::contain(root, &root.join(parent_rel).to_string_lossy())?;
    let text = fs::read_to_string(&abs).map_err(|e| format!("reading {parent_rel}: {e}"))?;
    let linked = append_link(&text, child_id, child_title, crate::clock::now_ms());
    crate::write::write_atomically(&abs, linked.as_bytes())
}

fn append_link(text: &str, child_id: &str, child_title: &str, now: u64) -> String {
    let text = text.replace("\r\n", "\n");
    let link = format!("[{}](page:{child_id})", escape_link_text(child_title));

    let (front, body) = split_frontmatter(&text);
    let body = body.trim_end_matches('\n');
    let body = if body.is_empty() {
        link
    } else {
        format!("{body}\n\n{link}")
    };
    match front {
        Some(front) => format!("---\n{}\n---\n\n{body}\n", touch(front, now)),
        None => format!("{body}\n"),
    }
}

/// The frontmatter block (without its fences) and the body, or no block and the whole text.
fn split_frontmatter(text: &str) -> (Option<&str>, &str) {
    let Some(rest) = text.strip_prefix("---\n") else {
        return (None, text);
    };
    let Some(end) = rest.find("\n---") else {
        return (None, text);
    };
    let block = &rest[..end];
    let after = &rest[end + 4..];
    let after = after.strip_prefix('\n').unwrap_or(after);
    let body = after.strip_prefix('\n').unwrap_or(after);
    (Some(block), body)
}

/// The block with `updatedAt` set to `now`, added if the block had none.
fn touch(front: &str, now: u64) -> String {
    let mut lines: Vec<String> = front
        .split('\n')
        .map(|line| {
            let is_updated_at = line
                .split_once(':')
                .is_some_and(|(key, _)| key.trim() == "updatedAt");
            if is_updated_at {
                format!("updatedAt: {now}")
            } else {
                line.to_owned()
            }
        })
        .collect();
    if !lines.iter().any(|line| line.starts_with("updatedAt:")) {
        lines.push(format!("updatedAt: {now}"));
    }
    lines.join("\n")
}

/// Brackets and backslashes would end or escape the link's text.
fn escape_link_text(title: &str) -> String {
    let mut out = String::with_capacity(title.len());
    for c in title.chars() {
        if matches!(c, '\\' | '[' | ']') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

pub fn create_context(root: &Path, name: &str) -> Result<String, String> {
    let wanted = sanitize_context_name(name).ok_or_else(|| {
        format!("{name:?} can't be a context name. Use letters or digits; the names Set-Trash and Set-page-assets belong to the layout.")
    })?;
    let dir = root.join(&wanted);
    if dir.exists() || root.join(format!("{wanted}.md")).exists() {
        return Err(format!(
            "A context named {wanted:?} already exists. Create pages in it with create_page instead."
        ));
    }
    fs::create_dir_all(&dir).map_err(|e| format!("creating {}: {e}", dir.display()))?;
    Ok(wanted)
}

pub fn contexts(root: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    let mut dirs: Vec<String> = Vec::new();
    let mut claimed: Vec<String> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        match entry.file_type() {
            Ok(ft) if ft.is_dir() => dirs.push(name),
            Ok(ft) if ft.is_file() && name.to_lowercase().ends_with(".md") => {
                claimed.push(crate::paths::strip_md(&name).to_owned());
            }
            _ => {}
        }
    }
    dirs.retain(|name| {
        name != TRASH_DIR && name != ASSETS_DIR && !claimed.iter().any(|base| base == name)
    });
    dirs.sort();
    dirs
}

pub fn resolve_context(root: &Path, name: &str) -> Option<String> {
    let wanted = name.trim();
    let existing = contexts(root);
    existing
        .iter()
        .find(|c| c.as_str() == wanted)
        .or_else(|| existing.iter().find(|c| c.eq_ignore_ascii_case(wanted)))
        .cloned()
}

fn allocate(root: &Path, folder: &str, title: &str) -> Result<String, String> {
    let desired = sanitize_title(title);
    for i in 1..=MAX_NAME_ATTEMPTS {
        let base = if i == 1 {
            desired.clone()
        } else {
            format!("{desired} {i}")
        };
        if is_reserved(&base) {
            continue;
        }
        let rel = join_rel(folder, &format!("{base}.md"));
        if root.join(&rel).exists() || root.join(join_rel(folder, &base)).exists() {
            continue;
        }
        return Ok(rel);
    }
    Err(format!(
        "couldn't find a free filename for {desired:?} after {MAX_NAME_ATTEMPTS} tries."
    ))
}

fn compose_file(id: &str, title: &str, parent_id: Option<&str>, now: u64, body: &str) -> String {
    let lines = [
        format!("id: {}", json!(id)),
        format!("title: {}", json!(title)),
        format!("parentId: {}", json!(parent_id)),
        format!("createdAt: {now}"),
        format!("updatedAt: {now}"),
    ];

    let body = body.trim_end_matches('\n');
    format!("---\n{}\n---\n\n{body}\n", lines.join("\n"))
}

pub fn child_folder_of(rel_path: &str) -> &str {
    crate::paths::strip_md(rel_path)
}

pub fn context_folder(root: &Path, asked: Option<&str>) -> Result<String, String> {
    let existing = contexts(root);
    if let Some(name) = asked {
        return resolve_context(root, name).ok_or_else(|| {
            format!(
                "No context named {name:?}. These notes have: {}. Create one with create_context, \
or pass one of these.",
                name_list(&existing)
            )
        });
    }
    match existing.len() {
        0 => Ok(crate::paths::DEFAULT_CONTEXT.to_string()),
        1 => Ok(existing[0].clone()),

        _ => Err(format!(
            "These notes have more than one context, so `context` is required: {}. \
(Or pass `parent_id` to nest the page under an existing one.)",
            name_list(&existing)
        )),
    }
}

pub fn name_list(names: &[String]) -> String {
    if names.is_empty() {
        return "(none)".to_string();
    }
    names
        .iter()
        .map(|n| format!("{n:?}"))
        .collect::<Vec<_>>()
        .join(", ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::TempDir;

    fn notes() -> TempDir {
        let d = TempDir::new("mcp-write");
        fs::create_dir_all(d.0.join("Work")).unwrap();
        fs::write(
            d.0.join("Work/Projects.md"),
            "---\nid: \"p\"\ntitle: \"Projects\"\n---\n\nBody.\n",
        )
        .unwrap();
        d
    }

    fn read(root: &Path, rel: &str) -> String {
        fs::read_to_string(root.join(rel)).unwrap()
    }

    #[test]
    fn a_created_page_is_a_file_the_scan_reads_back() {
        let d = notes();
        let made = create_page(
            &d.0,
            "Work",
            "Meeting Notes",
            "Discussed the rollout.",
            None,
        )
        .expect("a page");
        assert_eq!(made.rel_path, "Work/Meeting-Notes.md");

        let (entries, bodies) = crate::scan::scan_tree(&d.0.to_string_lossy());
        let entry = entries.iter().find(|e| e.id == made.id).expect("scanned");
        assert_eq!(entry.title, "Meeting Notes");
        assert_eq!(entry.parent_id, None);
        assert_eq!(bodies[&made.id], "Discussed the rollout.\n");

        assert!(entry.order.is_none());
        assert!(!entry.locked);
    }

    #[test]
    fn the_frontmatter_is_the_block_the_app_composes() {
        let d = notes();
        let made = create_page(&d.0, "Work", "Quoted \"Title\"", "Body", Some("p")).unwrap();
        let text = read(&d.0, &made.rel_path);

        assert!(text.starts_with("---\nid: \""), "{text}");
        assert!(text.contains("title: \"Quoted \\\"Title\\\"\"\n"), "{text}");
        assert!(text.contains("parentId: \"p\"\n"), "{text}");
        assert!(text.contains("\ncreatedAt: "), "{text}");
        assert!(text.contains("\nupdatedAt: "), "{text}");

        assert!(!text.contains("order:"), "{text}");
        assert!(!text.contains("locked:"), "{text}");
        assert!(text.ends_with("Body\n"), "{text}");
    }

    #[test]
    fn a_page_with_no_parent_says_so_rather_than_omitting_the_key() {
        let d = notes();
        let made = create_page(&d.0, "Work", "Loose", "", None).unwrap();
        assert!(read(&d.0, &made.rel_path).contains("parentId: null\n"));
    }

    #[test]
    fn the_body_ends_with_exactly_one_newline_however_it_arrived() {
        let d = notes();
        for body in ["Text", "Text\n", "Text\n\n\n"] {
            let made = create_page(&d.0, "Work", "Trailing", body, None).unwrap();
            assert!(read(&d.0, &made.rel_path).ends_with("Text\n"), "{body:?}");
        }
    }

    #[test]
    fn two_pages_with_one_title_get_two_files() {
        let d = notes();
        let first = create_page(&d.0, "Work", "Notes", "a", None).unwrap();
        let second = create_page(&d.0, "Work", "Notes", "b", None).unwrap();
        assert_eq!(first.rel_path, "Work/Notes.md");
        assert_eq!(second.rel_path, "Work/Notes 2.md");
        assert_ne!(first.id, second.id);
    }

    #[test]
    fn a_name_whose_children_folder_is_taken_moves_along() {
        let d = notes();

        fs::create_dir_all(d.0.join("Work/Projects")).unwrap();
        let made = create_page(&d.0, "Work", "Projects", "", None).unwrap();
        assert_eq!(made.rel_path, "Work/Projects 2.md");
    }

    #[test]
    fn the_layouts_own_names_are_never_allocated() {
        let d = TempDir::new("mcp-write");

        let made = create_page(&d.0, "", "Set-Trash", "", None).unwrap();
        assert_eq!(made.rel_path, "Set-Trash 2.md");
        let assets = create_page(&d.0, "", "Set-page-assets", "", None).unwrap();
        assert_eq!(assets.rel_path, "Set-page-assets 2.md");
    }

    #[test]
    fn a_child_lands_in_its_parents_folder() {
        let d = notes();
        let made = create_page(
            &d.0,
            child_folder_of("Work/Projects.md"),
            "Alpha",
            "",
            Some("p"),
        )
        .unwrap();
        assert_eq!(made.rel_path, "Work/Projects/Alpha.md");

        let (entries, _) = crate::scan::scan_tree(&d.0.to_string_lossy());
        let entry = entries.iter().find(|e| e.id == made.id).unwrap();
        assert_eq!(entry.parent_id.as_deref(), Some("p"));
    }

    #[test]
    fn a_child_is_linked_from_the_end_of_its_parent() {
        let d = notes();
        let made = create_page(&d.0, "Work/Projects", "Alpha", "", Some("p")).unwrap();
        link_child(&d.0, "Work/Projects.md", &made.id, "Alpha").unwrap();

        let parent = read(&d.0, "Work/Projects.md");
        assert!(
            parent.ends_with(&format!("\n\nBody.\n\n[Alpha](page:{})\n", made.id)),
            "{parent}"
        );
        assert!(
            parent.starts_with("---\nid: \"p\"\ntitle: \"Projects\"\n"),
            "{parent}"
        );
        assert!(parent.contains("\nupdatedAt: "), "{parent}");

        let (entries, bodies) = crate::scan::scan_tree(&d.0.to_string_lossy());
        let child = entries.iter().find(|e| e.id == made.id).unwrap();
        assert_eq!(child.parent_id.as_deref(), Some("p"));
        assert!(bodies["p"].contains(&format!("](page:{})", made.id)));
    }

    #[test]
    fn linking_touches_updated_at_and_leaves_the_rest_of_the_frontmatter_alone() {
        let text = "---\nid: \"p\"\ntitle: \"P\"\norder: 2\nlocked: false\ncreatedAt: 1\nupdatedAt: 2\n---\n\nBody.\n";
        let out = append_link(text, "c", "Child", 99);
        assert_eq!(
            out,
            "---\nid: \"p\"\ntitle: \"P\"\norder: 2\nlocked: false\ncreatedAt: 1\nupdatedAt: 99\n---\n\nBody.\n\n[Child](page:c)\n"
        );

        let without = "---\nid: \"p\"\n---\n\nBody.\n";
        assert_eq!(
            append_link(without, "c", "Child", 99),
            "---\nid: \"p\"\nupdatedAt: 99\n---\n\nBody.\n\n[Child](page:c)\n"
        );
    }

    #[test]
    fn an_empty_parent_gets_just_the_link_and_a_bare_file_is_still_a_file() {
        assert_eq!(
            append_link("---\nid: \"p\"\nupdatedAt: 2\n---\n", "c", "Child", 9),
            "---\nid: \"p\"\nupdatedAt: 9\n---\n\n[Child](page:c)\n"
        );
        assert_eq!(
            append_link("---\nid: \"p\"\nupdatedAt: 2\n---\n\n\n\n", "c", "Child", 9),
            "---\nid: \"p\"\nupdatedAt: 9\n---\n\n[Child](page:c)\n"
        );
        assert_eq!(
            append_link("no frontmatter here\r\n", "c", "Child", 9),
            "no frontmatter here\n\n[Child](page:c)\n"
        );
        assert_eq!(append_link("", "c", "Child", 9), "[Child](page:c)\n");
    }

    #[test]
    fn a_title_that_could_end_the_link_is_escaped() {
        let out = append_link("Body.\n", "c", "A [b] \\ c", 9);
        assert!(out.ends_with("[A \\[b\\] \\\\ c](page:c)\n"), "{out}");
    }

    #[test]
    fn contexts_are_the_root_folders_the_layout_doesnt_own() {
        let d = notes();
        fs::create_dir_all(d.0.join("Personal")).unwrap();
        fs::create_dir_all(d.0.join(TRASH_DIR)).unwrap();
        fs::create_dir_all(d.0.join(ASSETS_DIR)).unwrap();

        fs::write(d.0.join("Loose.md"), "---\nid: \"l\"\n---\n\nx\n").unwrap();
        fs::create_dir_all(d.0.join("Loose")).unwrap();
        assert_eq!(contexts(&d.0), vec!["Personal", "Work"]);
    }

    #[test]
    fn a_new_context_is_a_folder_and_a_repeat_is_refused() {
        let d = notes();
        assert_eq!(create_context(&d.0, "Personal").unwrap(), "Personal");
        assert!(d.0.join("Personal").is_dir());

        let again = create_context(&d.0, "Work").unwrap_err();
        assert!(again.contains("already exists"), "{again}");
        assert!(again.contains("create_page"), "{again}");

        for name in ["Set-Trash", "   ", "///"] {
            assert!(create_context(&d.0, name).is_err(), "{name:?}");
        }
    }

    #[test]
    fn a_context_is_resolved_by_name_however_it_was_typed() {
        let d = notes();
        assert_eq!(resolve_context(&d.0, "Work").as_deref(), Some("Work"));
        assert_eq!(resolve_context(&d.0, "work").as_deref(), Some("Work"));
        assert_eq!(resolve_context(&d.0, " Work ").as_deref(), Some("Work"));
        assert_eq!(resolve_context(&d.0, "Nope"), None);
    }

    #[test]
    fn one_context_needs_no_argument_and_more_than_one_does() {
        let d = notes();
        assert_eq!(context_folder(&d.0, None).unwrap(), "Work");

        fs::create_dir_all(d.0.join("Personal")).unwrap();
        let ambiguous = context_folder(&d.0, None).unwrap_err();
        assert!(ambiguous.contains("more than one context"), "{ambiguous}");

        assert!(ambiguous.contains("\"Work\""), "{ambiguous}");
        assert!(ambiguous.contains("\"Personal\""), "{ambiguous}");

        let missing = context_folder(&d.0, Some("Archive")).unwrap_err();
        assert!(missing.contains("create_context"), "{missing}");

        let empty = TempDir::new("mcp-write");
        assert_eq!(context_folder(&empty.0, None).unwrap(), "Set");
    }
}
