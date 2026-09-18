use std::ffi::{c_char, c_void, CStr};
use std::path::Path;
use std::sync::Once;

use whisper_rs::whisper_rs_sys::{ggml_log_level, ggml_log_set, whisper_log_set};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

/// bindgen spells C enum variants in C style; a constant in a pattern must be upper case.
mod ggml {
    use whisper_rs::whisper_rs_sys as sys;

    pub const WARN: sys::ggml_log_level = sys::ggml_log_level_GGML_LOG_LEVEL_WARN;
    pub const ERROR: sys::ggml_log_level = sys::ggml_log_level_GGML_LOG_LEVEL_ERROR;

    #[cfg(test)]
    pub const NONE: sys::ggml_log_level = sys::ggml_log_level_GGML_LOG_LEVEL_NONE;
    #[cfg(test)]
    pub const DEBUG: sys::ggml_log_level = sys::ggml_log_level_GGML_LOG_LEVEL_DEBUG;
    #[cfg(test)]
    pub const INFO: sys::ggml_log_level = sys::ggml_log_level_GGML_LOG_LEVEL_INFO;
    #[cfg(test)]
    pub const CONT: sys::ggml_log_level = sys::ggml_log_level_GGML_LOG_LEVEL_CONT;
}

pub fn transcribe(model: &Path, audio: &[f32], language: Option<&str>) -> Result<String, String> {
    if !model.is_file() {
        return Err("The dictation model isn't downloaded yet.".into());
    }
    hush();

    let mut ctx_params = WhisperContextParameters::default();

    ctx_params.use_gpu(true);

    let ctx = WhisperContext::new_with_params(model, ctx_params)
        .map_err(|e| format!("Couldn't load the dictation model: {e}"))?;
    let mut state = ctx
        .create_state()
        .map_err(|e| format!("Couldn't start transcribing: {e}"))?;

    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_n_threads(threads());

    params.set_translate(false);

    params.set_language(Some(language.unwrap_or("auto")));

    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);

    params.set_no_timestamps(true);

    params.set_suppress_blank(true);
    params.set_suppress_nst(true);

    state
        .full(params, audio)
        .map_err(|e| format!("Couldn't transcribe: {e}"))?;

    let mut text = String::new();
    for segment in state.as_iter() {
        if let Ok(part) = segment.to_str_lossy() {
            text.push_str(&part);
        }
    }
    Ok(clean(&text))
}

/// Both libraries spam stderr, which a bundled app sends to the system log. Keep only what went
/// wrong. Global hook, so `Once`.
fn hush() {
    static INSTALLED: Once = Once::new();
    INSTALLED.call_once(|| unsafe {
        whisper_log_set(Some(relay), std::ptr::null_mut());
        ggml_log_set(Some(relay), std::ptr::null_mut());
    });
}

/// Called by C on whisper's thread: must not panic.
unsafe extern "C" fn relay(level: ggml_log_level, text: *const c_char, _user_data: *mut c_void) {
    let Some(level) = kept(level) else { return };
    if text.is_null() {
        return;
    }
    // SAFETY: ggml hands its callbacks a NUL-terminated string that lives for
    // the length of the call, and this copies it before returning.
    let message = unsafe { CStr::from_ptr(text) }.to_string_lossy();
    let message = message.trim();
    if message.is_empty() {
        return;
    }
    let event = "dictation.whisper";
    match level {
        crate::log::Level::Error => crate::log::error(event).field("message", message).emit(),
        _ => crate::log::warn(event).field("message", message).emit(),
    }
}

/// `GGML_LOG_LEVEL_CONT` is the tail of a split line; ggml never splits errors.
fn kept(level: ggml_log_level) -> Option<crate::log::Level> {
    match level {
        ggml::ERROR => Some(crate::log::Level::Error),
        ggml::WARN => Some(crate::log::Level::Warn),
        _ => None,
    }
}

fn clean(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn threads() -> std::os::raw::c_int {
    let cores = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4);
    cores.saturating_sub(1).clamp(1, 8) as std::os::raw::c_int
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn segment_joins_do_not_leave_double_spaces() {
        assert_eq!(
            clean(" Hello there.  And then this."),
            "Hello there. And then this."
        );
    }

    #[test]
    fn newlines_between_segments_collapse() {
        assert_eq!(clean("One.\n\n Two."), "One. Two.");
    }

    #[test]
    fn nothing_said_is_nothing_inserted() {
        assert_eq!(clean("   \n "), "");
    }

    #[test]
    fn whisper_cpps_running_commentary_is_dropped_and_its_failures_kept() {
        for quiet in [ggml::NONE, ggml::INFO, ggml::DEBUG, ggml::CONT] {
            assert_eq!(kept(quiet), None, "level {quiet} was logged");
        }
        assert_eq!(kept(ggml::WARN), Some(crate::log::Level::Warn));
        assert_eq!(kept(ggml::ERROR), Some(crate::log::Level::Error));
    }

    #[test]
    fn at_least_one_thread_is_always_used() {
        assert!(threads() >= 1);
        assert!(threads() <= 8);
    }
}
