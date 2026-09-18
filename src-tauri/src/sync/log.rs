use std::fmt::Display;

use serde_json::{json, Value};

use crate::jsonl;

const FILE_NAME: &str = "sync-log.jsonl";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Level {
    Info,
    Warn,
    Error,
}

impl Level {
    pub fn as_str(self) -> &'static str {
        match self {
            Level::Info => "info",
            Level::Warn => "warn",
            Level::Error => "error",
        }
    }

    fn parse(s: &str) -> Self {
        match s {
            "warn" => Level::Warn,
            "error" => Level::Error,
            _ => Level::Info,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub at: u64,
    pub level: Level,

    pub event: String,

    pub fields: Vec<(String, String)>,
}

impl Entry {
    pub fn get(&self, key: &str) -> Option<&str> {
        self.fields
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    }
}

#[must_use = "a record does nothing until .emit()"]
pub struct Record {
    level: Level,
    event: &'static str,
    fields: Vec<(String, String)>,
}

impl Record {
    pub fn field(mut self, key: &str, value: impl Display) -> Self {
        self.fields.push((key.to_owned(), value.to_string()));
        self
    }

    pub fn maybe(self, key: &str, value: Option<impl Display>) -> Self {
        match value {
            Some(value) => self.field(key, value),
            None => self,
        }
    }

    pub fn peer(self, id: impl Display, name: impl Display) -> Self {
        let id = id.to_string();
        self.field("peer", short_id(&id)).field("name", name)
    }

    pub fn emit(self) {
        // Warnings and errors also go to the app log, where someone debugging a report looks.
        if self.level != Level::Info {
            let mut line = match self.level {
                Level::Error => crate::log::error(self.event),
                _ => crate::log::warn(self.event),
            };
            for (key, value) in &self.fields {
                line = line.field(key, value);
            }
            line.emit();
        }

        append(Entry {
            at: crate::clock::now_ms(),
            level: self.level,
            event: self.event.to_owned(),
            fields: self.fields,
        });
    }
}

pub fn short_id(id: &str) -> &str {
    id.get(..8).unwrap_or(id)
}

fn record(level: Level, event: &'static str) -> Record {
    Record {
        level,
        event,
        fields: Vec::new(),
    }
}

pub fn info(event: &'static str) -> Record {
    record(Level::Info, event)
}

pub fn warn(event: &'static str) -> Record {
    record(Level::Warn, event)
}

pub fn error(event: &'static str) -> Record {
    record(Level::Error, event)
}

fn append(entry: Entry) {
    jsonl::append(FILE_NAME, encode(&entry));
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
        "level": entry.level.as_str(),
        "event": entry.event,

        "fields": entry
            .fields
            .iter()
            .map(|(k, v)| json!([k, v]))
            .collect::<Vec<_>>(),
    })
    .to_string()
}

fn decode(line: &str) -> Option<Entry> {
    let value: Value = serde_json::from_str(line).ok()?;
    let mut fields: Vec<(String, String)> = Vec::new();
    match value.get("fields") {
        Some(Value::Array(pairs)) => {
            for pair in pairs {
                let key = pair.get(0).and_then(Value::as_str);
                let val = pair.get(1).and_then(Value::as_str);
                if let (Some(key), Some(val)) = (key, val) {
                    fields.push((key.to_owned(), val.to_owned()));
                }
            }
        }

        _ => {
            if let Some(detail) = value.get("detail").and_then(Value::as_str) {
                if !detail.is_empty() {
                    fields.push(("detail".to_owned(), detail.to_owned()));
                }
            }
        }
    }
    Some(Entry {
        at: value.get("at").and_then(Value::as_u64).unwrap_or(0),
        level: value
            .get("level")
            .and_then(Value::as_str)
            .map(Level::parse)
            .unwrap_or(Level::Info),
        event: value.get("event").and_then(Value::as_str)?.to_owned(),
        fields,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(fields: Vec<(&str, &str)>) -> Entry {
        Entry {
            at: 1_720_000_000_000,
            level: Level::Error,
            event: "sync.failed".to_string(),
            fields: fields
                .into_iter()
                .map(|(k, v)| (k.to_owned(), v.to_owned()))
                .collect(),
        }
    }

    #[test]
    fn an_entry_round_trips() {
        let entry = entry(vec![
            ("peer", "2463e975"),
            ("name", "aavsh's PC"),
            ("reason", "version_mismatch"),
        ]);
        assert_eq!(decode(&encode(&entry)), Some(entry));
    }

    #[test]
    fn fields_keep_the_order_they_were_recorded_in() {
        let entry = entry(vec![("peer", "a"), ("zzz", "b"), ("aaa", "c")]);
        let back = decode(&encode(&entry)).expect("an entry");
        let keys: Vec<&str> = back.fields.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(keys, ["peer", "zzz", "aaa"]);
    }

    #[test]
    fn a_value_with_spaces_or_quotes_survives_intact() {
        let entry = entry(vec![("error", r#"connection reset: "peer" went away"#)]);
        assert_eq!(decode(&encode(&entry)), Some(entry));
    }

    #[test]
    fn a_line_that_isnt_ours_is_skipped_not_fatal() {
        for line in ["", "not json", "{}", "[]", r#"{"at": 1}"#] {
            assert_eq!(decode(line), None, "{line:?} decoded");
        }
    }

    #[test]
    fn an_entry_from_before_fields_keeps_its_prose() {
        let entry = decode(r#"{"at":1,"level":"error","event":"sync failed","detail":"Desktop: connection reset"}"#)
            .expect("an entry");
        assert_eq!(entry.event, "sync failed");
        assert_eq!(entry.get("detail"), Some("Desktop: connection reset"));
    }

    #[test]
    fn an_unknown_level_falls_back_to_info_rather_than_dropping_the_entry() {
        let entry = decode(r#"{"event": "peer.connected", "level": "trace"}"#).expect("an entry");
        assert_eq!(entry.level, Level::Info);
        assert_eq!(entry.event, "peer.connected");
    }

    #[test]
    fn a_field_is_absent_rather_than_empty_when_there_was_nothing_to_say() {
        let record = record(Level::Info, "peer.connected")
            .field("peer", "2463e975")
            .maybe("error", None::<String>)
            .maybe("name", Some("Laptop"));
        assert_eq!(
            record.fields,
            vec![
                ("peer".to_string(), "2463e975".to_string()),
                ("name".to_string(), "Laptop".to_string()),
            ],
            "an absent field and an empty one read very differently in a report"
        );
    }

    #[test]
    fn a_peer_is_recorded_by_short_id_and_name_together() {
        let record = record(Level::Info, "peer.connected").peer(
            "2463e9751f0c4a9b8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a392817",
            "Laptop",
        );
        assert_eq!(
            record.fields,
            vec![
                ("peer".to_string(), "2463e975".to_string()),
                ("name".to_string(), "Laptop".to_string()),
            ]
        );
    }

    #[test]
    fn a_short_id_never_panics_on_something_that_isnt_one() {
        assert_eq!(short_id("abc"), "abc");
        assert_eq!(short_id(""), "");
    }

    #[test]
    fn it_lives_beside_the_apps_other_state_not_in_the_notes() {
        let path = jsonl::path(FILE_NAME).expect("a log path");
        assert!(path.ends_with(FILE_NAME), "{path:?}");
        assert_eq!(path.parent(), crate::config::config_dir().as_deref());
    }
}
