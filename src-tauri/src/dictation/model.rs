use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

pub const FILE: &str = "ggml-small-q5_1.bin";

pub const URL: &str =
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin";

pub const BYTES: u64 = 190_085_487;

pub const SHA256: &str = "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb";

pub const MEMORY_BYTES: u64 = 700_000_000;

pub mod previous {
    pub const FILE: &str = "ggml-small.bin";
    pub const BYTES: u64 = 487_601_967;
}

pub const LABEL: &str = "Whisper small";
pub const PARAMETERS: &str = "244M";

fn plausible(len: u64) -> bool {
    plausible_for(len, BYTES)
}

fn plausible_for(len: u64, expected: u64) -> bool {
    len >= expected / 2
}

pub fn is_installed(path: &Path) -> bool {
    fs::metadata(path)
        .map(|m| plausible(m.len()))
        .unwrap_or(false)
}

pub fn previous_path_in(dir: &Path) -> PathBuf {
    dir.join(previous::FILE)
}

pub fn previous_installed(dir: &Path) -> bool {
    fs::metadata(previous_path_in(dir))
        .map(|m| plausible_for(m.len(), previous::BYTES))
        .unwrap_or(false)
}

pub fn usable_in(dir: &Path) -> Option<PathBuf> {
    let current = path_in(dir);
    if is_installed(&current) {
        return Some(current);
    }
    previous_installed(dir).then(|| previous_path_in(dir))
}

#[derive(Debug)]
pub enum DownloadError {
    Cancelled,
    Failed(String),
}

impl std::fmt::Display for DownloadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DownloadError::Cancelled => write!(f, "Download cancelled"),
            DownloadError::Failed(message) => write!(f, "{message}"),
        }
    }
}

#[cfg(feature = "dictation")]
fn failed(message: impl std::fmt::Display) -> DownloadError {
    DownloadError::Failed(message.to_string())
}

#[cfg(feature = "dictation")]
pub fn download(
    dir: &Path,
    cancel: &AtomicBool,
    mut progress: impl FnMut(u64),
) -> Result<(), DownloadError> {
    use sha2::{Digest, Sha256};
    use std::fs::File;
    use std::io::{BufWriter, Read, Write};
    use std::sync::atomic::Ordering;

    fs::create_dir_all(dir).map_err(|e| failed(format!("Couldn't create {dir:?}: {e}")))?;
    let final_path = dir.join(FILE);
    let part_path = dir.join(format!("{FILE}.part"));

    let response = ureq::get(URL)
        .call()
        .map_err(|e| failed(format!("Couldn't reach the model host: {e}")))?;
    if response.status() != 200 {
        return Err(failed(format!(
            "The model host answered {}",
            response.status()
        )));
    }

    let mut source = response.into_body().into_reader();
    let file =
        File::create(&part_path).map_err(|e| failed(format!("Couldn't write the model: {e}")))?;
    let mut sink = BufWriter::new(file);
    let mut hasher = Sha256::new();

    let mut buffer = vec![0u8; 1 << 20];
    let mut written: u64 = 0;

    loop {
        if cancel.load(Ordering::Relaxed) {
            drop(sink);
            let _ = fs::remove_file(&part_path);
            return Err(DownloadError::Cancelled);
        }
        let read = source
            .read(&mut buffer)
            .map_err(|e| failed(format!("The download stopped: {e}")))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        sink.write_all(&buffer[..read])
            .map_err(|e| failed(format!("Couldn't write the model: {e}")))?;
        written += read as u64;
        progress(written);
    }
    sink.flush()
        .map_err(|e| failed(format!("Couldn't finish writing the model: {e}")))?;
    drop(sink);

    let digest = crate::hex::encode(&hasher.finalize());
    if digest != SHA256 {
        let _ = fs::remove_file(&part_path);
        return Err(failed("The downloaded model was corrupted. Try again."));
    }

    fs::rename(&part_path, &final_path)
        .map_err(|e| failed(format!("Couldn't put the model in place: {e}")))?;
    Ok(())
}

#[cfg(not(feature = "dictation"))]
pub fn download(
    _dir: &Path,
    _cancel: &AtomicBool,
    _progress: impl FnMut(u64),
) -> Result<(), DownloadError> {
    Err(DownloadError::Failed(
        "This build of Set was made without dictation.".into(),
    ))
}

pub fn path_in(dir: &Path) -> PathBuf {
    dir.join(FILE)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_truncated_download_is_not_an_installed_model() {
        assert!(!plausible(0));
        assert!(!plausible(BYTES / 4));
        assert!(plausible(BYTES));
    }

    #[test]
    fn a_missing_file_is_not_installed() {
        assert!(!is_installed(Path::new(
            "/nonexistent/set-dictation/ggml-small.bin"
        )));
    }

    #[test]
    fn the_model_path_is_the_whisper_cpp_name() {
        assert_eq!(
            path_in(Path::new("/models")),
            Path::new("/models/ggml-small-q5_1.bin")
        );
    }

    fn model_file(dir: &Path, name: &str, len: u64) {
        fs::File::create(dir.join(name))
            .unwrap()
            .set_len(len)
            .unwrap();
    }

    #[test]
    fn the_current_model_is_used_when_it_is_installed() {
        let dir = crate::testing::TempDir::new("model");
        model_file(dir.path(), FILE, BYTES);
        model_file(dir.path(), previous::FILE, previous::BYTES);
        assert_eq!(usable_in(dir.path()), Some(path_in(dir.path())));
    }

    #[test]
    fn the_previous_model_keeps_dictation_working_until_it_is_replaced() {
        let dir = crate::testing::TempDir::new("model");
        model_file(dir.path(), previous::FILE, previous::BYTES);
        assert_eq!(usable_in(dir.path()), Some(previous_path_in(dir.path())));
        assert!(!is_installed(&path_in(dir.path())));
    }

    #[test]
    fn a_half_downloaded_current_model_falls_back_to_the_previous_one() {
        let dir = crate::testing::TempDir::new("model");
        model_file(dir.path(), FILE, BYTES / 4);
        model_file(dir.path(), previous::FILE, previous::BYTES);
        assert_eq!(usable_in(dir.path()), Some(previous_path_in(dir.path())));
    }

    #[test]
    fn a_truncated_previous_model_is_not_used() {
        let dir = crate::testing::TempDir::new("model");
        model_file(dir.path(), previous::FILE, previous::BYTES / 4);
        assert_eq!(usable_in(dir.path()), None);
    }
}
