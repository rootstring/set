use std::path::PathBuf;

const APP_DIR: &str = "net.rootstring.set";

/// Set's own state, not the notes.
pub fn config_dir() -> Option<PathBuf> {
    Some(config_root()?.join(APP_DIR))
}

pub fn app_dir_name() -> &'static str {
    APP_DIR
}

fn config_root() -> Option<PathBuf> {
    if cfg!(target_os = "windows") {
        return std::env::var_os("APPDATA").map(PathBuf::from);
    }
    if cfg!(target_os = "macos") {
        let home = home_dir()?;
        return Some(home.join("Library").join("Application Support"));
    }
    if let Some(xdg) = std::env::var_os("XDG_CONFIG_HOME") {
        let path = PathBuf::from(xdg);
        if path.is_absolute() {
            return Some(path);
        }
    }
    Some(home_dir()?.join(".config"))
}

pub fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn our_state_sits_in_our_own_folder_under_the_os_config_dir() {
        let dir = config_dir().expect("a config dir");
        assert!(dir.ends_with(APP_DIR), "{dir:?}");
        assert!(dir.is_absolute(), "{dir:?}");
    }
}
