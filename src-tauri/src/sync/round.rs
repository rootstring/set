//! The device that pressed "Sync now" coordinates: takes both round locks, plans, previews, applies
//! its half, sends the other half, then has both store what they agree on. The other end only
//! answers. Nothing here knows about Tauri.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use iroh::endpoint::Connection;
use iroh::EndpointId;

use super::apply::{self, Applied, Result_};
use super::manifest::{self, Hash, Manifest};
use super::plan::{self, Blob, Kind, Op, Plan, Side};
use super::preview::{self, Preview};
use super::protocol::{self, Request, Response};
use super::session::{self, Failure, Identity};
use super::state::{self, GenerationId, Spool};

/// So the folder watcher can tell them from outside edits.
pub type Written = Arc<dyn Fn(&[PathBuf]) + Send + Sync>;

/// Points a test can act at, to land an edit mid-round.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stage {
    /// Both folders read and the plan made; nothing applied.
    Planned,
    /// This device's half applied.
    AppliedHere,
    /// Both halves applied; nothing agreed yet.
    AppliedThere,
}

pub type Hook = Arc<dyn Fn(Stage) + Send + Sync>;

#[derive(Clone)]
pub struct Device {
    pub root: PathBuf,
    pub dirs: state::Dirs,
    pub identity: Identity,
    /// Whichever end it is on.
    pub lock: Arc<tokio::sync::Mutex<()>>,
    pub written: Written,
    pub hook: Option<Hook>,
}

impl Device {
    fn at(&self, stage: Stage) {
        if let Some(hook) = &self.hook {
            hook(stage);
        }
    }

    fn wrote(&self, paths: &[PathBuf]) {
        if !paths.is_empty() {
            (self.written)(paths);
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TooBig {
    pub path: String,
    pub size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Conflict {
    pub path: String,
    pub kept_as: String,
}

#[derive(Debug, Default)]
pub struct Report {
    /// Groups of changes applied on the device that coordinated.
    pub changed_here: usize,
    /// And on the other one.
    pub changed_there: usize,
    pub merged: Vec<String>,
    pub conflicts: Vec<Conflict>,
    pub too_big: Vec<TooBig>,
    /// Files that changed while the round ran, left for the next one.
    pub deferred: Vec<String>,
    /// Files a device couldn't read where it last held them, left alone on both.
    pub unreadable: Vec<String>,
    /// Changes that failed part way, and why.
    pub failed: Vec<String>,
}

/// How a round that ran into no trouble ended.
#[derive(Debug)]
pub enum Round {
    Done(Report),
    /// Planned, shown, and turned down: nothing was applied on either device.
    Declined,
}

/// A round cannot be taken back as a whole, so this is the one moment to look.
pub struct Review {
    pub preview: Preview,
    /// Reads files: for a blocking thread.
    pub diff: Diff,
}

pub type Diff = Arc<dyn Fn(&str) -> Option<preview::Diff> + Send + Sync>;

/// Both devices' round locks are held while it is answered.
pub type Approve = Arc<dyn Fn(Review) -> Pin<Box<dyn Future<Output = bool> + Send>> + Send + Sync>;

/// How many times a round asks a busy device before giving up.
const BUSY_ATTEMPTS: u32 = 12;

/// Coordinate one round with the device at the other end of `connection`.
pub async fn coordinate(
    device: &Device,
    connection: &Connection,
    peer: EndpointId,
    peer_name: &str,
    approve: &Approve,
) -> Result<Round, Failure> {
    hello(device, connection).await?;
    let stored = state::baselines(&device.dirs.baselines, &peer);
    let (_held, theirs) = begin(device, connection, stored.peer_lineage).await?;

    prepare(device).await?;

    let remote_seen = match ask(connection, Request::Manifest).await? {
        Response::Manifest(seen) => seen,
        other => return Err(reply_failure("manifest", other)),
    };
    let local_seen = scan(&device.root).await?;
    let (local, remote) = (&local_seen.manifest, &remote_seen.manifest);

    let base = stored
        .shared_with(&theirs)
        .map(|generation| generation.base.clone())
        .unwrap_or_default();

    let lineages = lineages(device, connection, &base, local, remote).await?;
    let (draft, wants) = plan::draft(
        &base,
        &local_seen,
        &remote_seen,
        protocol::MAX_FILE,
        &lineages,
    );
    let round = round_id();
    let spool =
        Arc::new(Spool::open(&device.dirs.spool, &round).map_err(|e| Failure::new("spool", e))?);

    let fetched = fetch(connection, &wants.remote, remote, &spool).await?;
    let local_bytes = {
        let root = device.root.clone();
        let wanted = wants.local.clone();
        blocking(move || {
            wanted
                .into_iter()
                .filter_map(|(path, hash)| {
                    let bytes = std::fs::read(apply::resolve(&root, &path).ok()?).ok()?;
                    (Hash::of(&bytes) == hash).then_some((path, bytes))
                })
                .collect::<HashMap<_, _>>()
        })
        .await?
    };
    let ancestors = ancestors(device, connection, &wants.ancestors).await?;

    let provider = Here {
        root: device.root.clone(),
        local: local_bytes,
        spool: spool.clone(),
        fetched,
        ancestors,
    };
    let names = plan::Names {
        local: device.identity.device_name.clone(),
        remote: peer_name.to_string(),
    };
    let plan = blocking(move || plan::finish(draft, &provider, &names)).await?;
    for blob in plan.blobs.values() {
        if let Blob::Made(bytes) = blob {
            spool.put(bytes).map_err(|e| Failure::new("spool", e))?;
        }
    }
    if !plan.is_empty() && !approve(review(device, &plan, local, remote, &spool).await?).await {
        let _ = session::request(
            connection,
            &Request::End {
                merged: Vec::new(),
                conflicts: Vec::new(),
            },
        )
        .await;
        return Ok(Round::Declined);
    }
    device.at(Stage::Planned);

    let here = if plan.local.is_empty() {
        Applied::default()
    } else {
        let (root, journal, batches, spool, round) = (
            device.root.clone(),
            device.dirs.journal.clone(),
            plan.local.clone(),
            spool.clone(),
            round.clone(),
        );
        blocking(move || apply::apply(&root, &journal, &round, &batches, spool.as_ref())).await?
    };
    device.wrote(&here.written);
    device.at(Stage::AppliedHere);

    let there = if plan.remote.is_empty() {
        Applied::default()
    } else {
        upload(connection, &plan, &device.root, &spool).await?;
        match ask(
            connection,
            Request::Apply {
                batches: plan.remote.clone(),
            },
        )
        .await?
        {
            Response::Applied(applied) => applied,
            other => return Err(reply_failure("apply", other)),
        }
    };
    device.at(Stage::AppliedThere);

    let (agreed, settled) = agreed(&plan, local, remote, &here, &there);
    let generation = state::Generation::new(agreed);
    // Kept before the peer is told: a stamp this device made must never be reused if it is cut off.
    let mark = {
        let (file, settled) = (device.dirs.lineage.clone(), settled.clone());
        blocking(move || state::Lineage::record_all(&file, &settled))
            .await?
            .map_err(|e| Failure::new("lineage", e))?
    };
    let their_mark = match ask(
        connection,
        Request::Commit {
            generation: generation.clone(),
            lineage: settled.clone(),
            mark,
        },
    )
    .await?
    {
        Response::Committed { mark } => mark,
        other => return Err(reply_failure("commit", other)),
    };
    {
        let (dirs, root, made) = (
            device.dirs.clone(),
            device.root.clone(),
            plan.blobs
                .values()
                .filter_map(|b| match b {
                    Blob::Made(bytes) => Some(bytes.clone()),
                    _ => None,
                })
                .collect::<Vec<_>>(),
        );
        let base = generation.base.clone();
        blocking(move || {
            state::commit(&dirs.baselines, &peer, generation, their_mark)?;
            for bytes in made {
                state::stash_ancestor(&dirs.ancestors, &bytes);
            }
            state::stash_ancestors(&dirs.ancestors, &root, &base);
            state::sweep_ancestors(&dirs.ancestors, &dirs.baselines);
            Ok::<(), String>(())
        })
        .await?
        .map_err(|e| Failure::new("baseline", e))?;
    }

    let report = report(&plan, &here, &there);
    // Best effort: the peer releases its lock when the connection closes too.
    let _ = session::request(
        connection,
        &Request::End {
            merged: report.merged.clone(),
            conflicts: report
                .conflicts
                .iter()
                .map(|c| (c.path.clone(), c.kept_as.clone()))
                .collect(),
        },
    )
    .await;
    Ok(Round::Done(report))
}

async fn hello(device: &Device, connection: &Connection) -> Result<(), Failure> {
    let hello = Request::Hello {
        version: protocol::VERSION,
        device_name: device.identity.device_name.clone(),
        notes_id: device.identity.notes_id.clone(),
    };
    match ask(connection, hello).await? {
        Response::Hello {
            version, notes_id, ..
        } => protocol::check_hello(&device.identity.notes_id, &notes_id, version)
            .map_err(Failure::refused),
        other => Err(reply_failure("hello", other)),
    }
}

/// Ours first, and let go while waiting on a busy peer, or two devices pressing at once deadlock. A
/// device that finds its lineage put back starts a new epoch (`state::Mark`).
async fn begin(
    device: &Device,
    connection: &Connection,
    seen: Option<state::Mark>,
) -> Result<(tokio::sync::OwnedMutexGuard<()>, Vec<GenerationId>), Failure> {
    for attempt in 0..BUSY_ATTEMPTS {
        let held = device.lock.clone().lock_owned().await;
        match ask(connection, Request::Begin { seen }).await? {
            Response::Began { generations, seen } => {
                let file = device.dirs.lineage.clone();
                blocking(move || state::Lineage::catch_up(&file, seen))
                    .await?
                    .map_err(|e| Failure::new("lineage", e))?;
                return Ok((held, generations));
            }
            Response::Busy => {
                drop(held);
                let ceiling = 100 + 150 * u64::from(attempt.min(8));
                let wait = rand::random::<u64>() % ceiling + 50;
                tokio::time::sleep(Duration::from_millis(wait)).await;
            }
            other => return Err(reply_failure("begin", other)),
        }
    }
    Err(Failure::new(
        "busy",
        "the other device is busy syncing. Try again in a moment",
    ))
}

/// Put down what a crashed round staged and repair duplicate ids, so the manifest can be trusted.
async fn prepare(device: &Device) -> Result<(), Failure> {
    let (root, journal) = (device.root.clone(), device.dirs.journal.clone());
    let written = blocking(move || {
        let mut written = apply::recover(&root, &journal);
        let _held = crate::write::gate();
        written.extend(super::ids::repair(&root).into_iter().map(|p| root.join(p)));
        written
    })
    .await?;
    device.wrote(&written);
    Ok(())
}

/// Each verified against the hash it was listed with.
async fn fetch(
    connection: &Connection,
    wanted: &BTreeMap<String, Hash>,
    remote: &Manifest,
    spool: &Spool,
) -> Result<HashMap<String, Hash>, Failure> {
    let mut out = HashMap::new();
    let paths: Vec<String> = wanted.keys().cloned().collect();
    let size_of = |path: &str| remote.files.get(path).map_or(0, |e| e.size);
    for batch in protocol::batches(&paths, size_of) {
        match ask(
            connection,
            Request::Fetch {
                paths: batch.clone(),
            },
        )
        .await?
        {
            Response::Files(files) if files.len() == batch.len() => {
                for (path, bytes) in batch.into_iter().zip(files) {
                    let Some(bytes) = bytes else { continue };
                    if Hash::of(&bytes) != wanted[&path] {
                        continue; // changed since it was listed: sits this round out
                    }
                    let hash = spool.put(&bytes).map_err(|e| Failure::new("spool", e))?;
                    out.insert(path, hash);
                }
            }
            Response::Files(files) => {
                return Err(Failure::new(
                    "unexpected_reply",
                    format!(
                        "peer answered {} files for {} requested",
                        files.len(),
                        batch.len()
                    ),
                ))
            }
            other => return Err(reply_failure("fetch", other)),
        }
    }
    Ok(out)
}

/// So the answer for any folder size fits in one message.
const LINEAGE_BATCH: usize = 2_000;

/// This device's copies are observed and kept before the peer is asked.
async fn lineages(
    device: &Device,
    connection: &Connection,
    base: &Manifest,
    local: &Manifest,
    remote: &Manifest,
) -> Result<plan::Lineages, Failure> {
    let questions = plan::questions(base, local, remote);
    let mut out = plan::Lineages::default();
    if questions.is_empty() {
        return Ok(out);
    }

    let (file, me) = (
        device.dirs.lineage.clone(),
        device.identity.device_id.clone(),
    );
    let held: Vec<(String, Option<plan::Version>)> = questions
        .iter()
        .map(|(key, l, _)| (key.clone(), *l))
        .collect();
    let (here, ours) = blocking(move || state::Lineage::observe_all(&file, &held, &me))
        .await?
        .map_err(|e| Failure::new("lineage", e))?;
    out.here = here;
    for ((key, _, _), stamp) in questions.iter().zip(ours) {
        if let Some(stamp) = stamp {
            out.local.insert(key.clone(), stamp);
        }
    }

    for chunk in questions.chunks(LINEAGE_BATCH) {
        let pages = chunk.iter().map(|(key, _, r)| (key.clone(), *r)).collect();
        match ask(connection, Request::Lineage { pages }).await? {
            Response::Lineage { actor, stamps } if stamps.len() == chunk.len() => {
                out.there = actor;
                for ((key, _, _), stamp) in chunk.iter().zip(stamps) {
                    if let Some(stamp) = stamp {
                        out.remote.insert(key.clone(), stamp);
                    }
                }
            }
            other => return Err(reply_failure("lineage", other)),
        }
    }
    Ok(out)
}

/// The base versions of notes to merge: from this device's store, and what it
/// lacks from the peer's.
async fn ancestors(
    device: &Device,
    connection: &Connection,
    wanted: &std::collections::BTreeSet<Hash>,
) -> Result<HashMap<Hash, Vec<u8>>, Failure> {
    let mut out = HashMap::new();
    let mut missing = Vec::new();
    for content in wanted {
        match state::ancestor(&device.dirs.ancestors, content) {
            Some(bytes) => {
                out.insert(*content, bytes);
            }
            None => missing.push(*content),
        }
    }
    if missing.is_empty() {
        return Ok(out);
    }
    if let Response::Files(files) = ask(
        connection,
        Request::Ancestors {
            contents: missing.clone(),
        },
    )
    .await?
    {
        for (content, bytes) in missing.into_iter().zip(files) {
            if let Some(bytes) = bytes.filter(|b| manifest::content_of(b) == content) {
                out.insert(content, bytes);
            }
        }
    }
    Ok(out)
}

/// The plan as someone can read it, and a way to the two versions of each note
/// it rewrites.
async fn review(
    device: &Device,
    plan: &Plan,
    local: &Manifest,
    remote: &Manifest,
    spool: &Arc<Spool>,
) -> Result<Review, Failure> {
    let (mut preview, texts) = preview::of(plan, local, remote);
    let versions = Arc::new(Versions {
        root: device.root.clone(),
        ancestors: device.dirs.ancestors.clone(),
        spool: spool.clone(),
        texts,
    });

    // Title looked up by current name, else by content, which finds a note only the peer still
    // holds.
    let wanted: Vec<(String, Vec<String>, Option<Hash>)> = {
        let moved = |change: &preview::Change| {
            [&change.here, &change.there]
                .into_iter()
                .flatten()
                .filter_map(|action| action.from.clone())
                .collect::<Vec<_>>()
        };
        let listed = preview
            .changes
            .iter()
            .filter(|change| !change.dir)
            .map(|change| (change.path.clone(), moved(change)))
            .chain(preview.unchanged.iter().map(|path| (path.clone(), vec![])));
        listed
            .filter(|(path, _)| manifest::is_note(path))
            .map(|(path, from)| {
                let content = std::iter::once(&path)
                    .chain(&from)
                    .find_map(|held| remote.get(held).or_else(|| local.get(held)))
                    .map(|entry| entry.content);
                let mut held = vec![path.clone()];
                held.extend(from);
                (path, held, content)
            })
            .collect()
    };
    let reader = versions.clone();
    preview.titles = blocking(move || {
        wanted
            .into_iter()
            .filter_map(|(path, held, content)| {
                let title = reader.title(&path, &held, content)?;
                Some((path, title))
            })
            .collect()
    })
    .await?;

    Ok(Review {
        preview,
        diff: Arc::new(move |path: &str| versions.diff(path)),
    })
}

/// This device's files, what was fetched, and for an unedited peer note the last agreed version.
struct Versions {
    root: PathBuf,
    ancestors: PathBuf,
    spool: Arc<Spool>,
    texts: preview::Texts,
}

impl Versions {
    fn on_disk(&self, path: &str) -> Option<Vec<u8>> {
        std::fs::read(apply::resolve(&self.root, path).ok()?).ok()
    }

    /// What the round leaves at `path`, for a note it writes.
    fn after(&self, path: &str) -> Option<Vec<u8>> {
        use super::apply::Blobs;
        let text = self.texts.get(path)?;
        match &text.after_from {
            Blob::Made(bytes) => Some(bytes.clone()),
            Blob::Local(from) => self
                .on_disk(from)
                .filter(|bytes| Hash::of(bytes) == text.after),
            Blob::Remote(_) => self.spool.get(&text.after),
        }
    }

    fn diff(&self, path: &str) -> Option<preview::Diff> {
        use super::apply::Blobs;
        let text = self.texts.get(path)?;
        let after = self.after(path)?;
        let before = match (&text.before, text.side) {
            (None, _) => None,
            (Some(held), Side::Local) => Some(
                self.on_disk(&held.path)
                    .filter(|bytes| Hash::of(bytes) == held.hash)?,
            ),
            (Some(held), Side::Remote) => Some(self.spool.get(&held.hash).or_else(|| {
                held.content
                    .and_then(|content| state::ancestor(&self.ancestors, &content))
            })?),
        };
        preview::diff(text.side, before.as_deref(), &after)
    }

    /// The title of the note that ends up at `path`: as the round writes it,
    /// or else as it is held now, at one of `held` or under `content`.
    fn title(&self, path: &str, held: &[String], content: Option<Hash>) -> Option<String> {
        let bytes = self
            .after(path)
            .or_else(|| held.iter().find_map(|path| self.on_disk(path)))
            .or_else(|| state::ancestor(&self.ancestors, &content?))?;
        preview::title_of(&bytes)
    }
}

/// Send the peer the bytes its half of the plan writes.
async fn upload(
    connection: &Connection,
    plan: &Plan,
    root: &Path,
    spool: &Spool,
) -> Result<(), Failure> {
    let mut needed: Vec<Hash> = Vec::new();
    let mut seen = HashSet::new();
    for batch in &plan.remote {
        for op in &batch.ops {
            if let Op::Write { blob, .. } = op {
                if seen.insert(*blob) {
                    needed.push(*blob);
                }
            }
        }
    }

    let mut pending: Vec<Vec<u8>> = Vec::new();
    let mut pending_bytes = 0u64;
    for hash in needed {
        let bytes = match plan.blobs.get(&hash) {
            Some(Blob::Made(bytes)) => Some(bytes.clone()),
            Some(Blob::Local(path)) => {
                let path = apply::resolve(root, path).map_err(|e| Failure::new("apply", e))?;
                blocking(move || std::fs::read(path).ok())
                    .await?
                    .filter(|b| Hash::of(b) == hash)
            }
            Some(Blob::Remote(_)) | None => {
                use super::apply::Blobs;
                spool.get(&hash)
            }
        };
        // A file that changed since listing is not sent; the write is refused on the other side and
        // the next round has it.
        let Some(bytes) = bytes else { continue };
        let size = bytes.len() as u64;
        if !pending.is_empty()
            && (pending.len() >= protocol::FETCH_BATCH_FILES
                || pending_bytes + size > protocol::FETCH_BATCH_BYTES)
        {
            send_upload(connection, std::mem::take(&mut pending)).await?;
            pending_bytes = 0;
        }
        pending_bytes += size;
        pending.push(bytes);
    }
    if !pending.is_empty() {
        send_upload(connection, pending).await?;
    }
    Ok(())
}

async fn send_upload(connection: &Connection, blobs: Vec<Vec<u8>>) -> Result<(), Failure> {
    match ask(connection, Request::Upload { blobs }).await? {
        Response::Ok => Ok(()),
        other => Err(reply_failure("upload", other)),
    }
}

/// A group counts only if it went through on both sides; otherwise the old baseline entry is kept,
/// always a true ancestor.
pub fn agreed(
    plan: &Plan,
    local: &Manifest,
    remote: &Manifest,
    here: &Applied,
    there: &Applied,
) -> (Manifest, Vec<plan::Settled>) {
    let post = |pre: &Manifest, applied: &Applied, path: &str| match applied.touched.get(path) {
        Some(entry) => entry.clone(),
        None => pre.files.get(path).cloned(),
    };
    let mut out = Manifest::default();
    for skipped in &plan.skipped {
        out.files.extend(skipped.fallback.iter().cloned());
    }
    let mut settled = Vec::new();
    let mut lineage = Vec::new();
    for outcome in &plan.outcomes {
        let went_through = |applied: &Applied| {
            applied
                .results
                .get(&outcome.group)
                .is_none_or(|r| *r == Result_::Applied)
        };
        let finals: Option<Vec<_>> = outcome
            .finals
            .iter()
            .map(
                |f| match (post(local, here, &f.path), post(remote, there, &f.path)) {
                    (Some(l), Some(r)) if l.content == f.content && r.content == f.content => {
                        Some((f.path.clone(), l))
                    }
                    _ => None,
                },
            )
            .collect();
        match finals {
            Some(finals) if went_through(here) && went_through(there) => {
                let main = match (outcome.finals.first(), &outcome.deleted) {
                    (Some(main), _) => Some((main, false)),
                    (None, Some(deleted)) => Some((deleted, true)),
                    (None, None) => None,
                };
                if let Some((main, gone)) = main {
                    lineage.push(plan::Settled {
                        key: outcome.key.clone(),
                        version: (main.content, plan::place_of(&main.path)),
                        gone,
                        stamp: outcome.stamp.clone(),
                    });
                }
                settled.extend(finals);
            }
            _ => out.files.extend(outcome.fallback.iter().cloned()),
        }
    }
    out.files.extend(settled);
    out.contexts = plan.contexts.clone();
    (out, lineage)
}

fn report(plan: &Plan, here: &Applied, there: &Applied) -> Report {
    let mut report = Report {
        changed_here: here.changed(),
        changed_there: there.changed(),
        ..Report::default()
    };

    for outcome in &plan.outcomes {
        let ran = [here, there].iter().any(|a| {
            a.results
                .get(&outcome.group)
                .is_some_and(|r| *r == Result_::Applied)
        });
        let path = || {
            outcome
                .finals
                .first()
                .map(|f| f.path.clone())
                .unwrap_or_default()
        };
        match &outcome.kind {
            Kind::Merged if ran => report.merged.push(path()),
            Kind::Conflict { copy } if ran => report.conflicts.push(Conflict {
                path: path(),
                kept_as: copy.clone(),
            }),
            _ => {}
        }
        for applied in [here, there] {
            match applied.results.get(&outcome.group) {
                Some(Result_::Refused(_)) => report.deferred.push(path()),
                Some(Result_::Failed(why)) => report.failed.push(why.clone()),
                _ => {}
            }
        }
    }
    for skipped in &plan.skipped {
        match skipped.why {
            plan::Skip::TooBig { size } => report.too_big.push(TooBig {
                path: skipped.path.clone(),
                size,
            }),
            plan::Skip::Moving => report.deferred.push(skipped.path.clone()),
            plan::Skip::Unreadable => report.unreadable.push(skipped.path.clone()),
        }
    }
    report.deferred.sort();
    report.deferred.dedup();
    report
}

/// Bytes for the plan, as this round gathered them.
struct Here {
    root: PathBuf,
    local: HashMap<String, Vec<u8>>,
    spool: Arc<Spool>,
    fetched: HashMap<String, Hash>,
    ancestors: HashMap<Hash, Vec<u8>>,
}

impl plan::Provider for Here {
    fn bytes(&self, side: Side, path: &str, hash: &Hash) -> Option<Vec<u8>> {
        use super::apply::Blobs;
        match side {
            Side::Local => self
                .local
                .get(path)
                .filter(|b| Hash::of(b) == *hash)
                .cloned(),
            Side::Remote => (self.fetched.get(path) == Some(hash))
                .then(|| self.spool.get(hash))
                .flatten(),
        }
    }

    fn present(&self, side: Side, path: &str, hash: &Hash) -> bool {
        match side {
            Side::Local => apply::resolve(&self.root, path)
                .ok()
                .and_then(|p| std::fs::read(p).ok())
                .is_some_and(|b| Hash::of(&b) == *hash),
            Side::Remote => self.fetched.get(path) == Some(hash),
        }
    }

    fn ancestor(&self, content: &Hash) -> Option<Vec<u8>> {
        self.ancestors.get(content).cloned()
    }
}

/// What a round did on the device that only answered, for its own UI.
#[derive(Debug, Clone, Default)]
pub struct Answered {
    pub changed: usize,
    pub merged: Vec<String>,
    pub conflicts: Vec<Conflict>,
}

pub type OnEnd = Arc<dyn Fn(Answered) + Send + Sync>;

struct Active {
    _held: tokio::sync::OwnedMutexGuard<()>,
    id: String,
    spool: Arc<Spool>,
    changed: usize,
}

/// One connection's worth of answering.
pub struct Session {
    device: Device,
    peer: EndpointId,
    round: tokio::sync::Mutex<Option<Active>>,
    on_end: OnEnd,
}

impl Session {
    pub fn new(device: Device, peer: EndpointId, on_end: OnEnd) -> Self {
        Session {
            device,
            peer,
            round: tokio::sync::Mutex::new(None),
            on_end,
        }
    }

    /// Pairing claims and refusing unpaired devices are the caller's.
    pub async fn answer(&self, request: Request) -> Response {
        match self.answer_inner(request).await {
            Ok(response) => response,
            Err(message) => Response::Error(message),
        }
    }

    async fn answer_inner(&self, request: Request) -> Result<Response, String> {
        let device = &self.device;
        Ok(match request {
            Request::Hello {
                version, notes_id, ..
            } => match protocol::check_hello(&device.identity.notes_id, &notes_id, version) {
                Ok(()) => Response::Hello {
                    version: protocol::VERSION,
                    device_name: device.identity.device_name.clone(),
                    notes_id: device.identity.notes_id.clone(),
                },
                Err(refusal) => Response::Refused {
                    code: refusal.code().to_string(),
                    message: refusal.to_string(),
                },
            },

            Request::Begin { seen } => {
                let mut slot = self.round.lock().await;
                if slot.is_none() {
                    let Ok(held) = device.lock.clone().try_lock_owned() else {
                        return Ok(Response::Busy);
                    };
                    prepare(device).await.map_err(|f| f.message)?;
                    let file = device.dirs.lineage.clone();
                    blocking(move || state::Lineage::catch_up(&file, seen))
                        .await
                        .map_err(|f| f.message)??;
                    let id = round_id();
                    let spool = Spool::open(&device.dirs.spool, &id)?;
                    *slot = Some(Active {
                        _held: held,
                        id,
                        spool: Arc::new(spool),
                        changed: 0,
                    });
                }
                let stored = state::baselines(&device.dirs.baselines, &self.peer);
                Response::Began {
                    generations: stored.ids(),
                    seen: stored.peer_lineage,
                }
            }

            Request::Manifest => {
                Response::Manifest(scan(&device.root).await.map_err(|f| f.message)?)
            }

            Request::Fetch { paths } => {
                let root = device.root.clone();
                let files = blocking(move || {
                    paths
                        .iter()
                        .map(|p| {
                            let abs = apply::resolve(&root, p).ok()?;
                            // "Could not read it" costs just this file, not the whole reply.
                            if std::fs::metadata(&abs).ok()?.len() > protocol::MAX_FILE {
                                return None;
                            }
                            std::fs::read(abs).ok()
                        })
                        .collect::<Vec<_>>()
                })
                .await
                .map_err(|f| f.message)?;
                Response::Files(files)
            }

            Request::Ancestors { contents } => Response::Files(
                contents
                    .iter()
                    .map(|c| state::ancestor(&device.dirs.ancestors, c))
                    .collect(),
            ),

            Request::Upload { blobs } => {
                let slot = self.round.lock().await;
                let active = slot.as_ref().ok_or("no round has been started")?;
                for bytes in blobs {
                    active.spool.put(&bytes)?;
                }
                Response::Ok
            }

            Request::Apply { batches } => {
                let mut slot = self.round.lock().await;
                let active = slot.as_mut().ok_or("no round has been started")?;
                let (root, journal, spool, id) = (
                    device.root.clone(),
                    device.dirs.journal.clone(),
                    active.spool.clone(),
                    active.id.clone(),
                );
                let applied =
                    blocking(move || apply::apply(&root, &journal, &id, &batches, spool.as_ref()))
                        .await
                        .map_err(|f| f.message)?;
                device.wrote(&applied.written);
                active.changed += applied.changed();
                Response::Applied(applied)
            }

            Request::Lineage { pages } => {
                let slot = self.round.lock().await;
                slot.as_ref().ok_or("no round has been started")?;
                let (file, me) = (
                    device.dirs.lineage.clone(),
                    device.identity.device_id.clone(),
                );
                let (actor, stamps) =
                    blocking(move || state::Lineage::observe_all(&file, &pages, &me))
                        .await
                        .map_err(|f| f.message)??;
                Response::Lineage { actor, stamps }
            }

            Request::Commit {
                generation,
                lineage: settled,
                mark: their_mark,
            } => {
                let slot = self.round.lock().await;
                slot.as_ref().ok_or("no round has been started")?;
                let (dirs, root, peer) = (device.dirs.clone(), device.root.clone(), self.peer);
                let mark = blocking(move || {
                    let base = generation.base.clone();
                    state::commit(&dirs.baselines, &peer, generation, their_mark)?;
                    let mark = state::Lineage::record_all(&dirs.lineage, &settled)?;
                    state::stash_ancestors(&dirs.ancestors, &root, &base);
                    state::sweep_ancestors(&dirs.ancestors, &dirs.baselines);
                    Ok::<_, String>(mark)
                })
                .await
                .map_err(|f| f.message)??;
                Response::Committed { mark }
            }

            Request::End { merged, conflicts } => {
                if let Some(active) = self.round.lock().await.take() {
                    (self.on_end)(Answered {
                        changed: active.changed,
                        merged,
                        conflicts: conflicts
                            .into_iter()
                            .map(|(path, kept_as)| Conflict { path, kept_as })
                            .collect(),
                    });
                }
                Response::Ok
            }

            Request::Claim { .. } => {
                return Err("a pairing claim was routed to the wrong place".to_string())
            }
        })
    }
}

impl Drop for Session {
    /// A connection closed mid-round still changed the folder.
    fn drop(&mut self) {
        if let Some(active) = self.round.get_mut().take() {
            if active.changed > 0 {
                (self.on_end)(Answered {
                    changed: active.changed,
                    ..Answered::default()
                });
            }
        }
    }
}

async fn ask(connection: &Connection, request: Request) -> Result<Response, Failure> {
    match session::request(connection, &request)
        .await
        .map_err(session::transport)?
    {
        Response::Refused { code, message } => Err(Failure::new(code, message)),
        Response::Error(e) => Err(Failure::from_peer(e)),
        other => Ok(other),
    }
}

fn reply_failure(what: &str, response: Response) -> Failure {
    Failure::unexpected(what, &response)
}

pub async fn scan(root: &Path) -> Result<manifest::Scan, Failure> {
    let root = root.to_path_buf();
    blocking(move || manifest::scan(&root))
        .await?
        .map_err(|e| Failure::new("notes_folder", e))
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, Failure> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| Failure::new("internal", e.to_string()))
}

fn round_id() -> String {
    crate::hex::encode(&rand::random::<[u8; 4]>())
}
