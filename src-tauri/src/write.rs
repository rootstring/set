use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use sha2::{Digest, Sha256};
use tauri::State;

use crate::index::SearchIndex;
use crate::watch::Watch;

/// Scans, the folder watch and sync all skip files with this suffix.
pub(crate) const TMP_SUFFIX: &str = ".set-tmp";

/// Held across check and write by the app's saves and sync's apply alike, so neither lands between
/// the other's check and write.
static GATE: Mutex<()> = Mutex::new(());

pub fn gate() -> MutexGuard<'static, ()> {
    // Guards an ordering, not data, so poisoning does not matter.
    GATE.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// What a write expects to find where it is about to write.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Expect {
    /// Whatever is there. For writes that aren't replacing a page's text.
    Anything,
    /// Nothing: a page being created.
    Absent,
    /// A file whose text hashes (SHA-256, lowercase hex, see `text_sha256`)
    /// to this.
    Sha256(String),
}

impl Expect {
    /// The form the frontend sends: nothing, `"absent"`, or a hex digest.
    pub fn parse(raw: Option<&str>) -> Self {
        match raw {
            None => Expect::Anything,
            Some("absent") => Expect::Absent,
            Some(hex) => Expect::Sha256(hex.to_ascii_lowercase()),
        }
    }
}

/// The frontend matches on the prefix.
pub const CHANGED_ON_DISK: &str = "changed-on-disk";

pub fn sha256_hex(bytes: &[u8]) -> String {
    crate::hex::encode(&Sha256::digest(bytes))
}

/// Decoded the way `TextDecoder` does (BOM dropped, invalid UTF-8 replaced), or a note with a BOM
/// would look changed on every save.
pub fn text_sha256(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    sha256_hex(text.as_bytes())
}

/// Whether `path` holds what `expect` says. The caller holds the gate.
pub fn matches(path: &Path, expect: &Expect) -> bool {
    match expect {
        Expect::Anything => true,
        Expect::Absent => fs::symlink_metadata(path).is_err(),
        Expect::Sha256(hex) => fs::read(path).is_ok_and(|bytes| text_sha256(&bytes) == *hex),
    }
}

#[tauri::command]
pub async fn write_page(
    index: State<'_, SearchIndex>,
    notes_root: State<'_, crate::root::NotesRoot>,
    watch: State<'_, Watch>,
    path: String,
    contents: String,
    id: Option<String>,
    expected: Option<String>,
) -> Result<(), String> {
    let path = notes_root.contain(&path)?;
    let indexed = id.map(|id| (id, crate::scan::markdown_body(&contents)));
    let expect = Expect::parse(expected.as_deref());

    let written = path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _held = gate();
        if !matches(&written, &expect) {
            // Not an error (the editor offers a merge), but the log is where the race is
            // reconstructed.
            crate::log::info("page.changed_on_disk")
                .field("path", written.display())
                .emit();
            return Err(format!(
                "{CHANGED_ON_DISK}: {} is no longer the version this was edited from",
                written.display()
            ));
        }
        write_atomically(&written, contents.as_bytes()).inspect_err(|err| {
            crate::log::error("page.write_failed")
                .field("path", written.display())
                .field("error", err)
                .emit();
        })
    })
    .await
    .map_err(|e| e.to_string())??;

    watch.own_writes().record(&path);

    if let Some((id, body)) = indexed {
        index.upsert(id, body);
    }

    Ok(())
}

/// `None` when both rewrote the same lines.
#[tauri::command]
pub fn merge_note(base: String, ours: String, theirs: String) -> Option<String> {
    let merged = crate::sync::merge::markdown(base.as_bytes(), ours.as_bytes(), theirs.as_bytes())?;
    String::from_utf8(merged).ok()
}

/// Bytes are on disk before the rename, or a crash leaves an empty file that sync carries
/// everywhere.
pub(crate) fn write_atomically(target: &Path, contents: &[u8]) -> Result<(), String> {
    // No fsync in unit tests: it turns the sync fuzz from seconds into minutes.
    write_via_tmp(target, contents, !cfg!(test))
}

/// No fsync. For stores whose every read is hash-checked, where an empty file is a miss, not a
/// mistake.
pub(crate) fn write_cache(target: &Path, contents: &[u8]) -> Result<(), String> {
    write_via_tmp(target, contents, false)
}

fn write_via_tmp(target: &Path, contents: &[u8], durable: bool) -> Result<(), String> {
    use std::io::Write;

    let Some(parent) = target.parent() else {
        return Err(format!(
            "refusing to write to {}: no parent directory",
            target.display()
        ));
    };
    let mut tmp = target.as_os_str().to_owned();
    tmp.push(TMP_SUFFIX);
    let tmp = PathBuf::from(tmp);

    let written = (|| {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(contents)?;
        if durable {
            file.sync_all()?;
        }
        Ok::<(), std::io::Error>(())
    })();
    if let Err(e) = written {
        let _ = fs::remove_file(&tmp);
        return Err(format!("writing {}: {e}", tmp.display()));
    }
    if let Err(e) = fs::rename(&tmp, target) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("renaming onto {}: {e}", target.display()));
    }
    // Best effort: not every filesystem lets a folder be synced.
    #[cfg(unix)]
    if durable {
        if let Ok(dir) = fs::File::open(parent) {
            let _ = dir.sync_all();
        }
    }
    #[cfg(not(unix))]
    let _ = parent;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::TempDir;

    #[test]
    fn a_write_expecting_the_version_on_disk_is_let_through() {
        let d = TempDir::new("write-cas");
        let path = d.write("A.md", "before");
        assert!(matches(&path, &Expect::Sha256(sha256_hex(b"before"))));
        assert!(!matches(
            &path,
            &Expect::Sha256(sha256_hex(b"something else"))
        ));
        assert!(!matches(&path, &Expect::Absent));
        assert!(matches(&d.0.join("New.md"), &Expect::Absent));
        assert!(
            !matches(&d.0.join("New.md"), &Expect::Sha256(sha256_hex(b""))),
            "a file that has gone is not the version anyone expected"
        );
    }

    #[test]
    fn a_file_is_the_version_expected_by_its_text_not_its_bytes() {
        let d = TempDir::new("write-cas-text");
        let path = d.0.join("Bom.md");
        std::fs::write(&path, b"\xef\xbb\xbfhello").unwrap();
        // What `readTextFile` hands the editor: the mark gone.
        assert!(matches(&path, &Expect::Sha256(sha256_hex(b"hello"))));
        std::fs::write(&path, b"caf\xe9").unwrap();
        assert!(matches(
            &path,
            &Expect::Sha256(sha256_hex("caf\u{fffd}".as_bytes()))
        ));
    }

    #[test]
    fn the_frontend_forms_of_an_expectation_read_as_meant() {
        assert_eq!(Expect::parse(None), Expect::Anything);
        assert_eq!(Expect::parse(Some("absent")), Expect::Absent);
        assert_eq!(
            Expect::parse(Some("ABCD")),
            Expect::Sha256("abcd".to_string())
        );
    }

    #[test]
    fn sha256_is_the_digest_web_crypto_gives() {
        // `crypto.subtle.digest("SHA-256", "hello")`
        assert_eq!(
            sha256_hex(b"hello"),
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
    }

    #[test]
    fn an_editor_merge_keeps_both_sets_of_edits() {
        let note = |updated: u64, body: &str| {
            format!("---\nid: \"p1\"\ntitle: \"A\"\nupdatedAt: {updated}\n---\n\n{body}\n")
        };
        let merged = merge_note(
            note(1, "one\ntwo\nthree"),
            note(3, "one\ntwo\nthree\nfour from the editor"),
            note(2, "one\ntwo from the other device\nthree"),
        )
        .expect("different lines merge");
        assert!(merged.contains("four from the editor"), "{merged}");
        assert!(merged.contains("two from the other device"), "{merged}");

        assert_eq!(
            merge_note(note(1, "one"), note(2, "mine"), note(3, "theirs")),
            None,
            "the same line rewritten two ways is not guessed at"
        );
    }
}
