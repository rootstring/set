use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

pub const FILE: &str = "ggml-small.bin";

pub const URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin";

pub const BYTES: u64 = 487_601_967;

pub const SHA256: &str = "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b";

pub const MEMORY_BYTES: u64 = 900_000_000;

pub const LABEL: &str = "Whisper small";
pub const PARAMETERS: &str = "244M";

fn plausible(len: u64) -> bool {
    len >= BYTES / 2
}

pub fn is_installed(path: &Path) -> bool {
    fs::metadata(path)
        .map(|m| plausible(m.len()))
        .unwrap_or(false)
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
            Path::new("/models/ggml-small.bin")
        );
    }
}
