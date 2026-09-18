use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::State;

use crate::index::SearchIndex;
use crate::paths::{is_reserved, join_rel, strip_md};
use crate::write::TMP_SUFFIX;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanEntry {
    pub id: String,
    pub parent_id: Option<String>,
    pub title: String,

    pub order: Option<f64>,

    pub locked: bool,
    pub created_at: f64,
    pub updated_at: f64,

    pub rel_path: String,
}

#[derive(Default)]
struct Meta {
    id: Option<String>,
    title: Option<String>,
    order: Option<f64>,
    locked: Option<bool>,
    created_at: Option<f64>,
    updated_at: Option<f64>,
}

#[tauri::command]
pub fn scan_notes(
    index: State<'_, SearchIndex>,
    notes_root: State<'_, crate::root::NotesRoot>,
    root: String,
) -> Result<Vec<ScanEntry>, String> {
    let granted = notes_root.get()?;
    let asked = std::path::Path::new(&root)
        .canonicalize()
        .map_err(|e| format!("the notes folder {root} can't be resolved: {e}"))?;
    if asked != granted {
        crate::log::warn("notes.scan_refused")
            .field("asked", asked.display())
            .field("granted", granted.display())
            .emit();
        return Err(format!(
            "refusing to scan {root}: it isn't the granted notes folder"
        ));
    }
    let started = std::time::Instant::now();
    let (entries, bodies) = scan_tree(&granted.to_string_lossy());
    index.replace_all(bodies);
    crate::log::info("notes.scanned")
        .field("pages", entries.len())
        .elapsed(started)
        .emit();
    Ok(entries)
}

pub fn scan_tree(root: &str) -> (Vec<ScanEntry>, HashMap<String, String>) {
    let root_path = Path::new(root);
    let mut out = Vec::new();
    let mut bodies = HashMap::new();
    if root_path.is_dir() {
        scan_dir(root_path, "", None, &mut out, &mut bodies);
    }
    (out, bodies)
}

fn scan_dir(
    abs_dir: &Path,
    rel_dir: &str,
    parent_id: Option<&str>,
    out: &mut Vec<ScanEntry>,
    bodies: &mut HashMap<String, String>,
) {
    let entries = match fs::read_dir(abs_dir) {
        Ok(e) => e,
        Err(_) => return,
    };

    let mut files: Vec<String> = Vec::new();
    let mut dirs: Vec<String> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        match entry.file_type() {
            Ok(ft) if ft.is_dir() => dirs.push(name),
            Ok(ft) if ft.is_file() => files.push(name),
            _ => {}
        }
    }

    let mut folder_owner: HashMap<String, String> = HashMap::new();
    for name in &files {
        if name.ends_with(TMP_SUFFIX) {
            let _ = fs::remove_file(abs_dir.join(name));
            continue;
        }
        if !name.to_lowercase().ends_with(".md") {
            continue;
        }
        let rel_path = join_rel(rel_dir, name);

        let text = fs::read_to_string(abs_dir.join(name))
            .unwrap_or_default()
            .replace("\r\n", "\n");
        let meta = read_file_meta(&text);
        let now = crate::clock::now_ms() as f64;
        let id = meta.id.unwrap_or_else(gen_id);
        let base = strip_md(name).to_string();
        bodies.insert(id.clone(), strip_frontmatter(&text).to_owned());
        out.push(ScanEntry {
            id: id.clone(),
            parent_id: parent_id.map(str::to_owned),
            title: meta.title.unwrap_or_else(|| base.clone()),
            order: meta.order,
            locked: meta.locked.unwrap_or(false),
            created_at: meta.created_at.unwrap_or(now),
            updated_at: meta.updated_at.unwrap_or(now),
            rel_path,
        });
        folder_owner.insert(base, id);
    }

    for name in &dirs {
        // Reserved folders are layout, hidden folders are never pages (.git, sync scratch).
        if is_reserved(name) || name.starts_with('.') {
            continue;
        }
        let owner = folder_owner.get(name).map(String::as_str);
        scan_dir(
            &abs_dir.join(name),
            &join_rel(rel_dir, name),
            owner,
            out,
            bodies,
        );
    }
}

pub fn markdown_body(text: &str) -> String {
    strip_frontmatter(&text.replace("\r\n", "\n")).to_owned()
}

fn strip_frontmatter(text: &str) -> &str {
    if !text.starts_with("---\n") {
        return text;
    }

    let Some(rel_end) = text[3..].find("\n---") else {
        return text;
    };

    let body = text.get(3 + rel_end + 5..).unwrap_or("");
    body.strip_prefix('\n').unwrap_or(body)
}

fn read_file_meta(normalized: &str) -> Meta {
    let mut meta = Meta::default();
    if !normalized.starts_with("---\n") {
        return meta;
    }

    let Some(rel_end) = normalized[3..].find("\n---") else {
        return meta;
    };

    let block = normalized.get(4..3 + rel_end).unwrap_or("");

    for line in block.split('\n') {
        let Some(sep) = line.find(':') else { continue };
        let key = line[..sep].trim();
        let raw = line[sep + 1..].trim();

        let value: serde_json::Value =
            serde_json::from_str(raw).unwrap_or(serde_json::Value::String(raw.to_string()));
        match key {
            "id" => meta.id = value.as_str().map(str::to_owned),
            "title" => meta.title = value.as_str().map(str::to_owned),
            "order" => meta.order = value.as_f64(),

            "locked" => meta.locked = value.as_bool(),
            "createdAt" => meta.created_at = value.as_f64(),
            "updatedAt" => meta.updated_at = value.as_f64(),
            _ => {}
        }
    }
    meta
}

pub fn page_identity(text: &str) -> (Option<String>, Option<f64>) {
    let meta = read_file_meta(&text.replace("\r\n", "\n"));
    (meta.id, meta.updated_at)
}

fn gen_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let seed = nanos ^ COUNTER.fetch_add(0x9E37_79B9_7F4A_7C15, Ordering::Relaxed);
    let hi = splitmix64(seed);
    let lo = splitmix64(seed ^ 0xDEAD_BEEF_CAFE_BABE);

    let mut b = [0u8; 16];
    b[..8].copy_from_slice(&hi.to_be_bytes());
    b[8..].copy_from_slice(&lo.to_be_bytes());
    b[6] = (b[6] & 0x0F) | 0x40;
    b[8] = (b[8] & 0x3F) | 0x80;
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7],
        b[8], b[9], b[10], b[11], b[12], b[13], b[14], b[15],
    )
}

fn splitmix64(mut x: u64) -> u64 {
    x = x.wrapping_add(0x9E37_79B9_7F4A_7C15);
    let mut z = x;
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::TempDir;

    fn page(id: &str, title: &str, extra: &str) -> String {
        format!(
            "---\nid: {:?}\ntitle: {:?}\nparentId: null\n{}createdAt: 1000\nupdatedAt: 2000\n---\n\nbody\n",
            id, title, extra
        )
    }

    fn find<'a>(entries: &'a [ScanEntry], title: &str) -> &'a ScanEntry {
        entries.iter().find(|e| e.title == title).expect("entry")
    }

    #[test]
    fn derives_tree_and_skips_noise() {
        let d = TempDir::new("scan");

        d.write("Alpha.md", &page("a", "Alpha", ""));
        d.write("Alpha/Beta.md", &page("b", "Beta", ""));

        d.write("Gamma.md", &page("g", "Gamma", "order: 3\n"));

        d.write("notes.txt", "not a page");
        d.write("scratch.md.set-tmp", "half-written");
        d.write("Set-Trash/Deleted.md", &page("z", "Deleted", ""));
        d.write("Work/Set-Trash/Dropped.md", &page("y", "Dropped", ""));

        d.write("Alpha/Set-page-assets/pic.png", "PNG");
        d.write("Alpha/Set-page-assets/Sneaky.md", &page("s", "Sneaky", ""));

        d.write("Loose.md", "just some markdown, no frontmatter\n");

        let (entries, _) = scan_tree(&d.path().to_string_lossy());

        assert_eq!(entries.len(), 4, "unexpected: {:?}", titles(&entries));
        assert!(!entries.iter().any(|e| e.title == "Deleted"));
        assert!(!entries.iter().any(|e| e.title == "Dropped"));
        assert!(!entries.iter().any(|e| e.title == "Sneaky"));

        let alpha = find(&entries, "Alpha");
        let beta = find(&entries, "Beta");
        assert_eq!(alpha.parent_id, None);
        assert_eq!(beta.parent_id.as_deref(), Some("a"));
        assert_eq!(beta.rel_path, "Alpha/Beta.md");

        let gamma = find(&entries, "Gamma");
        assert_eq!(gamma.order, Some(3.0));
        assert_eq!(gamma.created_at, 1000.0);

        let loose = find(&entries, "Loose");
        assert!(!loose.id.is_empty());
        assert!(alpha.order.is_none());

        assert!(!alpha.locked);

        assert!(!d.path().join("scratch.md.set-tmp").exists());
    }

    #[test]
    fn locked_pages() {
        let d = TempDir::new("scan");
        d.write("Locked.md", &page("l", "Locked", "locked: true\n"));
        d.write("Unlocked.md", &page("u", "Unlocked", "locked: false\n"));
        d.write("Plain.md", &page("p", "Plain", ""));

        d.write("Handwritten.md", &page("h", "Handwritten", "locked: yes\n"));

        let (entries, _) = scan_tree(&d.path().to_string_lossy());

        assert!(find(&entries, "Locked").locked);
        assert!(!find(&entries, "Unlocked").locked);
        assert!(!find(&entries, "Plain").locked);
        assert!(!find(&entries, "Handwritten").locked);
    }

    #[test]
    fn feeds_the_content_index_with_bodies_only() {
        let d = TempDir::new("scan");
        d.write("Alpha.md", &page("a", "Alpha", ""));
        d.write("Alpha/Beta.md", &page("b", "Beta", ""));
        d.write("Loose.md", "no frontmatter here\n");

        d.write("Set-Trash/Deleted.md", &page("z", "Deleted", ""));
        d.write("Alpha/Set-page-assets/Sneaky.md", &page("s", "Sneaky", ""));

        let (_, bodies) = scan_tree(&d.path().to_string_lossy());

        assert_eq!(bodies.len(), 3, "unexpected: {:?}", bodies.keys());
        assert!(!bodies.contains_key("z"), "trashed page is searchable");
        assert!(!bodies.contains_key("s"), "asset folder page is searchable");

        assert_eq!(bodies["a"], "body\n");
        assert!(!bodies["a"].contains("createdAt"));
        assert!(!bodies["a"].contains("Alpha"));
        assert_eq!(bodies["b"], "body\n");

        let loose = bodies.values().find(|b| b.contains("no frontmatter"));
        assert!(loose.is_some(), "hand-dropped file not indexed");
    }

    #[test]
    fn crlf_files_are_normalized_before_indexing() {
        let d = TempDir::new("scan");
        d.write(
            "Win.md",
            "---\r\nid: \"w\"\r\ntitle: \"Win\"\r\n---\r\n\r\nfirst line\r\nsecond line\r\n",
        );
        let (entries, bodies) = scan_tree(&d.path().to_string_lossy());
        assert_eq!(entries[0].title, "Win", "frontmatter unparsed after CRLF");
        assert_eq!(bodies["w"], "first line\nsecond line\n");
    }

    #[test]
    fn strip_frontmatter_matches_the_typescript_split() {
        assert_eq!(strip_frontmatter("no frontmatter"), "no frontmatter");
        assert_eq!(strip_frontmatter("---\nid: \"a\"\n---\n\nbody\n"), "body\n");

        assert_eq!(strip_frontmatter("---\nid: \"a\"\n---\nbody\n"), "body\n");

        assert_eq!(strip_frontmatter("---\nid: \"a\"\n"), "---\nid: \"a\"\n");

        assert_eq!(strip_frontmatter("---\nid: \"a\"\n---"), "");

        assert_eq!(
            strip_frontmatter("---\nid: \"a\"\n---\n\nintro\n\n---\n\nrest\n"),
            "intro\n\n---\n\nrest\n"
        );

        assert_eq!(
            strip_frontmatter("---\nid: \"a\"\n---\n\ncafé ☕\n"),
            "café ☕\n"
        );
    }

    #[test]
    fn empty_frontmatter_block_does_not_panic() {
        let d = TempDir::new("scan");
        d.write("Weird.md", "---\n---\n\nbody\n");
        let (entries, _) = scan_tree(&d.path().to_string_lossy());
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].title, "Weird");
    }

    #[test]
    #[ignore = "perf budget; run in release via the Performance workflow"]
    fn scan_budget_5000_pages() {
        let d = TempDir::new("scan");
        let n = 5000usize;

        for i in 0..n {
            let folder = format!("Group {}", i / 100);
            d.write(
                &format!("{}/Page {}.md", folder, i),
                &page(&format!("id{}", i), &format!("Page {}", i), ""),
            );
        }

        let root = d.path().to_string_lossy().into_owned();
        let start = std::time::Instant::now();
        let (entries, _) = scan_tree(&root);
        let ms = start.elapsed().as_millis();
        eprintln!("PERF scan_notes: {} entries in {} ms", entries.len(), ms);

        assert_eq!(entries.len(), n);
        assert!(
            ms < 5000,
            "scan regressed: {} ms for {} pages (budget 5000 ms)",
            ms,
            n
        );
    }

    fn titles(entries: &[ScanEntry]) -> Vec<&str> {
        entries.iter().map(|e| e.title.as_str()).collect()
    }
}
