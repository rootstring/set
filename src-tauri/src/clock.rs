use std::time::{SystemTime, UNIX_EPOCH};

/// Milliseconds since the Unix epoch, the clock `updatedAt` and every log line use.
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
