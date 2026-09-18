use serde_json::{json, Value};

pub const PROTOCOL_VERSION: &str = "2025-06-18";

const SUPPORTED_VERSIONS: &[&str] = &["2025-06-18", "2025-03-26", "2024-11-05"];

/// The newest version both ends understand, falling back to ours.
pub fn negotiate(requested: Option<&str>) -> &str {
    match requested {
        Some(version) if SUPPORTED_VERSIONS.contains(&version) => version,
        _ => PROTOCOL_VERSION,
    }
}

pub struct RpcError {
    pub code: i64,
    pub message: String,
}

impl RpcError {
    pub fn new(code: i64, message: String) -> Self {
        RpcError { code, message }
    }
}

pub fn result(id: Value, result: Value) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "result": result }).to_string()
}

pub fn error(id: Value, code: i64, message: &str) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }).to_string()
}
