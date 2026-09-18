use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use serde::{Deserialize, Serialize};
use unicode_normalization::UnicodeNormalization;

/// Changes on every save, so never decides whether a note changed.
const UPDATED_AT: &str = "updatedAt";

pub use crate::paths::{ASSETS_DIR, TRASH_DIR};
use crate::write::TMP_SUFFIX;

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct Hash(pub [u8; 32]);

impl Hash {
    pub fn of(bytes: &[u8]) -> Self {
        Hash(*blake3::hash(bytes).as_bytes())
    }

    /// The name this content goes by on disk (the ancestor store, the spool).
    pub fn to_hex(self) -> String {
        crate::hex::encode(&self.0)
    }
}

impl std::fmt::Debug for Hash {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:02x}{:02x}…", self.0[0], self.0[1])
    }
}

/// Markdown inside an image folder is carried as an attachment, never given a page identity.
pub fn is_note(path: &str) -> bool {
    path.to_lowercase().ends_with(".md") && !in_assets(path)
}

/// Whether a path sits inside a page's image folder, at any depth.
pub fn in_assets(path: &str) -> bool {
    dirs_of(path).any(|dir| dir.eq_ignore_ascii_case(ASSETS_DIR))
}

/// Every folder a path passes through, not counting its own name.
fn dirs_of(path: &str) -> impl Iterator<Item = &str> {
    let dirs = path.rsplit_once('/').map_or("", |(dirs, _)| dirs);
    dirs.split('/').filter(|d| !d.is_empty())
}

/// Two paths that fold alike are one file on macOS and Windows; checked everywhere since the target
/// may be one of those.
pub fn fold(path: &str) -> String {
    path.nfc().collect::<String>().to_lowercase()
}

/// One top-level folder: a context, as the app calls them.
pub fn is_context_name(name: &str) -> bool {
    !name.starts_with('.')
        && !name.eq_ignore_ascii_case(ASSETS_DIR)
        && !name.eq_ignore_ascii_case(TRASH_DIR)
}

/// Whether a file or folder name is sync's or the app's own scratch, never the
/// user's: anything hidden, and half-written saves.
pub fn is_ignored_name(name: &str) -> bool {
    name.starts_with('.') || name.ends_with(TMP_SUFFIX)
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Entry {
    /// Exact bytes: what a write checks it is replacing.
    pub hash: Hash,

    /// Bytes with `updatedAt` removed, line endings and field order normalised. Every sync decision
    /// uses this, or two devices holding the same notes would conflict on every page.
    pub content: Hash,

    /// A fetch has to know what it is about to ask for.
    pub size: u64,

    pub updated_at: f64,

    /// The page id, for a note that has one.
    pub page_id: Option<String>,
}

/// Everything one device holds in its notes folder, as sync sees it.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Manifest {
    /// Every file, keyed by its path relative to the notes root, `/` separated.
    pub files: BTreeMap<String, Entry>,

    /// An empty context is still carried: it is in the switcher.
    pub contexts: BTreeSet<String>,
}

impl Manifest {
    pub fn get(&self, path: &str) -> Option<&Entry> {
        self.files.get(path)
    }
}

/// A notes folder as one round reads it.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Scan {
    pub manifest: Manifest,

    /// Unreadable looks like deleted; named so the plan leaves them alone on both sides.
    pub unreadable: BTreeSet<String>,
}

impl Scan {
    /// Compared folded: `Page.md` owns `page/` where case is ignored.
    pub fn hides(&self, path: &str) -> bool {
        let path = fold(path);
        self.unreadable.iter().any(|u| {
            u.is_empty()
                || path
                    .strip_prefix(fold(u).as_str())
                    .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
        })
    }
}

/// A missing root fails: an unplugged drive is not every note deleted.
pub fn scan(root: &Path) -> Result<Scan, String> {
    let mut out = Scan::default();
    let entries = std::fs::read_dir(root)
        .map_err(|e| format!("the notes folder {} can't be read: {e}", root.display()))?;
    walk(entries, root, "", &mut out);
    Ok(out)
}

/// A missing folder is an empty one here.
pub fn build(root: &Path) -> Manifest {
    scan(root).map(|s| s.manifest).unwrap_or_default()
}

fn walk(entries: std::fs::ReadDir, dir: &Path, rel_dir: &str, out: &mut Scan) {
    let mut dirs: Vec<(String, String)> = Vec::new();
    for entry in entries {
        let Ok(entry) = entry else {
            // Which name it was is unknown, so nothing under here can be
            // trusted to be complete.
            out.unreadable.insert(rel_dir.to_string());
            continue;
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        if is_ignored_name(&name) {
            continue;
        }
        let rel = crate::paths::join_rel(rel_dir, &name);
        // `file_type` does not follow symlinks; a link is left out.
        match entry.file_type() {
            Ok(t) if t.is_dir() => dirs.push((name, rel)),
            Ok(t) if t.is_file() => match std::fs::read(entry.path()) {
                Ok(bytes) => {
                    let entry = describe_bytes(&bytes, &rel, || mtime_ms(&entry.path()));
                    out.manifest.files.insert(rel, entry);
                }
                // Deleted since the folder was listed: gone, not unreadable.
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => {
                    // A page that cannot be read cannot own its folder either.
                    if is_note(&rel) {
                        out.unreadable
                            .insert(crate::paths::strip_md(&rel).to_string());
                    }
                    out.unreadable.insert(rel);
                }
            },
            Ok(_) => {}
            Err(_) => {
                out.unreadable.insert(rel);
            }
        }
    }
    for (name, rel) in dirs {
        // A trash is its device's own.
        if name.eq_ignore_ascii_case(TRASH_DIR) {
            continue;
        }
        if rel_dir.is_empty() && is_context_name(&name) {
            out.manifest.contexts.insert(name.clone());
        }
        if out.hides(&rel) {
            continue;
        }
        match std::fs::read_dir(dir.join(&name)) {
            Ok(entries) => walk(entries, &dir.join(&name), &rel, out),
            Err(_) => {
                out.unreadable.insert(rel);
            }
        }
    }
}

/// One file, as a manifest would list it, or `None` if it isn't there (or
/// isn't a plain file) any more.
pub fn describe(root: &Path, rel: &str) -> Option<Entry> {
    let path = super::apply::resolve(root, rel).ok()?;
    let meta = std::fs::symlink_metadata(&path).ok()?;
    if !meta.is_file() {
        return None;
    }
    describe_file(&path, rel)
}

fn describe_file(path: &Path, rel: &str) -> Option<Entry> {
    let bytes = std::fs::read(path).ok()?;
    Some(describe_bytes(&bytes, rel, || mtime_ms(path)))
}

/// `mtime` is asked only when the bytes carry no clock.
pub fn describe_bytes(bytes: &[u8], rel: &str, mtime: impl FnOnce() -> f64) -> Entry {
    let hash = Hash::of(bytes);

    if is_note(rel) {
        if let Ok(text) = std::str::from_utf8(bytes) {
            let (page_id, updated_at) = crate::scan::page_identity(text);
            return Entry {
                hash,
                content: content_hash(text),
                size: bytes.len() as u64,
                updated_at: updated_at.unwrap_or_else(mtime),
                page_id,
            };
        }
    }

    // Anything that is not a note is compared whole.
    Entry {
        hash,
        content: hash,
        size: bytes.len() as u64,
        updated_at: mtime(),
        page_id: None,
    }
}

/// `updatedAt` dropped, field order normalised, CRLF folded. Everything else inside the fence
/// counts (see `merge::split`).
pub fn content_hash(text: &str) -> Hash {
    let normalised: std::borrow::Cow<str> = if text.contains('\r') {
        text.replace("\r\n", "\n").into()
    } else {
        text.into()
    };
    let (front, body) = super::merge::split(&normalised);

    let mut fields: Vec<(&str, &str)> = front
        .iter()
        .filter(|(key, _)| key != UPDATED_AT)
        .map(|(key, value)| (key.as_str(), value.as_str()))
        .collect();
    fields.sort_unstable();

    let mut hasher = blake3::Hasher::new();

    // A note whose only field is `updatedAt` and the same text without frontmatter are different
    // files.
    hasher.update(&[u8::from(body.len() != normalised.len())]);

    // Separators no frontmatter key can contain.
    for (key, value) in fields {
        hasher.update(key.as_bytes());
        hasher.update(&[0]);
        hasher.update(value.as_bytes());
        hasher.update(&[0]);
    }
    hasher.update(&[1]);
    hasher.update(body.as_bytes());
    Hash(*hasher.finalize().as_bytes())
}

/// The content hash of bytes that may or may not be a note's text: what the
/// ancestor store files an ancestor under.
pub fn content_of(bytes: &[u8]) -> Hash {
    match std::str::from_utf8(bytes) {
        Ok(text) => content_hash(text),
        Err(_) => Hash::of(bytes),
    }
}

fn mtime_ms(path: &Path) -> f64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::TempDir;

    /// A note as Set writes it.
    fn note(id: &str, title: &str, updated: u64, body: &str) -> String {
        format!(
            "---\nid: \"{id}\"\ntitle: \"{title}\"\ncreatedAt: 1720000000000\nupdatedAt: {updated}\n---\n\n{body}\n"
        )
    }

    #[test]
    fn saving_a_note_again_without_changing_it_changes_nothing_that_counts() {
        // Same content, only the clock moved: this used to produce a conflict copy of every page.
        let before = note("p1", "Groceries", 1_000, "Milk\nEggs");
        let after = note("p1", "Groceries", 9_999, "Milk\nEggs");

        assert_ne!(
            Hash::of(before.as_bytes()),
            Hash::of(after.as_bytes()),
            "precondition: the bytes really are different"
        );
        assert_eq!(
            content_hash(&before),
            content_hash(&after),
            "and none of that difference is the note changing"
        );
    }

    #[test]
    fn every_part_of_a_note_that_says_something_counts_as_content() {
        let original = note("p1", "Groceries", 1_000, "Milk\nEggs");

        for (what, changed) in [
            (
                "the body",
                note("p1", "Groceries", 1_000, "Milk\nEggs\nBread"),
            ),
            ("the title", note("p1", "Shopping", 1_000, "Milk\nEggs")),
            ("the id", note("p2", "Groceries", 1_000, "Milk\nEggs")),
        ] {
            assert_ne!(
                content_hash(&original),
                content_hash(&changed),
                "a change to {what} is a change to the note"
            );
        }
    }

    #[test]
    fn a_field_appearing_or_disappearing_is_a_change() {
        let plain = "---\nid: \"p1\"\nupdatedAt: 1\n---\n\nbody\n";
        let locked = "---\nid: \"p1\"\nlocked: true\nupdatedAt: 1\n---\n\nbody\n";

        assert_ne!(content_hash(plain), content_hash(locked));
    }

    #[test]
    fn frontmatter_written_in_a_different_order_is_not_an_edit() {
        let one = "---\nid: \"p1\"\ntitle: \"A\"\nupdatedAt: 1\n---\n\nbody\n";
        let other = "---\ntitle: \"A\"\nid: \"p1\"\nupdatedAt: 2\n---\n\nbody\n";

        assert_eq!(content_hash(one), content_hash(other));
    }

    #[test]
    fn a_notes_folder_that_isnt_there_is_an_error_not_an_empty_folder() {
        let d = TempDir::new("manifest-gone");
        assert!(scan(&d.0.join("unplugged")).is_err());
        assert_eq!(
            scan(&d.0),
            Ok(Scan::default()),
            "empty is a different thing"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_page_that_cant_be_read_is_named_along_with_everything_it_owns() {
        let d = TempDir::new("manifest-unreadable");
        let locked = d.write("Set/Page.md", &note("p", "Page", 1, "x"));
        d.write("Set/Page/Child.md", &note("c", "Child", 1, "x"));
        d.write("Set/Pager.md", &note("o", "Pager", 1, "x"));
        if !crate::testing::lock_away(&locked) {
            return;
        }

        let seen = scan(&d.0).expect("the folder itself reads");
        assert_eq!(
            seen.manifest.files.keys().collect::<Vec<_>>(),
            vec!["Set/Pager.md"],
            "its children are not listed as though they belonged to nobody"
        );
        assert!(seen.hides("Set/Page.md") && seen.hides("Set/Page/Child.md"));
        assert!(seen.hides("set/page/Set-page-assets/pic.png"), "folded");
        assert!(!seen.hides("Set/Pager.md") && !seen.hides("Set/Other.md"));
    }

    #[test]
    fn windows_line_endings_are_not_an_edit_either() {
        let unix = note("p1", "A", 1, "one\ntwo");
        let windows = unix.replace('\n', "\r\n");

        assert_eq!(content_hash(&unix), content_hash(&windows));
    }

    #[test]
    fn no_two_different_sets_of_fields_can_spell_the_same_content() {
        let split = "---\nkey: value\nother: thing\nupdatedAt: 1\n---\n\nbody\n";
        let joined = "---\nkey: value\\nother: thing\nupdatedAt: 1\n---\n\nbody\n";

        assert_ne!(content_hash(split), content_hash(joined));
    }

    #[test]
    fn an_edit_to_a_list_in_the_frontmatter_is_a_change() {
        let one = "---\nid: \"p1\"\ntags:\n  - a\nupdatedAt: 1\n---\n\nbody\n";
        let other = "---\nid: \"p1\"\ntags:\n  - b\nupdatedAt: 1\n---\n\nbody\n";

        assert_ne!(content_hash(one), content_hash(other));
    }

    #[test]
    fn frontmatter_holding_only_the_clock_is_still_frontmatter() {
        assert_ne!(
            content_hash("---\nupdatedAt: 1\n---\n\nbody\n"),
            content_hash("body\n"),
            "taking the fence off a note is an edit to it"
        );
    }

    #[test]
    fn markdown_with_no_frontmatter_still_has_content_of_its_own() {
        assert_ne!(
            content_hash("# A heading\n"),
            content_hash("# Another heading\n")
        );
        assert_eq!(content_hash("# A heading\n"), content_hash("# A heading\n"));
    }

    #[test]
    fn a_note_on_disk_is_described_by_what_it_says_and_by_its_bytes() {
        let d = TempDir::new("manifest-describe");
        d.write("A.md", &note("p1", "A", 1_500, "body"));

        let manifest = build(&d.0);
        let entry = manifest.get("A.md").expect("the note should be listed");

        assert_eq!(entry.page_id.as_deref(), Some("p1"));
        assert_eq!(entry.updated_at, 1_500.0, "the clock comes from the note");
        assert_eq!(
            entry.hash,
            Hash::of(note("p1", "A", 1_500, "body").as_bytes()),
            "the bytes hash is the file, exactly"
        );
        assert_ne!(
            entry.hash, entry.content,
            "and the content hash is not the file, because the clock is out of it"
        );
        assert_eq!(describe(&d.0, "A.md").as_ref(), Some(entry));
        assert_eq!(describe(&d.0, "Missing.md"), None);
    }

    #[test]
    fn an_entry_records_what_the_file_weighs() {
        let d = TempDir::new("manifest-size");
        let body = "x".repeat(4_096);
        d.write("A/Set-page-assets/k3.png", &body);
        d.write("A.md", &note("p1", "A", 1, "body"));

        let found = build(&d.0);
        assert_eq!(found.files["A/Set-page-assets/k3.png"].size, 4_096);
        assert_eq!(
            found.files["A.md"].size,
            note("p1", "A", 1, "body").len() as u64,
            "a note's size is the whole file, frontmatter and all"
        );
    }

    #[test]
    fn an_attachment_is_compared_whole() {
        let d = TempDir::new("manifest-attachment");
        d.write("Set-page-assets/k3.png", "pretend png");

        let entry = build(&d.0)
            .files
            .remove("Set-page-assets/k3.png")
            .expect("the image should be listed");

        assert_eq!(
            entry.hash, entry.content,
            "there is no timestamp inside a PNG to discount"
        );
        assert_eq!(entry.page_id, None);
    }

    #[test]
    fn markdown_in_an_image_folder_is_an_attachment_not_a_page() {
        // The app never lists it, so it must not be given an identity that
        // could collide with a page's.
        let d = TempDir::new("manifest-assets-md");
        d.write(
            "A/Set-page-assets/readme.md",
            &note("p1", "Imposter", 1, "x"),
        );

        let entry = build(&d.0)
            .files
            .remove("A/Set-page-assets/readme.md")
            .expect("still carried");
        assert_eq!(entry.page_id, None);
        assert_eq!(entry.hash, entry.content);
        assert!(!is_note("A/Set-page-assets/readme.md"));
        assert!(is_note("A/readme.md"));
    }

    #[test]
    fn a_note_that_is_not_text_is_compared_whole_rather_than_skipped() {
        let d = TempDir::new("manifest-binary-md");
        std::fs::write(d.0.join("Odd.md"), [0xff, 0xfe, 0x00, 0x01]).unwrap();

        let entry = build(&d.0).files.remove("Odd.md").expect("still listed");
        assert_eq!(
            entry.hash, entry.content,
            "nothing can be read out of it, so all of it counts"
        );
    }

    #[test]
    fn the_walk_skips_what_is_not_the_users_and_finds_what_is() {
        let d = TempDir::new("manifest-walk");
        d.write("Work/A.md", &note("p1", "A", 1, "body"));
        d.write("Work/Projects/B.md", &note("p2", "B", 1, "body"));
        d.write(".hidden.md", "not the user's");
        d.write("Work/A.md.set-tmp", "half-written");
        d.write(".git/config", "not the user's either");
        d.write("Work/.set-sync-0000-1", "a move in flight");
        std::fs::create_dir_all(d.0.join("Empty")).unwrap();
        std::fs::create_dir_all(d.0.join("Set-Trash")).unwrap();

        let found = build(&d.0);
        let paths: Vec<&str> = found.files.keys().map(String::as_str).collect();
        assert_eq!(paths, vec!["Work/A.md", "Work/Projects/B.md"]);
        let contexts: Vec<&str> = found.contexts.iter().map(String::as_str).collect();
        assert_eq!(
            contexts,
            vec!["Empty", "Work"],
            "an empty context is still a context; the trash and hidden folders aren't"
        );
    }

    #[test]
    fn a_note_with_no_clock_of_its_own_falls_back_to_the_files_own() {
        let d = TempDir::new("manifest-no-clock");
        d.write("Loose.md", "# Written somewhere else\n");

        let entry = build(&d.0).files.remove("Loose.md").expect("listed");
        assert!(
            entry.updated_at > 0.0,
            "with nothing in the file, the filesystem's time has to do"
        );
        assert_eq!(entry.page_id, None);
    }

    #[test]
    fn names_that_are_one_file_on_a_mac_fold_to_one_name() {
        assert_eq!(fold("Work/Café.md"), fold("work/CAFÉ.md"));
        // "é" precomposed, and "e" followed by a combining acute accent.
        assert_eq!(fold("Caf\u{e9}.md"), fold("Cafe\u{301}.md"));
        assert_ne!(fold("Cafe.md"), fold("Café.md"));
    }

    #[test]
    fn no_trash_is_listed_wherever_it_is() {
        let d = TempDir::new("manifest-trash");
        d.write("Work/A.md", "live");
        d.write("Work/Set-Trash.md", "a page by that name is a page");
        d.write("Work/Set-Trash/B.md", "trashed");
        d.write("Work/set-trash/C/D.md", "trashed, whatever the case");
        d.write("Set-Trash/Old/E.md", "a deleted context");
        assert_eq!(
            build(&d.0).files.keys().collect::<Vec<_>>(),
            vec!["Work/A.md", "Work/Set-Trash.md"]
        );
    }

    #[test]
    fn an_image_folder_is_recognised_at_any_depth() {
        assert!(in_assets("Work/A/Set-page-assets/k.png"));
        assert!(!in_assets("Work/A/k.png"));
    }
}
