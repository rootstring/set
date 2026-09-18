pub const ASSETS_DIR: &str = "Set-page-assets";

pub const TRASH_DIR: &str = "Set-Trash";

pub const DEFAULT_CONTEXT: &str = "Set";

/// Reserved at every level: each context has its own trash, any page can hold assets.
pub fn is_reserved(base: &str) -> bool {
    let lower = base.to_lowercase();
    lower == ASSETS_DIR.to_lowercase() || lower == TRASH_DIR.to_lowercase()
}

pub fn trash_of(context: &str) -> String {
    join_rel(context, TRASH_DIR)
}

pub fn context_of(rel_path: &str) -> &str {
    match rel_path.split_once('/') {
        Some((context, _)) => context,
        None => DEFAULT_CONTEXT,
    }
}

pub fn sanitize_title(title: &str) -> String {
    let replaced: String = title
        .trim()
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | ' ' | '-' => '-',
            other => other,
        })
        .collect();

    let collapsed = collapse_whitespace(&replaced);
    let cleaned = truncate_chars(collapsed.trim_end_matches('.'), 120);
    let cleaned = cleaned.trim();
    if cleaned.is_empty() {
        "Untitled".to_string()
    } else {
        cleaned.to_string()
    }
}

pub fn sanitize_context_name(name: &str) -> Option<String> {
    let replaced: String = name
        .trim()
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '-',
            other => other,
        })
        .collect();
    let collapsed = collapse_whitespace(&replaced);
    let undotted = collapsed.trim_matches('.');
    let cleaned = truncate_chars(undotted, 60);
    let cleaned = cleaned.trim();

    if !cleaned.chars().any(|c| c.is_alphabetic() || c.is_numeric()) {
        return None;
    }
    if is_reserved(cleaned) {
        return None;
    }
    Some(cleaned.to_string())
}

pub fn strip_md(rel: &str) -> &str {
    // `get`, not an index: three bytes from the end can be half of a letter.
    match rel.len().checked_sub(3).and_then(|at| rel.get(at..)) {
        Some(ext) if ext.eq_ignore_ascii_case(".md") => &rel[..rel.len() - 3],
        _ => rel,
    }
}

pub fn join_rel(dir: &str, name: &str) -> String {
    if dir.is_empty() {
        name.to_string()
    } else {
        format!("{dir}/{name}")
    }
}

fn collapse_whitespace(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_space = false;
    for c in text.chars() {
        if c.is_whitespace() {
            in_space = true;
            continue;
        }
        if in_space && !out.is_empty() {
            out.push(' ');
        }
        in_space = false;
        out.push(c);
    }
    if in_space && !out.is_empty() {
        out.push(' ');
    }
    out
}

fn truncate_chars(text: &str, max: usize) -> &str {
    match text.char_indices().nth(max) {
        Some((end, _)) => &text[..end],
        None => text,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_title_becomes_the_filename_the_app_would_have_chosen() {
        assert_eq!(sanitize_title("Project Alpha"), "Project-Alpha");
        assert_eq!(
            sanitize_title("a/b\\c:d*e?f\"g<h>i|j"),
            "a-b-c-d-e-f-g-h-i-j"
        );
        assert_eq!(sanitize_title("  padded  "), "padded");

        assert_eq!(sanitize_title("Notes..."), "Notes");
        assert_eq!(sanitize_title("...Notes..."), "...Notes");
        assert_eq!(
            sanitize_context_name("...Notes...").as_deref(),
            Some("Notes")
        );

        assert_eq!(sanitize_title(""), "Untitled");
        assert_eq!(sanitize_title("   "), "Untitled");
        assert_eq!(sanitize_title("日本語"), "日本語");
    }

    #[test]
    fn stripping_the_extension_copes_with_names_that_dont_end_in_ascii() {
        assert_eq!(strip_md("Set/Café.md"), "Set/Café");
        assert_eq!(strip_md("Set/Café.MD"), "Set/Café");
        assert_eq!(strip_md("Set/Café 2"), "Set/Café 2");
        assert_eq!(strip_md("Caf\u{e9}"), "Café");
        assert_eq!(strip_md("md"), "md");
    }

    #[test]
    fn a_context_name_keeps_its_spaces() {
        assert_eq!(sanitize_context_name("My Work").as_deref(), Some("My Work"));
        assert_eq!(
            sanitize_context_name("Work/Home").as_deref(),
            Some("Work-Home")
        );
        assert_eq!(sanitize_context_name(".hidden.").as_deref(), Some("hidden"));
        assert_eq!(sanitize_context_name("日本語").as_deref(), Some("日本語"));
    }

    #[test]
    fn a_context_with_nothing_in_it_is_refused_rather_than_invented() {
        for name in ["", "   ", "///", "..."] {
            assert_eq!(sanitize_context_name(name), None, "{name:?}");
        }
    }

    #[test]
    fn the_layouts_own_names_are_never_handed_out_at_any_level() {
        assert_eq!(sanitize_context_name("Set-Trash"), None);
        assert_eq!(sanitize_context_name("set-trash"), None);
        assert_eq!(sanitize_context_name("Set-page-assets"), None);

        assert_eq!(sanitize_context_name("Set").as_deref(), Some("Set"));

        assert!(is_reserved("Set-Trash"));
        assert!(is_reserved("set-trash"));
        assert!(is_reserved("Set-page-assets"));
        assert!(is_reserved("SET-PAGE-ASSETS"));

        assert!(!is_reserved("Set"));
        assert_eq!(trash_of("Work"), "Work/Set-Trash");
    }

    #[test]
    fn a_page_is_in_the_first_segment_of_its_path() {
        assert_eq!(context_of("Work/Q3 Planning.md"), "Work");
        assert_eq!(context_of("Work/Q3 Planning/Budget.md"), "Work");

        assert_eq!(context_of("Loose.md"), DEFAULT_CONTEXT);
    }

    #[test]
    fn stripping_md_is_case_insensitive_and_leaves_anything_else_alone() {
        assert_eq!(strip_md("Work/Page.md"), "Work/Page");
        assert_eq!(strip_md("Work/Page.MD"), "Work/Page");
        assert_eq!(strip_md("Work/Page"), "Work/Page");
        assert_eq!(strip_md("md"), "md");
    }
}
