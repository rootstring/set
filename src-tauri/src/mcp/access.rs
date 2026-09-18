use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::config::config_dir;

const FILE_NAME: &str = "mcp-access.json";

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Mode {
    #[default]
    Read,

    Write,
}

impl Mode {
    pub fn as_str(self) -> &'static str {
        match self {
            Mode::Read => "read",
            Mode::Write => "write",
        }
    }

    pub fn writable(self) -> bool {
        matches!(self, Mode::Write)
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Access {
    pub enabled: bool,

    pub mode: Mode,

    pub notes_dir: Option<PathBuf>,

    /// `None` is unscoped; `Some(vec![])` is scoped to nothing, not an empty notes folder.
    pub allowed_contexts: Option<Vec<String>>,
}

pub fn access_file() -> Option<PathBuf> {
    Some(config_dir()?.join(FILE_NAME))
}

pub fn read() -> Access {
    access_file()
        .and_then(|path| fs::read_to_string(path).ok())
        .map(|text| parse(&text))
        .unwrap_or_default()
}

fn parse(text: &str) -> Access {
    let Ok(value) = serde_json::from_str::<Value>(text) else {
        return Access::default();
    };
    Access {
        enabled: value
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(false),

        mode: match value.get("mode").and_then(Value::as_str) {
            Some("write") => Mode::Write,
            _ => Mode::Read,
        },
        notes_dir: value
            .get("notesDir")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(PathBuf::from),

        allowed_contexts: scope(&value),
    }
}

fn scope(value: &Value) -> Option<Vec<String>> {
    let names = value.get("allowedContexts")?.as_array()?;
    Some(
        names
            .iter()
            .filter_map(Value::as_str)
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(str::to_owned)
            .collect(),
    )
}

/// So a client configured before the notes folder moved follows it.
pub fn follow_notes_dir(notes_dir: &Path) -> Result<bool, String> {
    let Some(text) = access_file().and_then(|path| fs::read_to_string(path).ok()) else {
        return Ok(false);
    };
    match retargeted(&text, notes_dir) {
        Some(access) => write(&access).map(|_| true),
        None => Ok(false),
    }
}

/// A file that is not a JSON object is left for the user to see.
fn retargeted(text: &str, notes_dir: &Path) -> Option<Access> {
    if !serde_json::from_str::<Value>(text).is_ok_and(|value| value.is_object()) {
        return None;
    }
    let mut access = parse(text);
    if access.notes_dir.as_deref() == Some(notes_dir) {
        return None;
    }
    access.notes_dir = Some(notes_dir.to_path_buf());
    Some(access)
}

pub fn write(access: &Access) -> Result<PathBuf, String> {
    let path = access_file().ok_or("no OS config directory to store MCP access in")?;
    let dir = path
        .parent()
        .ok_or("MCP access path has no parent directory")?;
    fs::create_dir_all(dir).map_err(|e| format!("creating {}: {e}", dir.display()))?;
    let body = json!({
        "enabled": access.enabled,
        "mode": access.mode.as_str(),
        "notesDir": access.notes_dir.as_ref().map(|p| p.to_string_lossy()),
        "allowedContexts": access.allowed_contexts,

        "_comment": "Written by Set. Controls whether the set-mcp server may read \
    your notes, which contexts it may read, and whether it may also create new pages; \
    change it in Settings → Agent access.",
    });
    let text = serde_json::to_string_pretty(&body).map_err(|e| e.to_string())?;
    fs::write(&path, text).map_err(|e| format!("writing {}: {e}", path.display()))?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nothing_malformed_can_grant_access() {
        for text in [
            "",
            "not json",
            "{}",
            "[]",
            "null",
            r#"{"enabled": "yes"}"#,
            r#"{"enabled": 1}"#,
            r#"{"Enabled": true}"#,
            r#"{"enabled": [true]}"#,
            r#"{"notesDir": "/tmp"}"#,
        ] {
            assert!(!parse(text).enabled, "{text:?} granted access");
        }
    }

    #[test]
    fn the_default_is_off_unscoped_and_read_only() {
        assert_eq!(
            Access::default(),
            Access {
                enabled: false,
                mode: Mode::Read,
                notes_dir: None,
                allowed_contexts: None,
            }
        );
    }

    #[test]
    fn nothing_malformed_can_grant_writes() {
        for text in [
            r#"{"enabled": true}"#,
            r#"{"enabled": true, "mode": "Write"}"#,
            r#"{"enabled": true, "mode": "readwrite"}"#,
            r#"{"enabled": true, "mode": true}"#,
            r#"{"enabled": true, "mode": ["write"]}"#,
            r#"{"enabled": true, "mode": null}"#,
            r#"{"enabled": true, "Mode": "write"}"#,
        ] {
            assert_eq!(parse(text).mode, Mode::Read, "{text:?} granted writes");
            assert!(!parse(text).mode.writable(), "{text:?}");
        }

        let granted = parse(r#"{"enabled": true, "mode": "write"}"#);
        assert_eq!(granted.mode, Mode::Write);
        assert!(granted.mode.writable());
    }

    #[test]
    fn the_mode_is_independent_of_the_switch() {
        let revoked = parse(r#"{"enabled": false, "mode": "write"}"#);
        assert!(!revoked.enabled);
        assert_eq!(revoked.mode, Mode::Write);
    }

    #[test]
    fn a_scope_is_read_back_exactly_as_written() {
        let scoped = parse(r#"{"enabled": true, "allowedContexts": ["Work", "Refs"]}"#);
        assert_eq!(
            scoped.allowed_contexts,
            Some(vec!["Work".to_owned(), "Refs".to_owned()])
        );

        assert_eq!(parse(r#"{"enabled": true}"#).allowed_contexts, None);

        assert_eq!(
            parse(r#"{"enabled": true, "allowedContexts": []}"#).allowed_contexts,
            Some(vec![])
        );

        for text in [
            r#"{"enabled": true, "allowedContexts": "Work"}"#,
            r#"{"enabled": true, "allowedContexts": null}"#,
            r#"{"enabled": true, "allowedContexts": 3}"#,
        ] {
            assert_eq!(parse(text).allowed_contexts, None, "{text:?}");
        }

        assert_eq!(
            parse(r#"{"enabled": true, "allowedContexts": ["Work", 7, " ", null]}"#)
                .allowed_contexts,
            Some(vec!["Work".to_owned()])
        );
    }

    #[test]
    fn a_well_formed_grant_round_trips() {
        let granted = parse(r#"{"enabled": true, "notesDir": "/Users/x/Documents/Set"}"#);
        assert!(granted.enabled);
        assert_eq!(
            granted.notes_dir,
            Some(PathBuf::from("/Users/x/Documents/Set"))
        );

        let no_folder = parse(r#"{"enabled": true, "notesDir": ""}"#);
        assert!(no_folder.enabled);
        assert_eq!(no_folder.notes_dir, None);

        let revoked = parse(r#"{"enabled": false, "notesDir": "/Users/x/Documents/Set"}"#);
        assert!(!revoked.enabled);
        assert!(revoked.notes_dir.is_some());
    }

    #[test]
    fn what_write_produces_is_what_parse_reads() {
        for allowed_contexts in [None, Some(vec![]), Some(vec!["Work".to_owned()])] {
            for mode in [Mode::Read, Mode::Write] {
                let access = Access {
                    enabled: true,
                    mode,
                    notes_dir: Some(PathBuf::from("/Users/x/Documents/Set")),
                    allowed_contexts: allowed_contexts.clone(),
                };
                let body = json!({
                    "enabled": access.enabled,
                    "mode": access.mode.as_str(),
                    "notesDir": access.notes_dir.as_ref().map(|p| p.to_string_lossy()),
                    "allowedContexts": access.allowed_contexts,
                });
                assert_eq!(parse(&body.to_string()), access);
            }
        }
    }

    #[test]
    fn a_moved_notes_folder_carries_the_grant_with_it() {
        let moved = Path::new("/Users/x/Notes");
        let text = r#"{"enabled": true, "mode": "write", "notesDir": "/Users/x/Documents/Set",
            "allowedContexts": ["Work"]}"#;
        assert_eq!(
            retargeted(text, moved),
            Some(Access {
                enabled: true,
                mode: Mode::Write,
                notes_dir: Some(moved.to_path_buf()),
                allowed_contexts: Some(vec!["Work".to_owned()]),
            })
        );

        // A revoked grant still follows, so turning it back on points at the right folder.
        let revoked =
            retargeted(r#"{"enabled": false, "notesDir": "/old"}"#, moved).expect("a rewrite");
        assert!(!revoked.enabled);
        assert_eq!(revoked.notes_dir.as_deref(), Some(moved));
    }

    #[test]
    fn following_the_notes_folder_leaves_the_rest_alone() {
        let here = Path::new("/Users/x/Notes");
        assert_eq!(
            retargeted(r#"{"enabled": true, "notesDir": "/Users/x/Notes"}"#, here),
            None
        );

        for text in ["", "not json", "[]", "null", r#""/Users/x/Notes""#] {
            assert_eq!(retargeted(text, here), None, "{text:?}");
        }
    }

    #[test]
    fn the_path_sits_under_the_os_config_dir_in_our_own_folder() {
        let path = access_file().expect("a config path");
        let app_dir = crate::config::app_dir_name();
        assert!(path.ends_with(format!("{app_dir}/{FILE_NAME}")), "{path:?}");
        assert!(path.is_absolute(), "{path:?}");

        assert!(
            !path.to_string_lossy().contains("Documents/Set"),
            "{path:?}"
        );
    }
}
