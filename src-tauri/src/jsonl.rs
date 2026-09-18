//! JSONL file in the config folder, capped at its own tail. Shared by `mcp::log` and `sync::log`.

use std::fs;
use std::path::PathBuf;

use crate::config::config_dir;

const MAX_ENTRIES: usize = 500;

pub fn path(file_name: &str) -> Option<PathBuf> {
    Some(config_dir()?.join(file_name))
}

pub fn append(file_name: &str, line: String) {
    let Some(path) = path(file_name) else { return };
    if let Some(dir) = path.parent() {
        if fs::create_dir_all(dir).is_err() {
            return;
        }
    }
    let mut lines: Vec<String> = fs::read_to_string(&path)
        .map(|text| text.lines().map(str::to_owned).collect())
        .unwrap_or_default();
    lines.push(line);
    if lines.len() > MAX_ENTRIES {
        lines.drain(..lines.len() - MAX_ENTRIES);
    }
    let _ = fs::write(&path, format!("{}\n", lines.join("\n")));
}

pub fn read(file_name: &str) -> Vec<String> {
    let Some(path) = path(file_name) else {
        return Vec::new();
    };
    fs::read_to_string(path)
        .map(|text| text.lines().map(str::to_owned).collect())
        .unwrap_or_default()
}

pub fn clear(file_name: &str) -> Result<(), String> {
    let Some(path) = path(file_name) else {
        return Ok(());
    };
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(format!("clearing {}: {err}", path.display())),
    }
}
