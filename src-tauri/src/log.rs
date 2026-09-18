//! The app's own plain-text log, in the OS log location, for debugging reports. Never anything
//! somebody wrote: no page text, dictation or search queries.

use std::fmt::Display;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const FILE_NAME: &str = "set.log";

/// A megabyte is weeks of ordinary use and still attachable to an email.
const MAX_BYTES: u64 = 1 << 20;

/// Covers the size check and the append together, so two threads cannot both rotate.
static WRITING: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Level {
    Info,
    Warn,
    Error,
}

impl Level {
    /// Padded, so the events line up down the page when you read it.
    fn as_str(self) -> &'static str {
        match self {
            Level::Info => "INFO ",
            Level::Warn => "WARN ",
            Level::Error => "ERROR",
        }
    }
}

/// Linux: `$XDG_STATE_HOME`, per the XDG spec (Tauri's `app_log_dir` puts them beside config).
pub fn log_dir() -> Option<PathBuf> {
    let app = crate::config::app_dir_name();
    if cfg!(target_os = "windows") {
        let local = std::env::var_os("LOCALAPPDATA")?;
        return Some(PathBuf::from(local).join(app).join("logs"));
    }
    if cfg!(target_os = "macos") {
        return Some(
            crate::config::home_dir()?
                .join("Library")
                .join("Logs")
                .join(app),
        );
    }
    let state = match std::env::var_os("XDG_STATE_HOME").map(PathBuf::from) {
        Some(path) if path.is_absolute() => path,
        _ => crate::config::home_dir()?.join(".local").join("state"),
    };
    Some(state.join(app).join("logs"))
}

pub fn log_file() -> Option<PathBuf> {
    Some(log_dir()?.join(FILE_NAME))
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

fn record(level: Level, event: &'static str) -> Record {
    Record {
        level,
        event,
        fields: Vec::new(),
    }
}

/// Mirrors `sync::log::Record` on purpose.
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

    pub fn elapsed(self, since: std::time::Instant) -> Self {
        self.field("ms", since.elapsed().as_millis())
    }

    pub fn emit(self) {
        let line = format(crate::clock::now_ms(), self.level, self.event, &self.fields);

        // `tauri dev` has a terminal; a release build has a log file.
        if cfg!(debug_assertions) {
            eprint!("{line}");
        }
        // Not in this crate's tests, which run against the real home directory. `append_to` is
        // tested against a temp dir.
        if cfg!(test) {
            return;
        }
        if let Some(path) = log_file() {
            append_to(&path, &line, MAX_BYTES);
        }
    }
}

/// Before anything else: a panic on a worker thread is otherwise silent.
pub fn init() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |panic| {
        error("app.panicked")
            .field(
                "thread",
                std::thread::current()
                    .name()
                    .unwrap_or("unnamed")
                    .to_owned(),
            )
            .maybe(
                "at",
                panic
                    .location()
                    .map(|at| format!("{}:{}", at.file(), at.line())),
            )
            .field("message", panic_message(panic))
            .emit();
        previous(panic);
    }));

    info("app.started")
        .field("version", env!("CARGO_PKG_VERSION"))
        .field("os", std::env::consts::OS)
        .field("arch", std::env::consts::ARCH)
        .field("dictation", cfg!(feature = "dictation"))
        .emit();
}

fn panic_message(panic: &std::panic::PanicHookInfo<'_>) -> String {
    let payload = panic.payload();
    if let Some(text) = payload.downcast_ref::<&str>() {
        return (*text).to_owned();
    }
    if let Some(text) = payload.downcast_ref::<String>() {
        return text.clone();
    }
    "panicked".to_owned()
}

/// logfmt: `2026-09-18T14:02:11.482Z INFO  notes.granted path="/Users/x/My Notes"`
fn format(at: u64, level: Level, event: &str, fields: &[(String, String)]) -> String {
    let mut line = format!("{} {} {event}", timestamp(at), level.as_str());
    for (key, value) in fields {
        line.push(' ');
        line.push_str(key);
        line.push('=');
        line.push_str(&quote(value));
    }
    line.push('\n');
    line
}

fn quote(value: &str) -> String {
    let plain = !value.is_empty()
        && !value
            .chars()
            .any(|c| c.is_whitespace() || c == '"' || c == '=' || c == '\\' || c.is_control());
    if plain {
        return value.to_owned();
    }
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for c in value.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            // Anything else that would break the line into two.
            c if c.is_control() => out.push('?'),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// UTC: lines get compared against releases, servers and the other device.
fn timestamp(ms: u64) -> String {
    let (seconds, millis) = (ms / 1000, ms % 1000);
    let (days, time) = ((seconds / 86_400) as i64, seconds % 86_400);
    let (year, month, day) = civil_from_days(days);
    let (hour, minute, second) = (time / 3600, (time / 60) % 60, time % 60);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

/// Howard Hinnant's `civil_from_days`.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    // Epoch shifted to 0000-03-01 so the leap day is at the end of the year.
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_position = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * month_position + 2) / 5 + 1) as u32;
    let month = if month_position < 10 {
        month_position + 3
    } else {
        month_position - 9
    } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

/// Every failure is swallowed: no log should stop somebody taking notes.
fn append_to(path: &Path, line: &str, max_bytes: u64) {
    let _held = WRITING
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(dir) = path.parent() {
        if fs::create_dir_all(dir).is_err() {
            return;
        }
    }
    rotate_if_full(path, max_bytes);
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = file.write_all(line.as_bytes());
    }
}

fn rotate_if_full(path: &Path, max_bytes: u64) {
    let full = fs::metadata(path).is_ok_and(|meta| meta.len() >= max_bytes);
    if !full {
        return;
    }
    if let Some(previous) = previous_of(path) {
        let _ = fs::rename(path, previous);
    }
}

fn previous_of(path: &Path) -> Option<PathBuf> {
    let name = path.file_name()?.to_str()?;
    Some(path.with_file_name(format!("{name}.1")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::TempDir;

    fn line(level: Level, event: &str, fields: &[(&str, &str)]) -> String {
        let fields: Vec<(String, String)> = fields
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect();
        format(1_758_204_131_482, level, event, &fields)
    }

    #[test]
    fn a_line_leads_with_when_and_how_bad_it_is() {
        assert_eq!(
            line(Level::Info, "app.started", &[("version", "0.0.1")]),
            "2025-09-18T14:02:11.482Z INFO  app.started version=0.0.1\n"
        );
        assert_eq!(
            line(Level::Error, "sync.failed", &[]),
            "2025-09-18T14:02:11.482Z ERROR sync.failed\n"
        );
    }

    #[test]
    fn a_value_with_a_space_in_it_stays_one_field() {
        assert_eq!(
            line(
                Level::Warn,
                "notes.refused",
                &[("path", "/Users/x/My Notes")]
            ),
            "2025-09-18T14:02:11.482Z WARN  notes.refused path=\"/Users/x/My Notes\"\n"
        );
    }

    #[test]
    fn nothing_a_value_contains_can_forge_a_second_line() {
        let forged = line(
            Level::Error,
            "page.write_failed",
            &[("error", "denied\n2026-01-01T00:00:00.000Z INFO  all.well")],
        );
        assert_eq!(forged.lines().count(), 1, "{forged:?}");
        assert!(
            forged.contains(r#"error="denied\n2026-01-01"#),
            "{forged:?}"
        );
    }

    #[test]
    fn quoting_covers_what_would_blur_a_field() {
        assert_eq!(quote("plain"), "plain");
        assert_eq!(quote("/Users/x/Notes"), "/Users/x/Notes");
        assert_eq!(quote(""), r#""""#);
        assert_eq!(quote("two words"), r#""two words""#);
        assert_eq!(quote(r#"say "hi""#), r#""say \"hi\"""#);
        assert_eq!(quote(r"C:\Notes"), r#""C:\\Notes""#);
        assert_eq!(quote("a=b"), r#""a=b""#);
        assert_eq!(quote("bell\u{7}"), r#""bell?""#);
    }

    #[test]
    fn the_clock_agrees_with_dates_that_are_easy_to_check() {
        assert_eq!(timestamp(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(timestamp(86_399_999), "1970-01-01T23:59:59.999Z");
        assert_eq!(timestamp(86_400_000), "1970-01-02T00:00:00.000Z");
        // A leap day, and the century that isn't one.
        assert_eq!(timestamp(951_782_400_000), "2000-02-29T00:00:00.000Z");
        assert_eq!(timestamp(1_767_225_600_000), "2026-01-01T00:00:00.000Z");
    }

    #[test]
    fn lines_land_in_the_file_in_the_order_they_were_written() {
        let dir = TempDir::new("log");
        let path = dir.0.join("set.log");
        append_to(&path, "first\n", MAX_BYTES);
        append_to(&path, "second\n", MAX_BYTES);
        assert_eq!(dir.read("set.log").as_deref(), Some("first\nsecond\n"));
    }

    #[test]
    fn a_missing_log_folder_is_made_rather_than_a_reason_to_give_up() {
        let dir = TempDir::new("log");
        let path = dir.0.join("logs").join("set.log");
        append_to(&path, "hello\n", MAX_BYTES);
        assert_eq!(fs::read_to_string(&path).ok().as_deref(), Some("hello\n"));
    }

    #[test]
    fn a_full_log_is_rotated_and_the_previous_one_kept() {
        let dir = TempDir::new("log");
        let path = dir.0.join("set.log");

        append_to(&path, "old\n", 8);
        append_to(&path, "new\n", 8);
        assert_eq!(dir.read("set.log").as_deref(), Some("old\nnew\n"));

        append_to(&path, "newest\n", 8);
        assert_eq!(dir.read("set.log").as_deref(), Some("newest\n"));
        assert_eq!(dir.read("set.log.1").as_deref(), Some("old\nnew\n"));
    }

    #[test]
    fn only_one_previous_log_is_ever_kept() {
        let dir = TempDir::new("log");
        let path = dir.0.join("set.log");
        for line in ["one\n", "two\n", "three\n"] {
            append_to(&path, line, 1);
        }
        assert_eq!(dir.read("set.log").as_deref(), Some("three\n"));
        assert_eq!(dir.read("set.log.1").as_deref(), Some("two\n"));
        assert!(dir.read("set.log.1.1").is_none());
    }

    #[test]
    fn a_log_that_cant_be_written_is_not_a_crash() {
        let dir = TempDir::new("log");
        // A file where the folder would have to be.
        let blocked = dir.write("busy", "not a directory").join("set.log");
        append_to(&blocked, "nowhere to go\n", MAX_BYTES);
    }

    #[test]
    fn the_log_sits_where_the_os_keeps_logs_not_with_our_state() {
        let path = log_file().expect("a log path");
        assert!(path.is_absolute(), "{path:?}");
        assert!(path.ends_with(FILE_NAME), "{path:?}");

        let dir = path.parent().expect("a log folder");
        assert!(
            dir.ends_with(crate::config::app_dir_name()) || dir.ends_with("logs"),
            "{dir:?}"
        );
        assert_ne!(
            Some(dir),
            crate::config::config_dir().as_deref(),
            "the app log landed in the config folder"
        );

        #[cfg(target_os = "macos")]
        assert!(
            dir.starts_with(
                crate::config::home_dir()
                    .unwrap()
                    .join("Library")
                    .join("Logs")
            ),
            "{dir:?}"
        );
    }
}
