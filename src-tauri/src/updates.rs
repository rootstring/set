use std::sync::Mutex;

use tauri::{AppHandle, Emitter, State, Url};
use tauri_plugin_updater::{Update, UpdaterExt};

/// A `latest.json` you serve yourself, to exercise offer, download, signature check, install and
/// restart without cutting a release. Plain http is allowed under `tauri dev` only.
const FEED_ENV: &str = "SET_UPDATE_FEED";

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Available {
    pub version: String,

    pub current_version: String,

    pub notes: Option<String>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    downloaded: u64,

    total: Option<u64>,
}

#[derive(Default)]
pub struct Updates {
    pending: Mutex<Option<Update>>,
}

#[tauri::command]
pub async fn update_check(
    app: AppHandle,
    updates: State<'_, Updates>,
) -> Result<Option<Available>, String> {
    let mut builder = app.updater_builder();
    if let Ok(feed) = std::env::var(FEED_ENV) {
        let url: Url = feed
            .parse()
            .map_err(|_| format!("{FEED_ENV} is not a URL: {feed}"))?;
        builder = builder.endpoints(vec![url]).map_err(|e| e.to_string())?;
    }

    let found = builder
        .build()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .inspect_err(|err| {
            crate::log::warn("update.check_failed")
                .field("error", err)
                .emit();
        })
        .map_err(|e| e.to_string())?;

    let available = found.as_ref().map(|update| Available {
        version: update.version.clone(),
        current_version: update.current_version.clone(),
        notes: update.body.clone(),
    });
    crate::log::info("update.checked")
        .field("current", env!("CARGO_PKG_VERSION"))
        .maybe("available", available.as_ref().map(|u| &u.version))
        .emit();

    *updates.pending.lock().unwrap() = found;
    Ok(available)
}

#[tauri::command]
pub async fn update_install(app: AppHandle, updates: State<'_, Updates>) -> Result<(), String> {
    let update = updates
        .pending
        .lock()
        .unwrap()
        .clone()
        .ok_or("no update to install")?;

    crate::log::info("update.installing")
        .field("version", &update.version)
        .emit();

    let mut downloaded: u64 = 0;
    let progress_app = app.clone();
    let started = std::time::Instant::now();
    update
        .download_and_install(
            move |chunk, total| {
                downloaded += chunk as u64;
                let _ = progress_app.emit("update:progress", Progress { downloaded, total });
            },
            || {},
        )
        .await
        .inspect(|()| crate::log::info("update.installed").elapsed(started).emit())
        // A bundle whose signature fails is refused silently by the plugin; this is the only place
        // that says so.
        .inspect_err(|err| {
            crate::log::error("update.install_failed")
                .field("error", err)
                .emit();
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_restart(app: AppHandle) {
    // So the `app.started` after it reads as an update, not a crash.
    crate::log::info("app.restarting").emit();
    app.restart();
}
