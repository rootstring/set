use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter};

use crate::paths::ASSETS_DIR;
use crate::write::TMP_SUFFIX;

const QUIET: Duration = Duration::from_millis(600);

const CEILING: Duration = Duration::from_secs(3);

const LEDGER_TTL: Duration = Duration::from_secs(30);

#[derive(Clone, Copy, PartialEq, Eq)]
struct Fingerprint {
    len: u64,
    mtime: Option<SystemTime>,
}

impl Fingerprint {
    fn read(path: &Path) -> Option<Self> {
        let meta = std::fs::metadata(path).ok()?;
        Some(Fingerprint {
            len: meta.len(),
            mtime: meta.modified().ok(),
        })
    }
}

#[derive(Default)]
pub struct OwnWrites(Mutex<HashMap<PathBuf, (Fingerprint, Instant)>>);

impl OwnWrites {
    pub fn record(&self, path: &Path) {
        let Some(print) = Fingerprint::read(path) else {
            return;
        };
        let mut ledger = self.0.lock().expect("own-writes poisoned");
        let now = Instant::now();
        ledger.retain(|_, (_, at)| now.duration_since(*at) < LEDGER_TTL);
        ledger.insert(path.to_path_buf(), (print, now));
    }

    fn claims(&self, path: &Path) -> bool {
        let ledger = self.0.lock().expect("own-writes poisoned");
        let Some((recorded, _)) = ledger.get(path) else {
            return false;
        };
        Fingerprint::read(path).is_some_and(|now| now == *recorded)
    }
}

pub struct Watch {
    app: AppHandle,

    own: Arc<OwnWrites>,
    active: Mutex<Option<Active>>,
}

struct Active {
    _watcher: RecommendedWatcher,
    root: PathBuf,
}

impl Watch {
    pub fn new(app: AppHandle) -> Self {
        Watch {
            app,
            own: Arc::new(OwnWrites::default()),
            active: Mutex::new(None),
        }
    }

    pub fn own_writes(&self) -> &OwnWrites {
        &self.own
    }

    pub fn retarget(&self, root: &Path) {
        let mut active = self.active.lock().expect("watch poisoned");
        if active.as_ref().is_some_and(|a| a.root == root) {
            return;
        }

        *active = None;
        let app = self.app.clone();

        let report = move |changed: usize| {
            let _ = app.emit("notes:changed", serde_json::json!({ "count": changed }));
        };
        match start(root.to_path_buf(), Arc::clone(&self.own), report) {
            Ok(watcher) => {
                crate::log::info("watch.started")
                    .field("root", root.display())
                    .emit();
                *active = Some(Active {
                    _watcher: watcher,
                    root: root.to_path_buf(),
                });
            }
            // Not fatal: Set keeps working but stops noticing outside edits.
            Err(err) => {
                crate::log::warn("watch.failed")
                    .field("root", root.display())
                    .field("error", err)
                    .emit();
            }
        }
    }
}

fn start<F>(root: PathBuf, own: Arc<OwnWrites>, report: F) -> notify::Result<RecommendedWatcher>
where
    F: Fn(usize) + Send + 'static,
{
    let (tx, rx) = mpsc::channel::<notify::Result<notify::Event>>();
    let mut watcher = notify::recommended_watcher(move |event| {
        let _ = tx.send(event);
    })?;
    watcher.watch(&root, RecursiveMode::Recursive)?;

    std::thread::Builder::new()
        .name("set-notes-watch".into())
        .spawn(move || debounce(root, own, rx, report))
        .map_err(notify::Error::io)?;

    Ok(watcher)
}

fn debounce<F: Fn(usize)>(
    root: PathBuf,
    own: Arc<OwnWrites>,
    rx: mpsc::Receiver<notify::Result<notify::Event>>,
    report: F,
) {
    loop {
        let Ok(first) = rx.recv() else { return };
        let mut changed = HashSet::new();
        gather(first, &root, &mut changed);

        let deadline = Instant::now() + CEILING;
        let ended = loop {
            let wait = QUIET.min(deadline.saturating_duration_since(Instant::now()));
            match rx.recv_timeout(wait) {
                Ok(event) => gather(event, &root, &mut changed),
                Err(RecvTimeoutError::Timeout) => break false,

                Err(RecvTimeoutError::Disconnected) => break true,
            }
        };

        // Claims are settled once the burst closes: a write is recorded just after it lands.
        let changed = changed.iter().filter(|path| !own.claims(path)).count();
        if changed > 0 {
            report(changed);
        }
        if ended {
            return;
        }
    }
}

fn gather(event: notify::Result<notify::Event>, root: &Path, into: &mut HashSet<PathBuf>) {
    let Ok(event) = event else { return };
    // inotify reports opens and closes; every read (our own reload included) would count as an
    // outside edit. A write also arrives as create, modify or rename.
    if matches!(event.kind, EventKind::Access(_)) {
        return;
    }
    into.extend(event.paths.into_iter().filter(|path| relevant(path, root)));
}

fn relevant(path: &Path, root: &Path) -> bool {
    let Ok(rel) = path.strip_prefix(root) else {
        return false;
    };

    if rel.as_os_str().is_empty() {
        return false;
    }
    for part in rel.components() {
        let Some(name) = part.as_os_str().to_str() else {
            return false;
        };
        if name.starts_with('.') || name == ASSETS_DIR {
            return false;
        }
    }
    if rel.to_string_lossy().ends_with(TMP_SUFFIX) {
        return false;
    }
    !path.is_dir()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::TempDir;
    use std::fs;

    struct Harness {
        dir: TempDir,
        own: Arc<OwnWrites>,
        reports: mpsc::Receiver<usize>,
        _watcher: RecommendedWatcher,
    }

    impl Harness {
        fn new() -> Self {
            let dir = TempDir::new("watch");
            let own = Arc::new(OwnWrites::default());
            let (tx, reports) = mpsc::channel();
            let watcher = start(dir.0.clone(), Arc::clone(&own), move |n| {
                let _ = tx.send(n);
            })
            .expect("watching a temp dir");
            Harness {
                dir,
                own,
                reports,
                _watcher: watcher,
            }
        }

        fn path(&self, name: &str) -> PathBuf {
            self.dir.0.join(name)
        }

        fn outside_write(&self, name: &str, contents: &str) -> PathBuf {
            let path = self.path(name);
            fs::write(&path, contents).unwrap();
            path
        }

        fn own_write(&self, name: &str, contents: &str) -> PathBuf {
            let path = self.outside_write(name, contents);
            self.own.record(&path);
            path
        }

        fn next_report(&self) -> Option<usize> {
            self.reports.recv_timeout(Duration::from_secs(5)).ok()
        }
    }
    fn root() -> PathBuf {
        PathBuf::from("/notes")
    }

    #[test]
    fn a_page_is_relevant() {
        assert!(relevant(&root().join("Project A.md"), &root()));
        assert!(relevant(&root().join("Projects/Project A.md"), &root()));
    }

    #[test]
    fn a_vanished_path_is_relevant() {
        assert!(relevant(&root().join("Projects"), &root()));
        assert!(relevant(&root().join("Project A.md"), &root()));
    }

    #[test]
    fn a_directory_that_still_exists_is_not() {
        let dir = TempDir::new("watch");
        fs::create_dir(dir.0.join("Projects")).unwrap();

        assert!(!relevant(&dir.0.join("Projects"), &dir.0));
    }

    #[test]
    fn the_notes_folder_itself_is_not() {
        let dir = TempDir::new("watch");
        assert!(!relevant(&dir.0, &dir.0));
    }

    #[test]
    fn hidden_files_are_not() {
        assert!(!relevant(&root().join(".DS_Store"), &root()));
        assert!(!relevant(&root().join(".git/HEAD"), &root()));

        assert!(!relevant(&root().join(".Project A.md.icloud"), &root()));

        assert!(!relevant(&root().join("Projects/.git/index"), &root()));
    }

    #[test]
    fn our_own_scratch_files_are_not() {
        assert!(!relevant(&root().join("Project A.md.set-tmp"), &root()));
    }

    #[test]
    fn page_images_are_not() {
        assert!(!relevant(
            &root().join("Projects/Set-page-assets/k3m9.png"),
            &root()
        ));
    }

    #[test]
    fn a_path_outside_the_root_is_not() {
        assert!(!relevant(Path::new("/elsewhere/Project A.md"), &root()));
    }

    #[test]
    fn a_recorded_write_is_claimed() {
        let dir = TempDir::new("watch");
        let path = dir.0.join("Project A.md");
        fs::write(&path, "hello").unwrap();

        let own = OwnWrites::default();
        own.record(&path);
        assert!(own.claims(&path), "our own write was reported as external");
    }

    #[test]
    fn a_file_changed_after_we_wrote_it_is_not_claimed() {
        let dir = TempDir::new("watch");
        let path = dir.0.join("Project A.md");
        fs::write(&path, "ours").unwrap();

        let own = OwnWrites::default();
        own.record(&path);

        std::thread::sleep(Duration::from_millis(10));
        fs::write(&path, "theirs, and longer").unwrap();

        assert!(
            !own.claims(&path),
            "an outside edit to a path we had written was swallowed"
        );
    }

    #[test]
    fn a_same_length_edit_is_still_noticed() {
        let dir = TempDir::new("watch");
        let path = dir.0.join("Project A.md");
        fs::write(&path, "aaaa").unwrap();

        let own = OwnWrites::default();
        own.record(&path);

        std::thread::sleep(Duration::from_millis(10));
        fs::write(&path, "bbbb").unwrap();

        assert!(!own.claims(&path));
    }

    #[test]
    fn a_deleted_file_is_not_claimed() {
        let dir = TempDir::new("watch");
        let path = dir.0.join("Project A.md");
        fs::write(&path, "hello").unwrap();

        let own = OwnWrites::default();
        own.record(&path);
        fs::remove_file(&path).unwrap();

        assert!(!own.claims(&path));
    }

    #[test]
    fn an_unrecorded_path_is_not_claimed() {
        let dir = TempDir::new("watch");
        let path = dir.0.join("Project A.md");
        fs::write(&path, "hello").unwrap();
        assert!(!OwnWrites::default().claims(&path));
    }

    #[test]
    fn a_page_being_opened_is_not_gathered_as_a_change() {
        // Only inotify delivers a read event; macOS and Windows do not.
        let root = root();
        let page = root.join("Project A.md");
        let mut changed = HashSet::new();

        let opened = notify::Event::new(EventKind::Access(notify::event::AccessKind::Open(
            notify::event::AccessMode::Read,
        )))
        .add_path(page.clone());
        gather(Ok(opened), &root, &mut changed);

        let closed = notify::Event::new(EventKind::Access(notify::event::AccessKind::Close(
            notify::event::AccessMode::Read,
        )))
        .add_path(page.clone());
        gather(Ok(closed), &root, &mut changed);

        assert!(
            changed.is_empty(),
            "a page being read was gathered as an outside edit: {changed:?}"
        );

        // The write that follows a read still counts.
        gather(
            Ok(notify::Event::new(EventKind::Any).add_path(page.clone())),
            &root,
            &mut changed,
        );
        assert_eq!(changed.len(), 1, "an edit was swallowed with the reads");
    }

    #[test]
    fn a_page_written_from_outside_is_reported() {
        let watch = Harness::new();
        watch.outside_write("Project A.md", "# Hello");
        assert!(
            watch.next_report().is_some(),
            "an edit made outside Set went unnoticed"
        );
    }

    #[test]
    fn a_burst_is_reported_once() {
        let watch = Harness::new();

        for n in 0..25 {
            watch.outside_write(&format!("Page {n}.md"), "body");
        }
        assert!(watch.next_report().is_some());

        assert_eq!(
            watch.reports.recv_timeout(QUIET * 3).ok(),
            None,
            "one burst produced more than one reload"
        );
    }

    #[test]
    fn a_scratch_file_is_not_reported() {
        let watch = Harness::new();
        watch.outside_write("Project A.md.set-tmp", "half a save");
        assert_eq!(
            watch.next_report(),
            None,
            "the scratch half of an atomic write was reported as a change"
        );
    }

    #[test]
    fn reading_a_page_is_not_reported() {
        let dir = TempDir::new("watch");
        let path = dir.0.join("Project A.md");
        fs::write(&path, "# Hello").unwrap();

        let (tx, reports) = mpsc::channel();
        let _watcher = start(dir.0.clone(), Arc::new(OwnWrites::default()), move |n| {
            let _ = tx.send(n);
        })
        .expect("watching a temp dir");

        // FSEvents replays the setup write from just before the stream opened, and a watch that
        // never started reports nothing. So: wait for one change of our own, then drain.
        fs::write(dir.0.join("Probe.md"), "a change to wait for").unwrap();
        assert!(
            reports.recv_timeout(Duration::from_secs(5)).is_ok(),
            "the watch never reported a change, so it was never watching"
        );
        while reports.recv_timeout(QUIET * 2).is_ok() {}

        fs::read_to_string(&path).unwrap();
        assert_eq!(
            reports.recv_timeout(Duration::from_secs(5)).ok(),
            None,
            "opening a page to read it was reported as a change"
        );
    }

    #[test]
    fn a_hidden_file_is_not_reported() {
        let watch = Harness::new();
        watch.outside_write(".DS_Store", "finder");
        assert_eq!(watch.next_report(), None);
    }

    #[test]
    fn our_own_save_is_not_reported() {
        let watch = Harness::new();
        watch.own_write("Project A.md", "# Written by Set");
        assert_eq!(
            watch.next_report(),
            None,
            "the app's own save came back as an outside change"
        );
    }

    #[test]
    fn an_event_that_beats_the_ledger_is_still_our_own_write() {
        let dir = TempDir::new("watch");
        let path = dir.0.join("Project A.md");
        fs::write(&path, "# Written by Set").unwrap();

        let own = Arc::new(OwnWrites::default());
        let (events, rx) = mpsc::sync_channel(0);
        let (tx, reports) = mpsc::channel();

        let root = dir.0.clone();
        let ledger = Arc::clone(&own);
        let watcher = std::thread::spawn(move || {
            debounce(root, ledger, rx, move |n| {
                let _ = tx.send(n);
            })
        });

        let event = |p: PathBuf| Ok(notify::Event::new(notify::EventKind::Any).add_path(p));
        events.send(event(path.clone())).unwrap();

        // A rendezvous send lands only once the watcher took it: the event for a save arrives
        // before the save is recorded.
        events.send(event(dir.0.join(".DS_Store"))).unwrap();
        own.record(&path);
        drop(events);
        watcher.join().unwrap();

        assert_eq!(
            reports.try_recv().ok(),
            None,
            "a save whose event outran the ledger came back as an outside edit"
        );
    }

    #[test]
    fn an_outside_edit_to_a_page_we_saved_is_still_reported() {
        let watch = Harness::new();
        let path = watch.own_write("Project A.md", "# Written by Set");

        assert_eq!(watch.next_report(), None);

        fs::write(&path, "# Written by somebody else").unwrap();
        assert!(
            watch.next_report().is_some(),
            "an outside edit was swallowed because Set had written that path"
        );
    }
}
