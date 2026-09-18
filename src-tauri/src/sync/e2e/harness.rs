//! Folder operations mirror `fs-store.ts` exactly, so a test here tests what the app hands sync.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::{Arc, Mutex};

use iroh::endpoint::Connection;
use iroh::{Endpoint, EndpointAddr, SecretKey, TransportAddr};

use crate::sync::manifest::{self, Hash};
use crate::sync::protocol::{self, Request, Response};
use crate::sync::round::{self, Answered, Report, Stage};
use crate::sync::session::{self, Failure, Identity};
use crate::sync::state::Dirs;
use crate::testing::TempDir;

thread_local! {
    /// Per test, so a seeded run replays exactly regardless of other tests.
    static CLOCK: std::cell::Cell<u64> = const { std::cell::Cell::new(1_800_000_000_000) };
    static IDS: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

pub fn tick() -> u64 {
    CLOCK.with(|c| {
        c.set(c.get() + 7);
        c.get()
    })
}

/// A page id in the app's alphabet, the same sequence every run of a test.
pub fn next_id() -> String {
    let n = IDS.with(|c| {
        c.set(c.get() + 1);
        c.get()
    });
    crate::page_id::derive(&format!("page-{n}"))
}

/// Start a test's clock and ids from a seed.
pub fn reseed(seed: u64) {
    CLOCK.with(|c| c.set(1_800_000_000_000 + seed));
    IDS.with(|c| c.set(seed << 20));
}

type Hook = Box<dyn Fn(Stage) + Send + Sync>;

/// Cheap to clone, so a hook can carry one into a round.
#[derive(Clone)]
pub struct Folder {
    pub name: String,
    root: std::path::PathBuf,
    state: std::path::PathBuf,
}

pub struct Device {
    pub name: String,
    folder: Folder,
    pub notes: TempDir,
    pub state: TempDir,
    pub endpoint: Endpoint,
    identity: Identity,
    lock: Arc<tokio::sync::Mutex<()>>,
    hook: Arc<Mutex<Option<Hook>>>,
    server: tokio::task::JoinHandle<()>,
    pub answered: Arc<Mutex<Vec<Answered>>>,
}

impl Drop for Device {
    fn drop(&mut self) {
        self.server.abort();
    }
}

impl Device {
    /// Dropping a device does not release its sockets; a long soak then runs out.
    pub async fn close(self) {
        self.server.abort();
        self.endpoint.close().await;
    }
}

impl std::ops::Deref for Device {
    type Target = Folder;

    fn deref(&self) -> &Folder {
        &self.folder
    }
}

/// How a round can be made to go wrong.
#[derive(Clone, Copy, Debug)]
pub enum Cut {
    /// The connection drops at this point.
    Drop(Stage),
    /// The device coordinating dies at this point, mid-round.
    Crash(Stage),
}

impl Device {
    pub async fn new(name: &str, notes_id: &str) -> Device {
        let endpoint = Endpoint::builder(iroh::endpoint::presets::Minimal)
            .secret_key(SecretKey::generate())
            .alpns(vec![protocol::ALPN.to_vec()])
            .bind()
            .await
            .expect("bind");
        let notes = TempDir::new(&format!("e2e-{}-notes", name.to_lowercase()));
        let state = TempDir::new(&format!("e2e-{}-state", name.to_lowercase()));
        std::fs::create_dir_all(notes.0.join("Set")).unwrap();

        let identity = Identity {
            device_name: name.to_string(),
            notes_id: notes_id.to_string(),
            device_id: endpoint.id().to_string(),
        };
        let lock = Arc::new(tokio::sync::Mutex::new(()));
        let hook: Arc<Mutex<Option<Hook>>> = Arc::new(Mutex::new(None));
        let answered = Arc::new(Mutex::new(Vec::new()));

        let serving = round_device(&notes.0, &state.0, &identity, &lock, &hook);
        let server = {
            let endpoint = endpoint.clone();
            let answered = answered.clone();
            tokio::spawn(async move {
                while let Some(incoming) = endpoint.accept().await {
                    let Ok(connection) = incoming.await else {
                        continue;
                    };
                    let peer = connection.remote_id();
                    let answered = answered.clone();
                    let session = Arc::new(round::Session::new(
                        serving.clone(),
                        peer,
                        Arc::new(move |a| answered.lock().unwrap().push(a)),
                    ));
                    tokio::spawn(session::serve_streams(
                        connection,
                        || protocol::MAX_MESSAGE,
                        move |bytes: Vec<u8>| {
                            let session = session.clone();
                            async move {
                                let response = match protocol::decode::<Request>(&bytes) {
                                    Ok(request) => session.answer(request).await,
                                    Err(e) => Response::Error(e),
                                };
                                protocol::encode(&response).unwrap_or_default()
                            }
                        },
                    ));
                }
            })
        };

        Device {
            name: name.to_string(),
            folder: Folder {
                name: name.to_string(),
                root: notes.0.clone(),
                state: state.0.clone(),
            },
            notes,
            state,
            endpoint,
            identity,
            lock,
            hook,
            server,
            answered,
        }
    }

    fn device(&self) -> round::Device {
        round_device(
            &self.notes.0,
            &self.state.0,
            &self.identity,
            &self.lock,
            &self.hook,
        )
    }

    fn address(&self) -> EndpointAddr {
        EndpointAddr::from_parts(
            self.endpoint.id(),
            self.endpoint.bound_sockets().into_iter().map(|s| {
                TransportAddr::Ip(std::net::SocketAddr::new(
                    "127.0.0.1".parse().unwrap(),
                    s.port(),
                ))
            }),
        )
    }

    /// A few tries: a busy CI runner can time out a handshake.
    async fn connect(&self, other: &Device) -> Connection {
        let mut last = None;
        for attempt in 0..4u64 {
            match self.endpoint.connect(other.address(), protocol::ALPN).await {
                Ok(connection) => return connection,
                Err(e) => last = Some(e),
            }
            tokio::time::sleep(std::time::Duration::from_millis(200 * (attempt + 1))).await;
        }
        panic!("connect: {}", last.expect("tried"))
    }

    /// Press "Sync now" here, with `other` as the only paired device, and say
    /// yes to whatever the preview shows.
    pub async fn sync(&self, other: &Device) -> Result<Report, Failure> {
        match self.sync_asking(other, |_| true).await? {
            round::Round::Done(report) => Ok(report),
            round::Round::Declined => unreachable!("declined though the answer was yes"),
        }
    }

    /// The same, with `answer` looking at the preview and deciding.
    pub async fn sync_asking(
        &self,
        other: &Device,
        answer: impl Fn(&round::Review) -> bool + Send + Sync + 'static,
    ) -> Result<round::Round, Failure> {
        let connection = self.connect(other).await;
        let result = round::coordinate(
            &self.device(),
            &connection,
            other.endpoint.id(),
            &other.name,
            &answering(answer),
        )
        .await;
        connection.close(0u32.into(), b"done");
        result
    }

    /// A round that runs `at` when it reaches `stage`: the moment to make an
    /// edit land in the middle of one.
    pub async fn sync_with_hook(
        &self,
        other: &Device,
        stage: Stage,
        at: impl FnOnce() + Send + 'static,
    ) -> Result<Report, Failure> {
        let once: Mutex<Option<Box<dyn FnOnce() + Send>>> = Mutex::new(Some(Box::new(at)));
        *self.hook.lock().unwrap_or_else(|p| p.into_inner()) = Some(Box::new(move |reached| {
            if reached == stage {
                if let Some(at) = once.lock().unwrap().take() {
                    at();
                }
            }
        }));
        let result = self.sync(other).await;
        *self.hook.lock().unwrap_or_else(|p| p.into_inner()) = None;
        result
    }

    /// A round that goes wrong at the chosen point.
    pub async fn sync_cut(&self, other: &Device, cut: Cut) {
        let connection = self.connect(other).await;
        let closing = connection.clone();
        match cut {
            Cut::Drop(stage) => {
                *self.hook.lock().unwrap_or_else(|p| p.into_inner()) =
                    Some(Box::new(move |reached| {
                        if reached == stage {
                            closing.close(1u32.into(), b"gone");
                        }
                    }));
                let result = round::coordinate(
                    &self.device(),
                    &connection,
                    other.endpoint.id(),
                    &other.name,
                    &answering(|_| true),
                )
                .await;
                *self.hook.lock().unwrap_or_else(|p| p.into_inner()) = None;
                assert!(result.is_err(), "a dropped connection must fail the round");
            }
            Cut::Crash(stage) => {
                quiet_crashes();
                *self.hook.lock().unwrap_or_else(|p| p.into_inner()) =
                    Some(Box::new(move |reached| {
                        if reached == stage {
                            panic!("simulated crash at {reached:?}");
                        }
                    }));
                let device = self.device();
                let (peer, name) = (other.endpoint.id(), other.name.clone());
                let task = tokio::spawn(async move {
                    let _ =
                        round::coordinate(&device, &connection, peer, &name, &answering(|_| true))
                            .await;
                });
                assert!(task.await.is_err(), "the crash should have happened");
                closing.close(1u32.into(), b"crashed");
                *self.hook.lock().unwrap_or_else(|p| p.into_inner()) = None;
            }
        }
        // Give the other device a moment to notice the connection went.
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }

    /// Stop answering connections, so a test can answer them some other way.
    pub fn stop_serving(&self) {
        self.server.abort();
    }

    /// The folder, to hand to a hook.
    pub fn folder(&self) -> Folder {
        self.folder.clone()
    }
}

impl Folder {
    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn dirs(&self) -> Dirs {
        Dirs::under(&self.state)
    }

    /// Those directly in a bin first: the ones the app offers to restore or empty.
    pub fn trash_pages(&self) -> Vec<Page> {
        fn walk(root: &Path, dir: &Path, in_trash: bool, out: &mut Vec<Page>) {
            let Ok(entries) = std::fs::read_dir(dir) else {
                return;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                let name = entry.file_name().to_string_lossy().into_owned();
                if path.is_dir() {
                    let trash = name.eq_ignore_ascii_case(manifest::TRASH_DIR);
                    if !name.starts_with('.') {
                        walk(root, &path, in_trash || trash, out);
                    }
                } else if in_trash && manifest::is_note(&name) {
                    let text = std::fs::read_to_string(&path).unwrap_or_default();
                    if let Some(id) = crate::scan::page_identity(&text).0 {
                        let rel = path.strip_prefix(root).unwrap().to_string_lossy();
                        out.push(Page {
                            id,
                            path: rel.replace('\\', "/"),
                            text,
                        });
                    }
                }
            }
        }
        let mut out = Vec::new();
        walk(self.root(), self.root(), false, &mut out);
        out.sort_by_key(|page| (!directly_in_a_bin(&page.path), page.path.clone()));
        out
    }

    pub fn trashed_page(&self, id: &str) -> Option<Page> {
        self.trash_pages().into_iter().find(|page| page.id == id)
    }

    /// Every live page, by id.
    pub fn pages(&self) -> BTreeMap<String, Page> {
        let mut out = BTreeMap::new();
        for (path, entry) in manifest::build(self.root()).files {
            if !manifest::is_note(&path) {
                continue;
            }
            let Some(id) = entry.page_id else { continue };
            let text = std::fs::read_to_string(self.root().join(&path)).unwrap();
            out.insert(id.clone(), Page { id, path, text });
        }
        out
    }

    pub fn page(&self, id: &str) -> Option<Page> {
        self.pages().remove(id)
    }

    pub fn body(&self, id: &str) -> Option<String> {
        self.page(id).map(|p| body_of(&p.text).to_string())
    }

    fn allocate(&self, folder: &str, title: &str, own: Option<&str>) -> String {
        let desired = crate::paths::sanitize_title(title);
        for n in 1.. {
            let base = if n == 1 {
                desired.clone()
            } else {
                format!("{desired} {n}")
            };
            if crate::paths::is_reserved(&base) {
                continue;
            }
            let rel = join(folder, &format!("{base}.md"));
            if own == Some(rel.as_str()) {
                return rel;
            }
            if self.exists(&rel) || self.exists(&join(folder, &base)) {
                continue;
            }
            return rel;
        }
        unreachable!()
    }

    fn exists(&self, rel: &str) -> bool {
        std::fs::symlink_metadata(self.root().join(rel)).is_ok()
    }

    fn write(&self, rel: &str, text: &str) {
        let path = self.root().join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        crate::write::write_atomically(&path, text.as_bytes()).unwrap();
    }

    pub fn create(&self, context: &str, title: &str, body: &str) -> String {
        let _held = crate::write::gate();
        std::fs::create_dir_all(self.root().join(context)).unwrap();
        let id = next_id();
        let now = tick();
        let rel = self.allocate(context, title, None);
        self.write(&rel, &compose(&id, title, None, now, now, body));
        id
    }

    pub fn create_child(&self, parent: &str, title: &str, body: &str) -> String {
        let _held = crate::write::gate();
        let parent = self.page(parent).expect("parent exists");
        let folder = crate::paths::strip_md(&parent.path).to_string();
        let id = next_id();
        let now = tick();
        let rel = self.allocate(&folder, title, None);
        self.write(&rel, &compose(&id, title, Some(&parent.id), now, now, body));
        id
    }

    /// Edit with an editor that has the page as it is on disk right now.
    pub fn edit(&self, id: &str, change: impl FnOnce(&str) -> String) {
        let _held = crate::write::gate();
        let page = self.page(id).expect("page exists");
        let body = change(body_of(&page.text));
        let text = with_body(
            &set_fields(&page.text, &[("updatedAt", tick().to_string())]),
            &body,
        );
        self.write(&page.path, &text);
    }

    pub fn append(&self, id: &str, line: &str) {
        self.edit(id, |body| format!("{}\n{line}", body.trim_end()));
    }

    /// An editor holding the page as it is now, to save later from.
    pub fn open(&self, id: &str) -> Editor {
        let page = self.page(id).expect("page exists");
        Editor {
            id: id.to_string(),
            context: context_of(&page.path).to_string(),
            base: page.text,
        }
    }

    pub fn retitle(&self, id: &str, title: &str) {
        let _held = crate::write::gate();
        let page = self.page(id).expect("page exists");
        let folder = parent_of(&page.path);
        let dest = self.allocate(&folder, title, Some(&page.path));
        self.move_page(&page.path, &dest);
        let text = set_fields(
            &page.text,
            &[("title", json(title)), ("updatedAt", tick().to_string())],
        );
        self.write(&dest, &text);
    }

    /// Move a page (and everything under it) under another page, or to the top
    /// of its context.
    pub fn move_under(&self, id: &str, parent: Option<&str>) {
        let _held = crate::write::gate();
        let page = self.page(id).expect("page exists");
        let context = context_of(&page.path);
        let (folder, parent_id) = match parent {
            Some(parent) => {
                let parent = self.page(parent).expect("parent exists");
                if parent
                    .path
                    .starts_with(&format!("{}/", crate::paths::strip_md(&page.path)))
                {
                    return; // under itself
                }
                (
                    crate::paths::strip_md(&parent.path).to_string(),
                    json(&parent.id),
                )
            }
            None => (context.to_string(), "null".to_string()),
        };
        if parent_of(&page.path) == folder {
            return;
        }
        let title = field_str(&page.text, "title").unwrap_or_default();
        let dest = self.allocate(&folder, &title, Some(&page.path));
        self.move_page(&page.path, &dest);
        let text = set_fields(&page.text, &[("parentId", parent_id)]);
        self.write(&dest, &text);
    }

    pub fn trash(&self, id: &str) {
        let _held = crate::write::gate();
        let page = self.page(id).expect("page exists");
        let bin = format!("{}/Set-Trash", context_of(&page.path));
        let title = field_str(&page.text, "title").unwrap_or_default();
        let dest = self.allocate(&bin, &title, None);
        self.move_page(&page.path, &dest);
    }

    pub fn restore(&self, id: &str) {
        let _held = crate::write::gate();
        self.restore_held(id);
    }

    /// As `FsPageStore.restore`: a page that came back live keeps the id; this one gets another.
    fn restore_held(&self, id: &str) {
        let page = self.trashed_page(id).expect("page is in the trash");
        let context = context_of(&page.path).to_string();
        let title = field_str(&page.text, "title").unwrap_or_default();
        let dest = self.allocate(&context, &title, None);
        let live = self.pages();
        self.move_page(&page.path, &dest);
        let mut fields = vec![("parentId", "null".to_string())];
        if live.contains_key(id) {
            let mut fresh = crate::page_id::derive(&format!("{id}/{}", page.path));
            while live.contains_key(&fresh) {
                fresh = crate::page_id::derive(&fresh);
            }
            fields.push(("id", json(&fresh)));
        }
        self.write(&dest, &set_fields(&page.text, &fields));
    }

    /// Empty one page out of the trash, children and all. Answers the text of
    /// every note that went.
    pub fn delete_forever(&self, id: &str) -> Vec<String> {
        let _held = crate::write::gate();
        let page = self.trashed_page(id).expect("page is in the trash");
        let mut gone = vec![page.text.clone()];
        let folder = self.root().join(crate::paths::strip_md(&page.path));
        if folder.is_dir() {
            for (path, _) in manifest::build(&folder).files {
                if manifest::is_note(&path) {
                    gone.push(std::fs::read_to_string(folder.join(path)).unwrap_or_default());
                }
            }
            std::fs::remove_dir_all(&folder).unwrap();
        }
        std::fs::remove_file(self.root().join(&page.path)).unwrap();
        gone
    }

    pub fn add_image(&self, id: &str, name: &str, bytes: &[u8]) -> String {
        let page = self.page(id).expect("page exists");
        let rel = format!(
            "{}/Set-page-assets/{name}",
            crate::paths::strip_md(&page.path)
        );
        let path = self.root().join(&rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, bytes).unwrap();
        rel
    }

    fn move_page(&self, from: &str, to: &str) {
        if from == to {
            return;
        }
        let root = self.root();
        std::fs::create_dir_all(root.join(to).parent().unwrap()).unwrap();
        std::fs::rename(root.join(from), root.join(to)).unwrap();
        let (old_dir, new_dir) = (crate::paths::strip_md(from), crate::paths::strip_md(to));
        if root.join(old_dir).is_dir() {
            std::fs::rename(root.join(old_dir), root.join(new_dir)).unwrap();
        }
    }

    /// Every file, and what it says.
    pub fn snapshot(&self) -> BTreeMap<String, Hash> {
        manifest::build(self.root())
            .files
            .into_iter()
            .map(|(p, e)| (p, e.content))
            .collect()
    }

    pub fn contexts(&self) -> BTreeSet<String> {
        manifest::build(self.root()).contexts
    }

    pub fn paths(&self) -> Vec<String> {
        self.snapshot().into_keys().collect()
    }

    /// Everything every note says, run together, the trash's included.
    pub fn all_text(&self) -> String {
        let live = self.pages().into_values();
        live.chain(self.trash_pages())
            .map(|page| page.text + "\n")
            .collect()
    }

    pub fn conflict_copies(&self) -> Vec<String> {
        self.paths()
            .into_iter()
            .filter(|p| p.contains("(conflict from"))
            .collect()
    }

    /// No page id twice, nothing under a scratch name, in the journal or in the spool.
    pub fn assert_healthy(&self) {
        let mut seen: BTreeMap<String, String> = BTreeMap::new();
        for (path, entry) in manifest::build(self.root()).files {
            if !manifest::is_note(&path) {
                continue;
            }
            if let Some(id) = entry.page_id {
                if let Some(other) = seen.insert(id.clone(), path.clone()) {
                    panic!(
                        "{}: page id {id} is held by both {other} and {path}",
                        self.name
                    );
                }
            }
        }
        let mut stray = Vec::new();
        walk(self.root(), self.root(), &mut stray);
        assert!(stray.is_empty(), "{}: left behind {stray:?}", self.name);
        let dirs = self.dirs();
        for dir in [dirs.journal, dirs.spool] {
            if let Ok(entries) = std::fs::read_dir(&dir) {
                let left: Vec<_> = entries.flatten().map(|e| e.path()).collect();
                assert!(
                    left.is_empty(),
                    "{}: {left:?} left in {}",
                    self.name,
                    dir.display()
                );
            }
        }
    }
}

/// A simulated crash is a panic; keep it from burying real failures.
pub fn answering(
    answer: impl Fn(&round::Review) -> bool + Send + Sync + 'static,
) -> round::Approve {
    Arc::new(move |review| {
        let go = answer(&review);
        Box::pin(async move { go })
    })
}

fn quiet_crashes() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            let simulated = info
                .payload()
                .downcast_ref::<String>()
                .is_some_and(|m| m.starts_with("simulated crash"));
            if !simulated {
                previous(info);
            }
        }));
    });
}

fn walk(dir: &Path, root: &Path, out: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if path.is_dir() {
            walk(&path, root, out);
        } else if name.starts_with(".set-sync") || name.ends_with(".set-tmp") {
            out.push(
                path.strip_prefix(root)
                    .unwrap()
                    .to_string_lossy()
                    .into_owned(),
            );
        }
    }
}

fn round_device(
    root: &Path,
    state: &Path,
    identity: &Identity,
    lock: &Arc<tokio::sync::Mutex<()>>,
    hook: &Arc<Mutex<Option<Hook>>>,
) -> round::Device {
    let hook = hook.clone();
    round::Device {
        root: root.to_path_buf(),
        dirs: Dirs::under(state),
        identity: identity.clone(),
        lock: lock.clone(),
        written: Arc::new(|_| {}),
        hook: Some(Arc::new(move |stage| {
            let guard = hook.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(hook) = guard.as_ref() {
                hook(stage);
            }
        })),
    }
}

#[derive(Clone, Debug)]
pub struct Page {
    pub id: String,
    pub path: String,
    pub text: String,
}

/// As the app saves: against the version it loaded, merging if the file changed, keeping both if it
/// cannot.
pub struct Editor {
    pub id: String,
    base: String,
    context: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Saved {
    Plain,
    Merged,
    /// The two rewrote the same lines: the editor's version became a copy.
    Forked,
    /// The page was gone from disk; it was put back with the edit.
    Recreated,
    /// The page had been moved to the trash; it was brought back out, and the
    /// edit folded into it.
    Restored,
}

impl Editor {
    pub fn save(&mut self, device: &Folder, change: impl FnOnce(&str) -> String) -> Saved {
        let _held = crate::write::gate();
        let body = change(body_of(&self.base));
        let ours = with_body(
            &set_fields(&self.base, &[("updatedAt", tick().to_string())]),
            &body,
        );
        // As `workspace.foldChangeOnDisk`.
        let restored = device.page(&self.id).is_none() && device.trashed_page(&self.id).is_some();
        if restored {
            device.restore_held(&self.id);
        }
        let Some(page) = device.page(&self.id) else {
            // As `FsPageStore.recreate`.
            let parent = field_str(&ours, "parentId").and_then(|id| device.page(&id));
            let (folder, parent_id) = match &parent {
                Some(p) => (crate::paths::strip_md(&p.path).to_string(), json(&p.id)),
                None => (self.context.clone(), "null".to_string()),
            };
            std::fs::create_dir_all(device.root().join(&folder)).unwrap();
            let title = field_str(&ours, "title").unwrap_or_default();
            let rel = device.allocate(&folder, &title, None);
            let text = set_fields(&ours, &[("parentId", parent_id)]);
            device.write(&rel, &text);
            self.base = text;
            return Saved::Recreated;
        };
        if page.text == self.base {
            device.write(&page.path, &ours);
            self.base = ours;
            return if restored {
                Saved::Restored
            } else {
                Saved::Plain
            };
        }
        match crate::write::merge_note(self.base.clone(), ours.clone(), page.text.clone()) {
            Some(merged) => {
                device.write(&page.path, &merged);
                self.base = merged;
                if restored {
                    Saved::Restored
                } else {
                    Saved::Merged
                }
            }
            None => {
                let title = field_str(&ours, "title").unwrap_or_default();
                let copy_title = format!("{title} (conflict from this device)");
                let id = next_id();
                let rel = device.allocate(&parent_of(&page.path), &copy_title, None);
                let copy = set_fields(&ours, &[("id", json(&id)), ("title", json(&copy_title))]);
                device.write(&rel, &copy);
                self.base = page.text;
                Saved::Forked
            }
        }
    }
}

pub fn compose(
    id: &str,
    title: &str,
    parent: Option<&str>,
    created: u64,
    updated: u64,
    body: &str,
) -> String {
    format!(
        "---\nid: {}\ntitle: {}\nparentId: {}\ncreatedAt: {created}\nupdatedAt: {updated}\n---\n\n{}\n",
        json(id),
        json(title),
        parent.map_or("null".to_string(), json),
        body.trim_end_matches('\n')
    )
}

pub fn json(value: &str) -> String {
    serde_json::to_string(value).unwrap()
}

pub fn body_of(text: &str) -> &str {
    crate::sync::merge::split(text).1
}

pub fn field_str(text: &str, key: &str) -> Option<String> {
    let (front, _) = crate::sync::merge::split(text);
    let raw = &front.iter().find(|(k, _)| k == key)?.1;
    serde_json::from_str::<String>(raw).ok()
}

fn with_body(text: &str, body: &str) -> String {
    let (front, _) = crate::sync::merge::split(text);
    let lines: Vec<String> = front.iter().map(|(k, v)| format!("{k}: {v}")).collect();
    format!(
        "---\n{}\n---\n\n{}\n",
        lines.join("\n"),
        body.trim_end_matches('\n')
    )
}

fn set_fields(text: &str, fields: &[(&str, String)]) -> String {
    let (mut front, body) = crate::sync::merge::split(text);
    for (key, value) in fields {
        match front.iter_mut().find(|(k, _)| k == key) {
            Some(slot) => slot.1 = value.clone(),
            None => front.push((key.to_string(), value.clone())),
        }
    }
    let lines: Vec<String> = front.iter().map(|(k, v)| format!("{k}: {v}")).collect();
    format!("---\n{}\n---\n\n{}", lines.join("\n"), body)
}

/// Whether a trashed page is one the app lists: `<context>/Set-Trash/<page>.md`.
pub fn directly_in_a_bin(path: &str) -> bool {
    let parts: Vec<&str> = path.split('/').collect();
    parts.len() == 3 && parts[1].eq_ignore_ascii_case(manifest::TRASH_DIR)
}

fn join(folder: &str, name: &str) -> String {
    if folder.is_empty() {
        name.to_string()
    } else {
        format!("{folder}/{name}")
    }
}

fn parent_of(path: &str) -> String {
    path.rsplit_once('/')
        .map_or(String::new(), |(d, _)| d.to_string())
}

fn context_of(path: &str) -> &str {
    path.split('/').next().unwrap_or("Set")
}

/// Sync every pair until a whole pass changes nothing, and check they agree.
pub async fn converge(devices: &[&Device]) {
    let mut history = Vec::new();
    for pass in 0..12 {
        let mut changed = 0;
        let mut reports = Vec::new();
        for i in 0..devices.len() {
            for j in (i + 1)..devices.len() {
                let report = devices[i].sync(devices[j]).await.unwrap_or_else(|e| {
                    panic!("{} with {}: {e}", devices[i].name, devices[j].name)
                });
                changed += report.changed_here + report.changed_there;
                reports.push(format!(
                    "{} with {}: {report:?}",
                    devices[i].name, devices[j].name
                ));
            }
        }
        if changed == 0 {
            for device in devices {
                device.assert_healthy();
            }
            for pair in devices.windows(2) {
                assert_same(pair[0], pair[1]);
            }
            return;
        }
        history.push(reports);
        if pass == 11 {
            let mut state = String::new();
            let differing: BTreeSet<String> = devices
                .iter()
                .flat_map(|d| d.snapshot().into_iter())
                .filter(|(path, hash)| devices.iter().any(|d| d.snapshot().get(path) != Some(hash)))
                .map(|(path, _)| path)
                .collect();
            for device in devices {
                state.push_str(&format!("[{}]\n", device.name));
                let files = manifest::build(device.root()).files;
                for path in &differing {
                    let entry = files.get(path);
                    state.push_str(&format!(
                        "  {path} id={:?} content={:?} updated={:?}\n    {:?}\n",
                        entry.and_then(|e| e.page_id.clone()),
                        entry.map(|e| e.content),
                        entry.map(|e| e.updated_at),
                        std::fs::read_to_string(device.root().join(path))
                            .ok()
                            .map(|t| body_of(&t).to_string())
                    ));
                }
                for other in devices {
                    if other.name == device.name {
                        continue;
                    }
                    let stored = crate::sync::state::baselines(
                        &device.dirs().baselines,
                        &other.endpoint.id(),
                    );
                    for (g, generation) in stored.generations.iter().enumerate() {
                        for path in &differing {
                            state.push_str(&format!(
                                "  base with {} gen {g} {:02x?}: {path} {:?}\n",
                                other.name,
                                &generation.id[..2],
                                generation
                                    .base
                                    .files
                                    .get(path)
                                    .map(|e| (e.page_id.clone(), e.content))
                            ));
                        }
                    }
                }
            }
            panic!(
                "never settled. Last passes:\n{}\n{}",
                history[history.len().saturating_sub(2)..]
                    .iter()
                    .map(|r| r.join("\n"))
                    .collect::<Vec<_>>()
                    .join("\n---\n"),
                state
            );
        }
    }
}

pub fn assert_same(a: &Folder, b: &Folder) {
    let (sa, sb) = (a.snapshot(), b.snapshot());
    if sa != sb {
        let only_a: Vec<_> = sa.keys().filter(|k| !sb.contains_key(*k)).collect();
        let only_b: Vec<_> = sb.keys().filter(|k| !sa.contains_key(*k)).collect();
        let differ: Vec<_> = sa
            .iter()
            .filter(|(k, v)| sb.get(*k).is_some_and(|w| w != *v))
            .map(|(k, _)| k)
            .collect();
        panic!(
            "{} and {} disagree.\n only on {}: {only_a:?}\n only on {}: {only_b:?}\n different: {differ:?}",
            a.name, b.name, a.name, b.name
        );
    }
    assert_eq!(
        a.contexts(),
        b.contexts(),
        "{} and {} have different contexts",
        a.name,
        b.name
    );
}
