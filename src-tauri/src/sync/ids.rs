//! Same repair as `adoptScan` in fs-store.ts, done under the write gate before a round scans, so a
//! manifest never holds a duplicate id. Both must produce identical bytes.

use std::collections::HashSet;
use std::path::Path;

use super::manifest;
use crate::page_id;

/// The note at `path` carries `from`, which an earlier note already has.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reissue {
    pub path: String,
    pub from: String,
    pub to: String,
}

/// Pure. In the order the app would find them.
pub fn plan(notes: &[(String, String)]) -> Vec<Reissue> {
    let mut out = Vec::new();
    let mut taken: HashSet<String> = HashSet::new();

    let mut notes: Vec<&(String, String)> = notes.iter().collect();
    // `byteOrder` in fs-store.ts compares UTF-16 code units, which differs from UTF-8 above U+FFFF.
    notes.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));

    for (path, id) in notes {
        if taken.insert(id.clone()) {
            continue;
        }
        let mut fresh = page_id::derive(&format!("{id}/{path}"));
        while taken.contains(&fresh) {
            fresh = page_id::derive(&fresh);
        }
        taken.insert(fresh.clone());
        out.push(Reissue {
            path: path.clone(),
            from: id.clone(),
            to: fresh,
        });
    }
    out
}

/// Every note outside a trash and an image folder.
pub fn notes_with_ids(root: &Path) -> Vec<(String, String)> {
    manifest::build(root)
        .files
        .into_iter()
        .filter(|(path, _)| manifest::is_note(path))
        .filter_map(|(path, entry)| Some((path, entry.page_id?)))
        .collect()
}

/// Caller holds the write gate. Anything that moved in the meantime waits for the next round.
/// Returns the paths rewritten so the watcher can ignore them.
pub fn repair(root: &Path) -> Vec<String> {
    let mut written = Vec::new();
    for reissue in plan(&notes_with_ids(root)) {
        let Ok(path) = super::apply::resolve(root, &reissue.path) else {
            continue;
        };
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        if crate::scan::page_identity(&text).0.as_deref() != Some(reissue.from.as_str()) {
            continue;
        }
        let Some(fixed) = super::merge::replace_field(&text, "id", &reissue.to) else {
            continue;
        };
        if crate::write::write_atomically(&path, fixed.as_bytes()).is_ok() {
            written.push(reissue.path);
        }
    }
    written
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::TempDir;

    fn page(id: &str, title: &str) -> String {
        format!("---\nid: \"{id}\"\ntitle: \"{title}\"\nparentId: null\ncreatedAt: 1\nupdatedAt: 2\n---\n\nbody\n")
    }

    #[test]
    fn the_first_copy_keeps_the_id_and_later_ones_are_reissued_in_order() {
        let live = vec![
            ("Set/B.md".to_string(), "x".to_string()),
            ("Set/A.md".to_string(), "x".to_string()),
            ("Set/C.md".to_string(), "y".to_string()),
        ];
        let plan = plan(&live);
        assert_eq!(
            plan,
            vec![Reissue {
                path: "Set/B.md".to_string(),
                from: "x".to_string(),
                to: page_id::derive("x/Set/B.md"),
            }]
        );
    }

    #[test]
    fn a_conflict_copy_sorts_before_its_page_and_so_would_keep_the_id() {
        // Left to this repair, the page, not the conflict copy, would lose its id.
        let live = vec![
            ("Set/Poems.md".to_string(), "p".to_string()),
            (
                "Set/Poems (conflict from Mac).md".to_string(),
                "p".to_string(),
            ),
        ];
        assert_eq!(plan(&live)[0].path, "Set/Poems.md");
    }

    #[test]
    fn a_derived_id_that_is_already_taken_is_derived_again() {
        let taken = page_id::derive("x/Set/B.md");
        let live = vec![
            ("Set/A.md".to_string(), "x".to_string()),
            ("Set/Aa.md".to_string(), taken.clone()),
            ("Set/B.md".to_string(), "x".to_string()),
        ];
        let plan = plan(&live);
        assert_eq!(plan[0].to, page_id::derive(&taken));
    }

    #[test]
    fn repairing_a_folder_leaves_every_id_unique_and_is_idempotent() {
        let d = TempDir::new("ids-repair");
        d.write("Set/A.md", &page("x", "A"));
        d.write("Set/Copy of A.md", &page("x", "A"));
        d.write("Set/Set-Trash/A.md", &page("x", "A"));
        d.write("Set/A/Set-page-assets/x.md", &page("x", "Not a page"));

        assert_eq!(repair(&d.0), vec!["Set/Copy of A.md".to_string()]);

        let notes = notes_with_ids(&d.0);
        let ids: HashSet<&String> = notes.iter().map(|(_, id)| id).collect();
        assert_eq!(ids.len(), notes.len(), "{notes:?}");
        for untouched in ["Set/Set-Trash/A.md", "Set/A/Set-page-assets/x.md"] {
            assert_eq!(
                d.read(untouched).unwrap(),
                page(
                    "x",
                    if untouched.contains("assets") {
                        "Not a page"
                    } else {
                        "A"
                    }
                ),
                "the trash is the app's, and markdown in an image folder isn't a page"
            );
        }

        assert!(repair(&d.0).is_empty(), "a second pass has nothing to do");
    }
}
