use std::path::PathBuf;

use serde_json::{json, Value};

use crate::jsonl;

const FILE_NAME: &str = "mcp-log.jsonl";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub at: u64,

    pub tool: String,

    pub detail: String,

    pub results: usize,
}

impl Entry {
    pub fn new(tool: &str, detail: impl Into<String>, results: usize) -> Self {
        Entry {
            at: crate::clock::now_ms(),
            tool: tool.to_owned(),
            detail: detail.into(),
            results,
        }
    }
}

pub fn log_file() -> Option<PathBuf> {
    jsonl::path(FILE_NAME)
}

pub fn append(entry: &Entry) {
    jsonl::append(FILE_NAME, encode(entry));
}

pub fn read() -> Vec<Entry> {
    jsonl::read(FILE_NAME)
        .iter()
        .filter_map(|line| decode(line))
        .collect()
}

pub fn clear() -> Result<(), String> {
    jsonl::clear(FILE_NAME)
}

fn encode(entry: &Entry) -> String {
    json!({
        "at": entry.at,
        "tool": entry.tool,
        "detail": entry.detail,
        "results": entry.results,
    })
    .to_string()
}

fn decode(line: &str) -> Option<Entry> {
    let value: Value = serde_json::from_str(line).ok()?;
    Some(Entry {
        at: value.get("at").and_then(Value::as_u64).unwrap_or(0),
        tool: value.get("tool").and_then(Value::as_str)?.to_owned(),
        detail: value
            .get("detail")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        results: value
            .get("results")
            .and_then(Value::as_u64)
            .unwrap_or_default() as usize,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_entry_round_trips() {
        let entry = Entry::new("search_pages", "severance agreement", 3);
        assert_eq!(decode(&encode(&entry)), Some(entry));
    }

    #[test]
    fn a_line_that_isnt_ours_is_skipped_not_fatal() {
        for line in ["", "not json", "{}", "[]", r#"{"at": 1}"#] {
            assert_eq!(decode(line), None, "{line:?} decoded");
        }
    }

    #[test]
    fn missing_fields_fall_back_rather_than_dropping_the_entry() {
        let entry = decode(r#"{"tool": "get_page"}"#).expect("an entry");
        assert_eq!(entry.tool, "get_page");
        assert_eq!(entry.at, 0);
        assert_eq!(entry.detail, "");
        assert_eq!(entry.results, 0);
    }

    #[test]
    fn it_lives_beside_the_access_switch_not_in_the_notes() {
        let path = log_file().expect("a log path");
        assert!(path.ends_with(FILE_NAME), "{path:?}");
        assert_eq!(
            path.parent(),
            crate::mcp::access::access_file()
                .as_deref()
                .and_then(std::path::Path::parent),
            "the log and the switch should share one folder"
        );
    }
}
