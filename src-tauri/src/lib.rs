use tauri::{
    menu::{AboutMetadata, Menu, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu},
    Emitter, Manager,
};

#[cfg(target_os = "macos")]
use tauri::WindowEvent;
use tauri_plugin_fs::FsExt;

mod clock;
pub mod config;
pub mod dictation;
mod hex;
pub mod index;
pub mod jsonl;
pub mod log;
pub mod mcp;
mod page_id;
pub mod paths;
pub mod root;
pub mod scan;
pub mod sync;
pub mod updates;
pub mod watch;
mod write;

#[cfg(test)]
mod testing;

#[tauri::command]
fn mcp_access() -> serde_json::Value {
    let access = mcp::access::read();
    serde_json::json!({
        "enabled": access.enabled,

        "mode": access.mode.as_str(),

        "allowedContexts": access.allowed_contexts,
        "file": mcp::access::access_file().map(|p| p.to_string_lossy().into_owned()),
        "binary": mcp_binary().map(|p| p.to_string_lossy().into_owned()),
    })
}

/// From Rust, not the user agent: WebKit on Apple Silicon still claims to be an Intel Mac.
#[tauri::command]
fn platform() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Some("macos-silicon"),
        ("macos", "x86_64") => Some("macos-intel"),
        ("windows", _) => Some("windows"),
        ("linux", "x86_64") => Some("linux-x64"),
        ("linux", "aarch64") => Some("linux-arm"),
        _ => None,
    }
}

#[tauri::command]
fn mcp_activity() -> Vec<serde_json::Value> {
    mcp::log::read()
        .into_iter()
        .map(|entry| {
            serde_json::json!({
                "at": entry.at,
                "tool": entry.tool,
                "detail": entry.detail,
                "results": entry.results,
            })
        })
        .collect()
}

#[tauri::command]
fn clear_mcp_activity() -> Result<(), String> {
    mcp::log::clear()
}

fn mcp_binary() -> Option<std::path::PathBuf> {
    let name = if cfg!(target_os = "windows") {
        "set-mcp.exe"
    } else {
        "set-mcp"
    };
    let beside = std::env::current_exe().ok()?.parent()?.join(name);
    if !beside.is_file() {
        return None;
    }

    if std::env::var_os("APPIMAGE").is_some() {
        return stable_copy_of(&beside, name);
    }
    Some(beside)
}

fn stable_copy_of(source: &std::path::Path, name: &str) -> Option<std::path::PathBuf> {
    let dir = config::config_dir()?;
    std::fs::create_dir_all(&dir).ok()?;
    let dest = dir.join(name);
    if !is_copy_of(&dest, source) {
        std::fs::copy(source, &dest).ok()?;
    }
    Some(dest)
}

fn is_copy_of(dest: &std::path::Path, source: &std::path::Path) -> bool {
    let (Ok(dest), Ok(source)) = (dest.metadata(), source.metadata()) else {
        return false;
    };
    if dest.len() != source.len() {
        return false;
    }
    match (dest.modified(), source.modified()) {
        (Ok(dest), Ok(source)) => source <= dest,

        _ => false,
    }
}

#[tauri::command]
fn set_mcp_access(
    enabled: bool,
    notes_dir: String,
    allowed_contexts: Option<Vec<String>>,
    mode: Option<String>,
) -> Result<String, String> {
    let access = mcp::access::Access {
        enabled,
        mode: match mode.as_deref() {
            Some("write") => mcp::access::Mode::Write,
            _ => mcp::access::Mode::Read,
        },
        notes_dir: Some(std::path::PathBuf::from(notes_dir)),
        allowed_contexts,
    };
    mcp::access::write(&access)
        .inspect(|_| {
            log::info("mcp.access")
                .field("enabled", enabled)
                .field("mode", access.mode.as_str())
                .maybe(
                    "contexts",
                    access.allowed_contexts.as_ref().map(|list| list.len()),
                )
                .emit();
        })
        .inspect_err(|err| log::error("mcp.access_failed").field("error", err).emit())
        .map(|path| path.to_string_lossy().into_owned())
}

#[tauri::command]
fn mcp_follow_notes_dir(notes_dir: String) -> Result<bool, String> {
    let notes_dir = std::path::Path::new(&notes_dir);
    if !notes_dir.is_absolute() {
        return Err("a notes folder has to be an absolute path".to_string());
    }
    mcp::access::follow_notes_dir(notes_dir)
}

#[tauri::command]
fn autostart_enabled(app: tauri::AppHandle) -> bool {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[tauri::command]
fn set_autostart(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let launcher = app.autolaunch();
    if enabled {
        launcher.enable()
    } else {
        launcher.disable()
    }
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn grant_notes_dir(
    app: tauri::AppHandle,
    notes_root: tauri::State<'_, root::NotesRoot>,
    watch: tauri::State<'_, watch::Watch>,
    path: String,
) -> Result<(), String> {
    let granted = root::policy(&path).inspect_err(|err| {
        log::warn("notes.refused")
            .field("path", &path)
            .field("error", err)
            .emit();
    })?;
    app.fs_scope()
        .allow_directory(&granted, true)
        .map_err(|e| e.to_string())?;
    app.asset_protocol_scope()
        .allow_directory(&granted, true)
        .map_err(|e| e.to_string())?;
    notes_root.set(granted.clone());

    log::info("notes.granted")
        .field("path", granted.display())
        .emit();

    watch.retarget(&granted);
    Ok(())
}

#[tauri::command]
fn set_menu_shortcut(
    app: tauri::AppHandle,
    id: String,
    label: Option<String>,
    accelerator: Option<String>,
) -> Result<(), String> {
    let menu = app.menu().ok_or("no application menu")?;
    let item = find_menu_item(&menu, &id).ok_or_else(|| format!("no menu item {id:?}"))?;
    if let Some(label) = label {
        item.set_text(label).map_err(|e| e.to_string())?;
    }
    item.set_accelerator(accelerator.as_deref())
        .map_err(|e| e.to_string())
}

/// Unlike `set_menu_shortcut`, leaves the accelerator alone (`check_updates` has none).
#[tauri::command]
fn set_menu_label(app: tauri::AppHandle, id: String, label: String) -> Result<(), String> {
    let menu = app.menu().ok_or("no application menu")?;
    let item = find_menu_item(&menu, &id).ok_or_else(|| format!("no menu item {id:?}"))?;
    item.set_text(label).map_err(|e| e.to_string())
}

/// Handled natively, not in the webview: the webview may be what is misbehaving.
fn reveal_log<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use tauri_plugin_opener::OpenerExt;

    let Some(path) = log::log_file() else { return };
    if let Err(err) = app.opener().reveal_item_in_dir(&path) {
        log::warn("log.reveal_failed")
            .field("path", path.display())
            .field("error", err)
            .emit();
    }
}

fn find_menu_item<R: tauri::Runtime>(menu: &Menu<R>, id: &str) -> Option<MenuItem<R>> {
    for kind in menu.items().ok()? {
        let MenuItemKind::Submenu(submenu) = kind else {
            continue;
        };
        for child in submenu.items().ok()? {
            if let MenuItemKind::MenuItem(item) = child {
                if item.id().as_ref() == id {
                    return Some(item);
                }
            }
        }
    }
    None
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // First, so a panic during builder setup is written down.
    log::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::all()
                        .difference(tauri_plugin_window_state::StateFlags::FULLSCREEN),
                )
                .build(),
        )
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(index::SearchIndex::default())
        .manage(root::NotesRoot::default())
        .setup(|app| {
            app.manage(sync::Sync::new(app.handle().clone()));

            app.manage(watch::Watch::new(app.handle().clone()));

            app.manage(dictation::Dictation::new(app.handle().clone()));

            app.manage(updates::Updates::default());

            // Linux adds a desktop title bar and a GTK menu bar (~70px); Titlebar.svelte and the
            // frontend keymap replace both.
            #[cfg(target_os = "linux")]
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.remove_menu();
                let _ = window.set_decorations(false);
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            grant_notes_dir,
            scan::scan_notes,
            write::write_page,
            write::merge_note,
            index::search_notes,
            index::page_backlinks,
            platform,
            mcp_access,
            set_mcp_access,
            mcp_follow_notes_dir,
            mcp_activity,
            clear_mcp_activity,
            autostart_enabled,
            set_autostart,
            set_menu_shortcut,
            set_menu_label,
            sync::sync_status,
            sync::sync_set_enabled,
            sync::sync_set_notes_dir,
            sync::sync_forget_notes,
            sync::sync_regenerate_pairing_code,
            sync::sync_answer_pair,
            sync::sync_pair,
            sync::sync_unpair,
            sync::sync_now,
            sync::sync_answer_preview,
            sync::sync_preview_diff,
            sync::sync_log_read,
            sync::sync_log_clear,
            dictation::dictation_status,
            dictation::dictation_download_model,
            dictation::dictation_cancel_download,
            dictation::dictation_delete_model,
            dictation::dictation_start,
            dictation::dictation_stop,
            dictation::dictation_cancel,
            updates::update_check,
            updates::update_install,
            updates::update_restart
        ])
        .on_window_event(|window, event| {
            #[cfg(target_os = "macos")]
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (window, event);
        })
        .menu(build_menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "new_page" => {
                let _ = app.emit("menu:new-page", ());
            }
            "quick_switcher" => {
                let _ = app.emit("menu:quick-switcher", ());
            }
            "open_notes_folder" => {
                let _ = app.emit("menu:open-notes-folder", ());
            }
            "settings" => {
                let _ = app.emit("menu:settings", ());
            }
            "check_updates" => {
                let _ = app.emit("menu:check-updates", ());
            }
            "setup_guide" => {
                let _ = app.emit("menu:setup-guide", ());
            }
            "feedback" => {
                let _ = app.emit("menu:feedback", ());
            }
            "support" => {
                let _ = app.emit("menu:support", ());
            }
            "show_log" => reveal_log(app),
            "chroot" => {
                let _ = app.emit("menu:chroot", ());
            }
            "reload" => {
                let _ = app.emit("menu:reload", ());
            }
            "undo" => {
                let _ = app.emit("menu:undo", ());
            }
            "redo" => {
                let _ = app.emit("menu:redo", ());
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen {
                has_visible_windows,
                ..
            } = event
            {
                if !has_visible_windows {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app, event);
        });
}

fn build_menu<R: tauri::Runtime>(handle: &tauri::AppHandle<R>) -> tauri::Result<Menu<R>> {
    let new_page = MenuItem::with_id(handle, "new_page", "New Page", true, Some("CmdOrCtrl+N"))?;
    let open_notes_folder = MenuItem::with_id(
        handle,
        "open_notes_folder",
        "Open Notes Folder",
        true,
        Some("CmdOrCtrl+Shift+O"),
    )?;
    let quick_switcher = MenuItem::with_id(
        handle,
        "quick_switcher",
        "Quick Switcher…",
        true,
        Some("CmdOrCtrl+K"),
    )?;

    let chroot = MenuItem::with_id(
        handle,
        "chroot",
        "Chroot",
        true,
        Some("CmdOrCtrl+Shift+Period"),
    )?;
    let undo = MenuItem::with_id(handle, "undo", "Undo", true, Some("CmdOrCtrl+Z"))?;
    let redo = MenuItem::with_id(handle, "redo", "Redo", true, Some("CmdOrCtrl+Shift+Z"))?;

    let reload = MenuItem::with_id(handle, "reload", "Reload", true, Some("CmdOrCtrl+R"))?;
    let settings = MenuItem::with_id(handle, "settings", "Settings…", true, Some("CmdOrCtrl+,"))?;

    let check_updates = MenuItem::with_id(
        handle,
        "check_updates",
        "Check for Updates…",
        true,
        None::<&str>,
    )?;

    let setup_guide = MenuItem::with_id(handle, "setup_guide", "Setup Guide…", true, None::<&str>)?;

    let app_menu = Submenu::with_items(
        handle,
        "Set",
        true,
        &[
            &PredefinedMenuItem::about(handle, None, Some(AboutMetadata::default()))?,
            &setup_guide,
            &check_updates,
            &PredefinedMenuItem::separator(handle)?,
            &settings,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::hide(handle, None)?,
            &PredefinedMenuItem::hide_others(handle, None)?,
            &PredefinedMenuItem::show_all(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::quit(handle, None)?,
        ],
    )?;

    let file_menu = Submenu::with_items(
        handle,
        "File",
        true,
        &[
            &new_page,
            &PredefinedMenuItem::separator(handle)?,
            &open_notes_folder,
        ],
    )?;

    let edit_menu = Submenu::with_items(
        handle,
        "Edit",
        true,
        &[
            &undo,
            &redo,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::cut(handle, None)?,
            &PredefinedMenuItem::copy(handle, None)?,
            &PredefinedMenuItem::paste(handle, None)?,
            &PredefinedMenuItem::select_all(handle, None)?,
        ],
    )?;

    let view_menu = Submenu::with_items(handle, "View", true, &[&reload])?;

    let go_menu = Submenu::with_items(
        handle,
        "Go",
        true,
        &[
            &quick_switcher,
            &PredefinedMenuItem::separator(handle)?,
            &chroot,
        ],
    )?;

    let feedback = MenuItem::with_id(handle, "feedback", "Send Feedback…", true, None::<&str>)?;
    let support = MenuItem::with_id(handle, "support", "Support Set…", true, None::<&str>)?;
    let show_log = MenuItem::with_id(handle, "show_log", "Show Log", true, None::<&str>)?;

    let help_menu = Submenu::with_items(
        handle,
        "Help",
        true,
        &[
            &feedback,
            &support,
            &PredefinedMenuItem::separator(handle)?,
            &show_log,
        ],
    )?;

    let window_menu = Submenu::with_items(
        handle,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(handle, None)?,
            &PredefinedMenuItem::maximize(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::close_window(handle, None)?,
        ],
    )?;

    Menu::with_items(
        handle,
        &[
            &app_menu,
            &file_menu,
            &edit_menu,
            &view_menu,
            &go_menu,
            &window_menu,
            &help_menu,
        ],
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::TempDir;

    #[test]
    fn a_missing_copy_is_not_a_copy() {
        let dir = TempDir::new("lib");
        let source = dir.write("set-mcp", "v1");
        assert!(!is_copy_of(&dir.0.join("nothing-here"), &source));
    }

    #[test]
    fn a_copy_of_a_newer_source_is_stale() {
        let dir = TempDir::new("lib");

        let dest = dir.write("set-mcp", "v1");
        std::thread::sleep(std::time::Duration::from_millis(10));
        let source = dir.write("set-mcp.new", "v2");

        assert!(
            !is_copy_of(&dest, &source),
            "stale copy reported as current"
        );
        assert!(is_copy_of(&source, &dest), "current copy reported as stale");
    }

    #[test]
    fn a_copy_of_a_differently_sized_source_is_stale() {
        let dir = TempDir::new("lib");
        let source = dir.write("set-mcp", "a longer build");
        std::thread::sleep(std::time::Duration::from_millis(10));

        let dest = dir.write("set-mcp.copy", "short");
        assert!(!is_copy_of(&dest, &source));
    }
}
