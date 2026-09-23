pub mod model;

#[cfg(feature = "dictation")]
mod audio;
#[cfg(feature = "dictation")]
mod engine;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

const UNAVAILABLE: &str = "This build of Set was made without dictation.";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    Idle,

    Downloading,
    Recording,
    Transcribing,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub available: bool,
    pub phase: Phase,

    pub model_installed: bool,

    pub model_path: Option<String>,

    pub model_bytes: u64,

    pub model_memory_bytes: u64,

    pub model_label: &'static str,
    pub model_parameters: &'static str,

    pub downloaded: u64,

    pub last_error: Option<String>,
}

#[derive(Clone)]
pub struct Dictation(Arc<Inner>);

struct Inner {
    app: AppHandle,

    dir: PathBuf,
    phase: Mutex<Phase>,
    downloaded: Mutex<u64>,
    last_error: Mutex<Option<String>>,

    cancel_download: AtomicBool,

    #[cfg(feature = "dictation")]
    recorder: Mutex<Option<audio::Recorder>>,
}

impl Dictation {
    pub fn new(app: AppHandle) -> Self {
        let dir = app
            .path()
            .app_local_data_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join("models");
        Self(Arc::new(Inner {
            app,
            dir,
            phase: Mutex::new(Phase::Idle),
            downloaded: Mutex::new(0),
            last_error: Mutex::new(None),
            cancel_download: AtomicBool::new(false),
            #[cfg(feature = "dictation")]
            recorder: Mutex::new(None),
        }))
    }
}

impl Inner {
    fn model_path(&self) -> PathBuf {
        model::path_in(&self.dir)
    }

    fn usable_model(&self) -> Option<PathBuf> {
        model::usable_in(&self.dir)
    }

    fn status(&self) -> Status {
        let usable = self.usable_model();
        let path = usable.clone().unwrap_or_else(|| self.model_path());
        Status {
            available: cfg!(feature = "dictation"),
            phase: *self.phase.lock().unwrap(),

            model_installed: usable.is_some(),
            model_path: Some(path.to_string_lossy().into_owned()),
            model_bytes: model::BYTES,
            model_memory_bytes: model::MEMORY_BYTES,
            model_label: model::LABEL,
            model_parameters: model::PARAMETERS,
            downloaded: *self.downloaded.lock().unwrap(),
            last_error: self.last_error.lock().unwrap().clone(),
        }
    }

    fn publish(&self) {
        let _ = self.app.emit("dictation:status", self.status());
    }

    fn set_phase(&self, phase: Phase) {
        *self.phase.lock().unwrap() = phase;
        self.publish();
    }

    fn fail(&self, message: impl Into<String>) -> String {
        let message = message.into();
        // Every dictation failure comes through here.
        crate::log::warn("dictation.failed")
            .field(
                "phase",
                format!("{:?}", *self.phase.lock().unwrap()).to_lowercase(),
            )
            .field("error", &message)
            .emit();
        *self.last_error.lock().unwrap() = Some(message.clone());
        *self.phase.lock().unwrap() = Phase::Idle;
        self.publish();
        message
    }

    fn clear_error(&self) {
        *self.last_error.lock().unwrap() = None;
    }
}

#[tauri::command]
pub fn dictation_status(state: State<Dictation>) -> Status {
    state.0.status()
}

#[tauri::command]
pub fn dictation_download_model(state: State<Dictation>) -> Result<(), String> {
    download_model(state.0.clone())
}

impl Dictation {
    pub fn upgrade_model(&self) {
        let inner = &self.0;
        if !cfg!(feature = "dictation") || !model::previous_installed(&inner.dir) {
            return;
        }
        if model::is_installed(&inner.model_path()) {
            remove_previous_model(inner);
            return;
        }
        crate::log::info("dictation.model_upgrade")
            .field("from", model::previous::FILE)
            .field("to", model::FILE)
            .emit();
        let _ = download_model(inner.clone());
    }
}

fn remove_previous_model(inner: &Inner) {
    let path = model::previous_path_in(&inner.dir);
    if let Err(e) = std::fs::remove_file(&path) {
        if e.kind() != std::io::ErrorKind::NotFound {
            crate::log::warn("dictation.previous_model_kept")
                .field("error", e.to_string())
                .emit();
        }
    }
}

fn download_model(inner: Arc<Inner>) -> Result<(), String> {
    if !cfg!(feature = "dictation") {
        return Err(UNAVAILABLE.into());
    }
    if *inner.phase.lock().unwrap() != Phase::Idle {
        return Err("Dictation is already busy".into());
    }
    inner.clear_error();
    inner.cancel_download.store(false, Ordering::Relaxed);
    *inner.downloaded.lock().unwrap() = 0;
    inner.set_phase(Phase::Downloading);

    std::thread::spawn(move || {
        crate::log::info("dictation.download_started")
            .field("model", model::FILE)
            .field("bytes", model::BYTES)
            .emit();
        let started = std::time::Instant::now();
        let result = model::download(&inner.dir, &inner.cancel_download, |bytes| {
            *inner.downloaded.lock().unwrap() = bytes;
            inner.publish();
        });
        *inner.downloaded.lock().unwrap() = 0;
        match result {
            Ok(()) => {
                crate::log::info("dictation.downloaded")
                    .elapsed(started)
                    .emit();
                remove_previous_model(&inner);
                inner.set_phase(Phase::Idle)
            }

            Err(model::DownloadError::Cancelled) => {
                crate::log::info("dictation.download_cancelled").emit();
                inner.set_phase(Phase::Idle)
            }
            Err(e) => {
                inner.fail(e.to_string());
            }
        }
    });
    Ok(())
}

#[tauri::command]
pub fn dictation_cancel_download(state: State<Dictation>) {
    state.0.cancel_download.store(true, Ordering::Relaxed);
}

#[tauri::command]
pub fn dictation_delete_model(state: State<Dictation>) -> Result<(), String> {
    let inner = &state.0;
    for path in [inner.model_path(), model::previous_path_in(&inner.dir)] {
        if path.exists() {
            std::fs::remove_file(&path).map_err(|e| inner.fail(format!("Couldn't delete: {e}")))?;
        }
    }
    inner.clear_error();
    inner.publish();
    Ok(())
}

#[tauri::command]
pub fn dictation_start(state: State<Dictation>) -> Result<(), String> {
    let inner = state.0.clone();
    if *inner.phase.lock().unwrap() != Phase::Idle {
        return Err("Dictation is already busy".into());
    }
    if inner.usable_model().is_none() {
        return Err(inner.fail("The dictation model isn't downloaded yet."));
    }
    start_recording(&inner)?;
    inner.clear_error();
    inner.set_phase(Phase::Recording);
    Ok(())
}

#[tauri::command]
pub fn dictation_stop(state: State<Dictation>, language: Option<String>) -> Result<(), String> {
    let inner = state.0.clone();
    if *inner.phase.lock().unwrap() != Phase::Recording {
        return Err("Nothing is being dictated".into());
    }
    finish_recording(&inner, language)
}

#[tauri::command]
pub fn dictation_cancel(state: State<Dictation>) {
    let inner = state.0.clone();
    if *inner.phase.lock().unwrap() != Phase::Recording {
        return;
    }
    discard_recording(&inner);
    inner.clear_error();
    inner.set_phase(Phase::Idle);
}

#[cfg(feature = "dictation")]
fn start_recording(inner: &Arc<Inner>) -> Result<(), String> {
    let recorder = audio::Recorder::start(inner.app.clone()).map_err(|e| inner.fail(e))?;
    *inner.recorder.lock().unwrap() = Some(recorder);
    Ok(())
}

#[cfg(feature = "dictation")]
fn finish_recording(inner: &Arc<Inner>, language: Option<String>) -> Result<(), String> {
    let Some(recorder) = inner.recorder.lock().unwrap().take() else {
        return Err(inner.fail("The microphone was already closed"));
    };
    inner.set_phase(Phase::Transcribing);

    let inner = inner.clone();
    std::thread::spawn(move || {
        let audio = recorder.finish();

        if audio.len() < audio::SAMPLE_RATE as usize / 4 {
            inner.fail("That was too short to make out.");
            return;
        }
        let started = std::time::Instant::now();
        let Some(model) = inner.usable_model() else {
            inner.fail("The dictation model isn't downloaded yet.");
            return;
        };
        match engine::transcribe(&model, &audio, language.as_deref()) {
            Ok(text) if text.is_empty() => {
                inner.fail("Nothing was picked up. Check the microphone.");
            }
            Ok(text) => {
                // Never the words themselves.
                crate::log::info("dictation.transcribed")
                    .field("seconds", audio.len() / audio::SAMPLE_RATE as usize)
                    .field("chars", text.len())
                    .elapsed(started)
                    .emit();
                inner.set_phase(Phase::Idle);
                let _ = inner
                    .app
                    .emit("dictation:text", serde_json::json!({ "text": text }));
            }
            Err(e) => {
                inner.fail(e);
            }
        }
    });
    Ok(())
}

#[cfg(feature = "dictation")]
fn discard_recording(inner: &Arc<Inner>) {
    let Some(recorder) = inner.recorder.lock().unwrap().take() else {
        return;
    };

    std::thread::spawn(move || drop(recorder.finish()));
}

#[cfg(not(feature = "dictation"))]
fn start_recording(inner: &Arc<Inner>) -> Result<(), String> {
    Err(inner.fail(UNAVAILABLE))
}

#[cfg(not(feature = "dictation"))]
fn finish_recording(inner: &Arc<Inner>, _language: Option<String>) -> Result<(), String> {
    Err(inner.fail(UNAVAILABLE))
}

#[cfg(not(feature = "dictation"))]
fn discard_recording(_inner: &Arc<Inner>) {}
