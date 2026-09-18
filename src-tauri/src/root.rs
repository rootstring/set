use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use crate::config::home_dir;

#[derive(Default)]
pub struct NotesRoot(Mutex<Option<PathBuf>>);

impl NotesRoot {
    pub fn set(&self, path: PathBuf) {
        *self.0.lock().expect("notes root poisoned") = Some(path);
    }

    pub fn get(&self) -> Result<PathBuf, String> {
        self.0
            .lock()
            .expect("notes root poisoned")
            .clone()
            .ok_or_else(|| "no notes folder has been granted yet".to_string())
    }

    pub fn contain(&self, path: &str) -> Result<PathBuf, String> {
        contain(&self.get()?, path)
    }
}

pub fn policy(path: &str) -> Result<PathBuf, String> {
    let path = Path::new(path);
    if !path.is_absolute() {
        return Err("a notes folder has to be an absolute path".to_string());
    }

    if path
        .components()
        .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
    {
        return Err("a notes folder can't be reached through `..`".to_string());
    }

    if path
        .components()
        .any(|c| matches!(c, Component::Normal(name) if name.to_string_lossy().starts_with('.')))
    {
        return Err("a notes folder can't be a hidden folder".to_string());
    }
    if path.parent().is_none() {
        return Err("the filesystem root isn't a notes folder".to_string());
    }

    let resolved = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());

    if let Some(home) = home_dir() {
        let home = home.canonicalize().unwrap_or(home);
        if resolved == home {
            return Err("the home folder itself isn't a notes folder".to_string());
        }

        if home.starts_with(&resolved) {
            return Err(
                "that folder contains the home folder; pick a folder inside it".to_string(),
            );
        }

        #[cfg(target_os = "macos")]
        if resolved.starts_with(home.join("Library"))
            && !resolved.starts_with(home.join("Library").join("Mobile Documents"))
        {
            return Err("the Library folder isn't a notes folder".to_string());
        }
    }

    Ok(resolved)
}

/// Canonicalize the parent, not the target: stops a symlinked folder pointing out, and the file may
/// not exist yet.
pub fn contain(root: &Path, path: &str) -> Result<PathBuf, String> {
    let target = Path::new(path);
    if !target.is_absolute() {
        return Err(format!("refusing a relative path: {path}"));
    }
    if target
        .components()
        .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
    {
        return Err(format!("refusing a path with `..` in it: {path}"));
    }

    let root = root
        .canonicalize()
        .map_err(|e| format!("the notes folder {} can't be resolved: {e}", root.display()))?;

    let (parent, name) = match (target.parent(), target.file_name()) {
        (Some(parent), Some(name)) => (parent, name),
        _ => return Err(format!("refusing a path with no file name: {path}")),
    };
    let parent = parent
        .canonicalize()
        .map_err(|_| format!("refusing a path whose folder doesn't exist: {path}"))?;
    if !parent.starts_with(&root) {
        return Err(format!("refusing a path outside the notes folder: {path}"));
    }
    Ok(parent.join(name))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::TempDir;

    #[test]
    fn a_plain_page_inside_the_folder_is_allowed() {
        let d = TempDir::new("ok");
        let path = d.0.join("Note.md");
        assert_eq!(
            contain(&d.0, &path.to_string_lossy()),
            Ok(d.0.join("Note.md")),
            "the ordinary save has to keep working"
        );
    }

    #[test]
    fn a_page_that_doesnt_exist_yet_is_allowed() {
        let d = TempDir::new("new");
        let path = d.0.join("Brand New.md");
        assert!(contain(&d.0, &path.to_string_lossy()).is_ok());
    }

    #[test]
    fn nothing_the_webview_sends_can_write_outside_the_notes_folder() {
        let d = TempDir::new("escape");
        let outside = d.0.parent().unwrap().join("outside.md");
        for path in [
            outside.to_string_lossy().to_string(),
            format!("{}/../outside.md", d.0.display()),
            format!("{}/sub/../../outside.md", d.0.display()),
            "/etc/passwd".to_string(),
            "relative.md".to_string(),
        ] {
            assert!(
                contain(&d.0, &path).is_err(),
                "{path:?} should have been refused"
            );
        }
    }

    #[test]
    fn a_symlink_out_of_the_folder_is_resolved_before_it_is_trusted() {
        #[cfg(unix)]
        {
            let inside = TempDir::new("symlink-in");
            let outside = TempDir::new("symlink-out");
            let link = inside.0.join("escape");
            std::os::unix::fs::symlink(&outside.0, &link).unwrap();
            let path = link.join("stolen.md");
            assert!(
                contain(&inside.0, &path.to_string_lossy()).is_err(),
                "a symlinked folder must not be a way out"
            );
        }
    }

    #[test]
    fn the_folders_worth_stealing_are_never_notes_folders() {
        let home = home_dir().expect("a home directory");
        let home = home.to_string_lossy().to_string();
        for path in [
            "/".to_string(),
            home.clone(),
            format!("{home}/.ssh"),
            format!("{home}/.config/set"),
            format!("{home}/Documents/../.aws"),
            "Documents/Set".to_string(),
        ] {
            assert!(policy(&path).is_err(), "{path:?} should have been refused");
        }

        #[cfg(unix)]
        assert!(policy("/tmp/../").is_err());
    }

    #[test]
    fn an_ordinary_notes_folder_still_passes() {
        let home = home_dir().expect("a home directory");

        for path in [
            home.join("Documents").join("Set"),
            home.join("Dropbox").join("Notes"),
            PathBuf::from("/Volumes/External/Notes"),
        ] {
            assert!(
                policy(&path.to_string_lossy()).is_ok(),
                "{path:?} should have been allowed"
            );
        }
    }

    #[test]
    fn icloud_drive_is_a_notes_folder_even_though_library_isnt() {
        #[cfg(target_os = "macos")]
        {
            let home = home_dir().expect("a home directory");
            let icloud = home
                .join("Library")
                .join("Mobile Documents")
                .join("com~apple~CloudDocs")
                .join("Set");
            assert!(policy(&icloud.to_string_lossy()).is_ok(), "{icloud:?}");

            let app_support = home
                .join("Library")
                .join("Application Support")
                .join("net.rootstring.set");
            assert!(policy(&app_support.to_string_lossy()).is_err());
        }
    }

    #[test]
    fn a_granted_folder_comes_back_canonical() {
        let d = TempDir::new("canonical");
        let granted = policy(&d.0.to_string_lossy()).expect("a real folder");
        assert_eq!(granted, d.0.canonicalize().unwrap());
    }

    #[test]
    fn commands_refuse_before_a_folder_is_granted() {
        let root = NotesRoot::default();
        assert!(root.get().is_err());
        assert!(root.contain("/tmp/anything.md").is_err());
    }
}
