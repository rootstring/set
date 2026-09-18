use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::path::{Path, PathBuf};

use iroh::{EndpointId, SecretKey, TransportAddr};
use serde::{Deserialize, Serialize};

use super::manifest::{self, Hash, Manifest};
use super::pairing;

const CONFIG_FILE: &str = "sync.json";
const BASELINE_DIR: &str = "sync-baselines";
const ANCESTORS_DIR: &str = "sync-ancestors";
const SPOOL_DIR: &str = "sync-spool";
const JOURNAL_DIR: &str = "sync-journal";
const LINEAGE_FILE: &str = "sync-lineage.postcard";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct PairedDevice {
    pub id: EndpointId,

    pub name: String,
    pub paired_at: f64,

    pub addrs: BTreeSet<TransportAddr>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claim: Option<pairing::Secret>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub enabled: bool,

    pub device_name: String,

    pub notes_id: String,

    #[serde(with = "secret_key_hex")]
    pub secret_key: SecretKey,

    pub pairing_secret: pairing::Secret,
    pub paired: Vec<PairedDevice>,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            enabled: false,
            device_name: default_device_name(),
            notes_id: uuid::Uuid::new_v4().to_string(),
            secret_key: SecretKey::generate(),
            pairing_secret: pairing::Secret::generate(),
            paired: Vec::new(),
        }
    }
}

impl Config {
    pub fn endpoint_id(&self) -> EndpointId {
        self.secret_key.public()
    }

    pub fn is_paired(&self, id: &EndpointId) -> bool {
        self.paired.iter().any(|d| &d.id == id)
    }
}

pub fn load() -> Result<Config, String> {
    let path = config_file()?;
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| {
            format!(
                "reading {}: {e} (left in place, not overwritten)",
                path.display()
            )
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let fresh = Config::default();
            save(&fresh)?;
            Ok(fresh)
        }
        Err(e) => Err(format!("reading {}: {e}", path.display())),
    }
}

pub fn save(config: &Config) -> Result<(), String> {
    let path = config_file()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("creating {}: {e}", parent.display()))?;
    }
    let text = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    write_private(&path, text.as_bytes())
        .map_err(|e| format!("writing {}: {e}", path.display()))?;
    Ok(())
}

#[cfg(unix)]
fn write_private(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(bytes)?;

    file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    file.sync_all()
}

#[cfg(not(unix))]
fn write_private(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    std::fs::write(path, bytes)
}

/// The config directory in the app; a temp dir in tests.
#[derive(Clone, Debug)]
pub struct Dirs {
    pub baselines: PathBuf,
    pub ancestors: PathBuf,
    pub spool: PathBuf,
    pub journal: PathBuf,
    pub lineage: PathBuf,
}

impl Dirs {
    pub fn under(dir: &Path) -> Self {
        Dirs {
            baselines: dir.join(BASELINE_DIR),
            ancestors: dir.join(ANCESTORS_DIR),
            spool: dir.join(SPOOL_DIR),
            journal: dir.join(JOURNAL_DIR),
            lineage: dir.join(LINEAGE_FILE),
        }
    }

    pub fn app() -> Result<Self, String> {
        let dir = crate::config::config_dir().ok_or("no config directory")?;
        Ok(Dirs::under(&dir))
    }
}

// A baseline is what two devices last agreed they both hold; it makes every decision three-way.
// Both store the same one; two generations are kept so a round cut off mid-commit still leaves one
// both have.

pub type GenerationId = [u8; 16];

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Generation {
    pub id: GenerationId,
    pub base: Manifest,
}

impl Generation {
    pub fn new(base: Manifest) -> Self {
        Generation {
            id: rand::random(),
            base,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Baselines {
    /// Newest first.
    pub generations: Vec<Generation>,

    /// How the peer finds out its own lineage was put back (`Mark`).
    pub peer_lineage: Option<Mark>,
}

impl Baselines {
    pub fn ids(&self) -> Vec<GenerationId> {
        self.generations.iter().map(|g| g.id).collect()
    }

    /// The newest generation the peer also holds.
    pub fn shared_with(&self, theirs: &[GenerationId]) -> Option<&Generation> {
        self.generations.iter().find(|g| theirs.contains(&g.id))
    }
}

/// How many generations a device keeps per peer.
const KEPT: usize = 2;

/// Postcard is not self-describing, so the version is what makes "written by another build"
/// certain. Bump it whenever the stored shape changes and teach `decode_baselines` the old layout.
const BASELINE_HEADER: &[u8] = b"set-baseline\x04";

pub fn baselines(dir: &Path, peer: &EndpointId) -> Baselines {
    std::fs::read(baseline_file(dir, peer))
        .ok()
        .and_then(|bytes| decode_baselines(&bytes))
        .unwrap_or_default()
}

/// An unknown layout reads as nothing: a full reconcile, slower but never wrong.
fn decode_baselines(bytes: &[u8]) -> Option<Baselines> {
    postcard::from_bytes(bytes.strip_prefix(BASELINE_HEADER)?).ok()
}

fn save_baselines(dir: &Path, peer: &EndpointId, baselines: &Baselines) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("creating {}: {e}", dir.display()))?;
    let path = baseline_file(dir, peer);
    let mut bytes = BASELINE_HEADER.to_vec();
    bytes.extend(postcard::to_allocvec(baselines).map_err(|e| e.to_string())?);
    crate::write::write_atomically(&path, &bytes)
}

pub fn commit(
    dir: &Path,
    peer: &EndpointId,
    generation: Generation,
    peer_lineage: Mark,
) -> Result<(), String> {
    let mut stored = baselines(dir, peer);
    stored.generations.retain(|g| g.id != generation.id);
    stored.generations.insert(0, generation);
    stored.generations.truncate(KEPT);
    stored.peer_lineage = Some(peer_lineage);
    save_baselines(dir, peer, &stored)
}

pub fn forget_baseline(dir: &Path, peer: &EndpointId) {
    let _ = std::fs::remove_file(baseline_file(dir, peer));
}

/// For a folder that now holds other notes.
pub fn forget_notes(dirs: &Dirs) {
    for dir in [&dirs.baselines, &dirs.ancestors, &dirs.spool] {
        let _ = std::fs::remove_dir_all(dir);
    }
    let _ = std::fs::remove_file(&dirs.lineage);
}

// Per page: the version this device holds (or deleted) and its version vectors. See `plan::Clock`
// for why a pair's baseline is not enough with three devices.

const LINEAGE_HEADER: &[u8] = b"set-lineage\x04";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Line {
    pub version: super::plan::Version,
    /// This device deleted the page, at `stamp`, when it held `version`.
    pub gone: bool,
    pub stamp: super::plan::Stamp,
}

/// A file that stands earlier than a peer remembers has been put back from a backup, and would hand
/// out counts already used.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Mark {
    epoch: [u8; 4],
    serial: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Lineage {
    /// Part of `actor`: a restored file starts a new name, so its reused counts cannot lose to old
    /// versions.
    epoch: [u8; 4],
    /// How many times this file has been written.
    serial: u64,
    pub pages: BTreeMap<String, Line>,
    #[serde(skip)]
    changed: bool,
}

impl Lineage {
    pub fn load(file: &Path) -> Lineage {
        std::fs::read(file)
            .ok()
            .and_then(|bytes| postcard::from_bytes(bytes.strip_prefix(LINEAGE_HEADER)?).ok())
            .unwrap_or_else(|| Lineage {
                epoch: rand::random(),
                changed: true,
                ..Lineage::default()
            })
    }

    pub fn mark(&self) -> Mark {
        Mark {
            epoch: self.epoch,
            serial: self.serial,
        }
    }

    /// Start a new epoch if this file stands earlier than `seen`.
    pub fn catch_up(file: &Path, seen: Option<Mark>) -> Result<(), String> {
        let mut lineage = Lineage::load(file);
        if seen.is_some_and(|seen| seen.epoch == lineage.epoch && seen.serial > lineage.serial) {
            lineage.epoch = rand::random();
            lineage.changed = true;
        }
        lineage.save(file)
    }

    /// What this device's versions are stamped as made by.
    pub fn actor(&self, device_id: &str) -> String {
        format!("{device_id}.{}", crate::hex::encode(&self.epoch))
    }

    /// Written only if something changed since it was loaded.
    pub fn save(&mut self, file: &Path) -> Result<(), String> {
        if !self.changed {
            return Ok(());
        }
        if let Some(dir) = file.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("creating {}: {e}", dir.display()))?;
        }
        self.serial += 1;
        let mut bytes = LINEAGE_HEADER.to_vec();
        bytes.extend(postcard::to_allocvec(self).map_err(|e| e.to_string())?);
        crate::write::write_atomically(file, &bytes)?;
        self.changed = false;
        Ok(())
    }

    /// A version this device had not seen is one it made; kept as soon as seen so no two are
    /// stamped alike.
    pub fn observe(
        &mut self,
        key: &str,
        held: Option<super::plan::Version>,
        me: &str,
    ) -> Option<super::plan::Stamp> {
        use super::plan::{bump, Stamp};
        let line = match (self.pages.get_mut(key), held) {
            (None, None) => return None,
            (None, Some(version)) => {
                self.changed = true;
                let stamp = Stamp {
                    content: bump(&Default::default(), me),
                    place: bump(&Default::default(), me),
                };
                self.pages.insert(
                    key.to_string(),
                    Line {
                        version,
                        gone: false,
                        stamp: stamp.clone(),
                    },
                );
                return Some(stamp);
            }
            (Some(line), None) => {
                if !line.gone {
                    line.gone = true;
                    line.stamp.content = bump(&line.stamp.content, me);
                    line.stamp.place = bump(&line.stamp.place, me);
                    self.changed = true;
                }
                line
            }
            (Some(line), Some((content, place))) => {
                if line.gone || line.version.0 != content {
                    line.stamp.content = bump(&line.stamp.content, me);
                    self.changed = true;
                }
                if line.gone || line.version.1 != place {
                    line.stamp.place = bump(&line.stamp.place, me);
                    self.changed = true;
                }
                line.version = (content, place);
                line.gone = false;
                line
            }
        };
        Some(line.stamp.clone())
    }

    pub fn observe_all(
        file: &Path,
        held: &[(String, Option<super::plan::Version>)],
        device_id: &str,
    ) -> Result<(String, Vec<Option<super::plan::Stamp>>), String> {
        let mut lineage = Lineage::load(file);
        let me = lineage.actor(device_id);
        let stamps = held
            .iter()
            .map(|(key, version)| lineage.observe(key, *version, &me))
            .collect();
        lineage.save(file)?;
        Ok((me, stamps))
    }

    /// Keep everything a round settled in `file`, answering where it stands
    /// afterwards.
    pub fn record_all(file: &Path, settled: &[super::plan::Settled]) -> Result<Mark, String> {
        let mut lineage = Lineage::load(file);
        for page in settled {
            lineage.record(page);
        }
        lineage.save(file)?;
        Ok(lineage.mark())
    }

    /// Record what a round settled.
    pub fn record(&mut self, settled: &super::plan::Settled) {
        use super::plan::{join, Stamp};
        let line = self
            .pages
            .entry(settled.key.clone())
            .or_insert_with(|| Line {
                version: settled.version,
                gone: settled.gone,
                stamp: Stamp::default(),
            });
        line.stamp = Stamp {
            content: join(&line.stamp.content, &settled.stamp.content),
            place: join(&line.stamp.place, &settled.stamp.place),
        };
        line.version = settled.version;
        line.gone = settled.gone;
        self.changed = true;
    }
}

// Ancestor content by content hash, for three-way merges. A cache: a miss is asked of the peer, and
// failing that costs a conflict copy, never an edit.

/// Content past this is never merged (`merge::MAX_MERGE`), so never needed as
/// an ancestor either.
const MAX_ANCESTOR: u64 = super::merge::MAX_MERGE as u64;

pub fn ancestor(dir: &Path, content: &Hash) -> Option<Vec<u8>> {
    let bytes = std::fs::read(dir.join(content.to_hex())).ok()?;
    // A file that does not match its name reads as missing: merging against the wrong ancestor
    // mangles notes.
    (manifest::content_of(&bytes) == *content).then_some(bytes)
}

/// Keep bytes a round has in hand (a merge result, a note fetched from the
/// peer) under their content.
pub fn stash_ancestor(dir: &Path, bytes: &[u8]) {
    if bytes.len() as u64 > MAX_ANCESTOR
        || std::str::from_utf8(bytes).is_err()
        || std::fs::create_dir_all(dir).is_err()
    {
        return;
    }
    let file = dir.join(manifest::content_of(bytes).to_hex());
    if !file.exists() {
        let _ = crate::write::write_cache(&file, bytes);
    }
}

/// Reads only what is not already stored.
pub fn stash_ancestors(dir: &Path, root: &Path, base: &Manifest) {
    if std::fs::create_dir_all(dir).is_err() {
        return;
    }
    for (path, entry) in &base.files {
        if !manifest::is_note(path) || entry.size > MAX_ANCESTOR {
            continue;
        }
        if dir.join(entry.content.to_hex()).exists() {
            continue;
        }
        let Ok(source) = super::apply::resolve(root, path) else {
            continue;
        };
        let Ok(bytes) = std::fs::read(&source) else {
            continue;
        };
        // The file may have been rewritten since; a wrong entry poisons every later merge.
        if manifest::content_of(&bytes) != entry.content {
            continue;
        }
        let _ = crate::write::write_cache(&dir.join(entry.content.to_hex()), &bytes);
    }
}

/// Drop stored content no baseline refers to any more.
pub fn sweep_ancestors(dir: &Path, baselines_dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let Ok(saved) = std::fs::read_dir(baselines_dir) else {
        return; // can't tell what's live; keeping too much beats deleting in use
    };
    let mut keep: HashSet<String> = HashSet::new();
    for file in saved.flatten() {
        let Some(stored) = std::fs::read(file.path())
            .ok()
            .and_then(|bytes| decode_baselines(&bytes))
        else {
            continue;
        };
        for generation in &stored.generations {
            keep.extend(generation.base.files.values().map(|e| e.content.to_hex()));
        }
    }
    for file in entries.flatten() {
        let name = file.file_name().to_string_lossy().into_owned();
        if keep.contains(&name) || just_written(&file) {
            continue;
        }
        let _ = std::fs::remove_file(file.path());
    }
}

/// Content stored moments ago, which no baseline can be expected to mention yet.
fn just_written(file: &std::fs::DirEntry) -> bool {
    const GRACE: std::time::Duration = std::time::Duration::from_secs(5 * 60);

    file.metadata()
        .and_then(|m| m.modified())
        .and_then(|at| at.elapsed().map_err(std::io::Error::other))
        .is_ok_and(|age| age < GRACE)
}

/// On disk, not in memory: a first sync of gigabytes of images.
pub struct Spool {
    dir: PathBuf,
}

impl Spool {
    pub fn open(root: &Path, round: &str) -> Result<Self, String> {
        let dir = root.join(round);
        std::fs::create_dir_all(&dir).map_err(|e| format!("creating {}: {e}", dir.display()))?;
        Ok(Spool { dir })
    }

    /// Store bytes, answering the hash they are filed under.
    pub fn put(&self, bytes: &[u8]) -> Result<Hash, String> {
        let hash = Hash::of(bytes);
        let file = self.dir.join(hash.to_hex());
        if !file.exists() {
            crate::write::write_cache(&file, bytes)?;
        }
        Ok(hash)
    }

    pub fn has(&self, hash: &Hash) -> bool {
        self.dir.join(hash.to_hex()).exists()
    }

    /// Remove every spool, this one's and any a crashed round left.
    pub fn clear_all(root: &Path) {
        let _ = std::fs::remove_dir_all(root);
    }
}

impl super::apply::Blobs for Spool {
    fn get(&self, hash: &Hash) -> Option<Vec<u8>> {
        let bytes = std::fs::read(self.dir.join(hash.to_hex())).ok()?;
        (Hash::of(&bytes) == *hash).then_some(bytes)
    }
}

impl Drop for Spool {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn config_file() -> Result<PathBuf, String> {
    Ok(crate::config::config_dir()
        .ok_or("no config directory")?
        .join(CONFIG_FILE))
}

fn baseline_file(dir: &Path, peer: &EndpointId) -> PathBuf {
    dir.join(format!("{peer}.postcard"))
}

fn default_device_name() -> String {
    let who = std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_else(|_| "Someone".to_string());
    let os = match std::env::consts::OS {
        "macos" => "Mac",
        "windows" => "PC",
        "linux" => "Linux",
        other => other,
    };
    format!("{who}'s {os}")
}

mod secret_key_hex {
    use iroh::SecretKey;
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(key: &SecretKey, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&crate::hex::encode(&key.to_bytes()))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<SecretKey, D::Error> {
        let text = String::deserialize(d)?;
        let bytes: [u8; 32] = crate::hex::decode(&text)
            .ok_or_else(|| serde::de::Error::custom("secret key must be 64 hex digits"))?;
        Ok(SecretKey::from_bytes(&bytes))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::manifest::Entry;
    use crate::testing::TempDir;

    #[test]
    fn a_config_survives_a_round_trip_through_json() {
        let mut config = Config {
            enabled: true,
            ..Config::default()
        };
        config.paired.push(PairedDevice {
            id: SecretKey::generate().public(),
            name: "Laptop".to_string(),
            paired_at: 1_720_000_000_000.0,
            addrs: BTreeSet::new(),
            claim: None,
        });

        let text = serde_json::to_string(&config).expect("serialize");
        let back: Config = serde_json::from_str(&text).expect("deserialize");

        assert_eq!(back.secret_key.to_bytes(), config.secret_key.to_bytes());
        assert!(back.pairing_secret.same_as(&config.pairing_secret));
        assert_eq!(back.notes_id, config.notes_id);
        assert_eq!(back.paired, config.paired);
        assert!(back.enabled);
    }

    #[test]
    fn the_secret_key_is_stored_as_one_hex_line() {
        let config = Config::default();
        let value: serde_json::Value =
            serde_json::from_str(&serde_json::to_string(&config).unwrap()).unwrap();
        let key = value["secretKey"]
            .as_str()
            .expect("hex string, not an array");
        assert_eq!(key.len(), 64);
        assert!(key.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn a_truncated_secret_key_is_rejected_rather_than_padded() {
        let config = |key: &str| {
            format!(
                r#"{{"enabled":false,"deviceName":"x","notesId":"v","secretKey":"{key}","pairingSecret":"{}","paired":[]}}"#,
                "0".repeat(32)
            )
        };
        assert!(serde_json::from_str::<Config>(&config(&"ab".repeat(32))).is_ok());
        assert!(serde_json::from_str::<Config>(&config("abcd")).is_err());
    }

    #[test]
    fn a_fresh_config_is_off_and_paired_with_nobody() {
        let config = Config::default();
        assert!(!config.enabled, "sync must be an affirmative act");
        assert!(config.paired.is_empty());
        assert_eq!(config.endpoint_id(), config.secret_key.public());
    }

    fn entry(bytes: &[u8]) -> Entry {
        manifest::describe_bytes(bytes, "Set/A.md", || 1.0)
    }

    fn base_of(items: &[(&str, &[u8])]) -> Manifest {
        Manifest {
            files: items
                .iter()
                .map(|(p, b)| (p.to_string(), entry(b)))
                .collect(),
            contexts: ["Set".to_string()].into_iter().collect(),
        }
    }

    #[test]
    fn a_committed_generation_is_what_comes_back_and_the_one_before_is_kept() {
        let dir = TempDir::new("baseline-generations");
        let peer = SecretKey::generate().public();
        let first = Generation::new(base_of(&[("Set/A.md", b"one")]));
        let second = Generation::new(base_of(&[("Set/A.md", b"two")]));
        let third = Generation::new(base_of(&[("Set/A.md", b"three")]));
        let mark = Lineage::default().mark();

        commit(dir.path(), &peer, first.clone(), mark).unwrap();
        commit(dir.path(), &peer, second.clone(), mark).unwrap();
        let stored = baselines(dir.path(), &peer);
        assert_eq!(stored.generations, vec![second.clone(), first.clone()]);

        commit(dir.path(), &peer, third.clone(), mark).unwrap();
        let stored = baselines(dir.path(), &peer);
        assert_eq!(
            stored.ids(),
            vec![third.id, second.id],
            "two are kept, no more"
        );

        // A peer that missed the newest commit still shares the one before.
        assert_eq!(stored.shared_with(&[second.id, first.id]), Some(&second));
        assert_eq!(stored.shared_with(&[first.id]), None);
    }

    #[test]
    fn a_baseline_in_a_layout_nobody_knows_reads_as_none() {
        let dir = TempDir::new("baseline-unknown");
        let peer = SecretKey::generate().public();
        std::fs::create_dir_all(dir.path()).unwrap();
        std::fs::write(baseline_file(dir.path(), &peer), b"set-baseline\x09garbage").unwrap();
        assert_eq!(baselines(dir.path(), &peer), Baselines::default());
        std::fs::write(baseline_file(dir.path(), &peer), b"\x01\x02\x03").unwrap();
        assert_eq!(baselines(dir.path(), &peer), Baselines::default());
    }

    #[test]
    fn ancestors_are_found_by_content_whichever_device_saved_them() {
        let store = TempDir::new("ancestors");
        let mine = b"---\nid: \"p\"\nupdatedAt: 1\n---\n\nbody\n";
        let theirs = b"---\nid: \"p\"\nupdatedAt: 2\n---\n\nbody\n";
        stash_ancestor(&store.0, mine);
        let found = ancestor(&store.0, &manifest::content_of(theirs));
        assert_eq!(found.as_deref(), Some(mine.as_slice()));
        assert_eq!(
            ancestor(&store.0, &manifest::content_of(b"never stored")),
            None
        );
    }

    #[test]
    fn a_corrupt_ancestor_reads_as_missing() {
        let store = TempDir::new("ancestors-corrupt");
        let content = manifest::content_of(b"the real thing");
        std::fs::write(store.0.join(content.to_hex()), b"something else").unwrap();
        assert_eq!(ancestor(&store.0, &content), None);
    }

    #[test]
    fn stashing_from_the_folder_skips_attachments_and_anything_that_moved_on() {
        let notes = TempDir::new("stash-notes");
        let store = TempDir::new("stash");
        notes.write("Set/A.md", "note body");
        notes.write("Set/B.md", "what it says now");
        notes.write("Set/A/Set-page-assets/k.png", "pretend png");

        let mut base = base_of(&[
            ("Set/A.md", b"note body"),
            ("Set/B.md", b"what it said then"),
        ]);
        base.files.insert(
            "Set/A/Set-page-assets/k.png".to_string(),
            manifest::describe_bytes(b"pretend png", "Set/A/Set-page-assets/k.png", || 1.0),
        );
        stash_ancestors(&store.0, &notes.0, &base);

        assert!(ancestor(&store.0, &manifest::content_of(b"note body")).is_some());
        assert!(ancestor(&store.0, &manifest::content_of(b"what it said then")).is_none());
        assert!(ancestor(&store.0, &manifest::content_of(b"what it says now")).is_none());
        assert_eq!(std::fs::read_dir(&store.0).unwrap().count(), 1);
    }

    #[test]
    fn the_sweep_keeps_what_any_kept_generation_points_at() {
        let store = TempDir::new("sweep");
        let dirs = TempDir::new("sweep-baselines");
        let peer = SecretKey::generate().public();

        for body in [b"older generation".as_slice(), b"newest", b"nobody's"] {
            stash_ancestor(&store.0, body);
        }
        commit(
            &dirs.0,
            &peer,
            Generation::new(base_of(&[("Set/A.md", b"older generation")])),
            Lineage::default().mark(),
        )
        .unwrap();
        commit(
            &dirs.0,
            &peer,
            Generation::new(base_of(&[("Set/A.md", b"newest")])),
            Lineage::default().mark(),
        )
        .unwrap();

        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(3600);
        for entry in std::fs::read_dir(&store.0).unwrap().flatten() {
            std::fs::File::options()
                .write(true)
                .open(entry.path())
                .unwrap()
                .set_modified(old)
                .unwrap();
        }
        sweep_ancestors(&store.0, &dirs.0);

        assert!(ancestor(&store.0, &manifest::content_of(b"older generation")).is_some());
        assert!(ancestor(&store.0, &manifest::content_of(b"newest")).is_some());
        assert!(ancestor(&store.0, &manifest::content_of(b"nobody's")).is_none());
    }

    #[test]
    fn forgetting_the_notes_leaves_nothing_to_measure_another_folder_against() {
        let dir = TempDir::new("forget-notes");
        let dirs = Dirs::under(&dir.0);
        let peer = SecretKey::generate().public();
        let held = [(
            "id:a".to_string(),
            Some((Hash::of(b"v1"), Hash::of(b"Set/A.md"))),
        )];
        let (before, _) = Lineage::observe_all(&dirs.lineage, &held, "device").unwrap();
        let generation = Generation::new(base_of(&[("Set/A.md", b"one")]));
        commit(
            &dirs.baselines,
            &peer,
            generation,
            Lineage::default().mark(),
        )
        .unwrap();
        stash_ancestor(&dirs.ancestors, b"one");

        forget_notes(&dirs);

        assert_eq!(baselines(&dirs.baselines, &peer), Baselines::default());
        assert!(Lineage::load(&dirs.lineage).pages.is_empty());
        assert_ne!(Lineage::load(&dirs.lineage).actor("device"), before);
        assert_eq!(
            ancestor(&dirs.ancestors, &manifest::content_of(b"one")),
            None
        );
    }

    #[test]
    fn a_lineage_lost_or_put_back_starts_again_under_a_new_name() {
        let dir = TempDir::new("lineage-epoch");
        let file = Dirs::under(&dir.0).lineage;
        let held = [(
            "id:a".to_string(),
            Some((Hash::of(b"v1"), Hash::of(b"Set/A.md"))),
        )];

        let (first, _) = Lineage::observe_all(&file, &held, "device").unwrap();
        let (again, _) = Lineage::observe_all(&file, &held, "device").unwrap();
        assert_eq!(first, again, "one file, one name");
        let backup = std::fs::read(&file).unwrap();
        let seen = Lineage::record_all(&file, &settled()).unwrap();

        // Where a peer last saw it: nothing to do.
        Lineage::catch_up(&file, Some(seen)).unwrap();
        assert_eq!(Lineage::load(&file).actor("device"), first);

        // Put back to before that: the counts it holds have been used since.
        std::fs::write(&file, backup).unwrap();
        Lineage::catch_up(&file, Some(seen)).unwrap();
        let renamed = Lineage::load(&file).actor("device");
        assert_ne!(renamed, first);

        // Lost altogether: a new file is a new name too.
        std::fs::remove_file(&file).unwrap();
        let (fresh, _) = Lineage::observe_all(&file, &held, "device").unwrap();
        assert!(fresh != first && fresh != renamed);
    }

    fn settled() -> Vec<crate::sync::plan::Settled> {
        vec![crate::sync::plan::Settled {
            key: "id:a".to_string(),
            version: (Hash::of(b"v2"), Hash::of(b"Set/A.md")),
            gone: false,
            stamp: Default::default(),
        }]
    }

    #[test]
    fn a_version_is_stamped_once_and_every_change_after_is_newer() {
        use crate::sync::plan::{covers, newer_clock};
        let dir = TempDir::new("lineage");
        let file = Dirs::under(&dir.0).lineage;
        let h = |s: &str| Hash::of(s.as_bytes());
        let mut lineage = Lineage::default();

        assert_eq!(lineage.observe("id:a", None, "me"), None, "never held");
        let first = lineage
            .observe("id:a", Some((h("v1"), h("Set/A.md"))), "me")
            .unwrap();
        assert_eq!(
            lineage
                .observe("id:a", Some((h("v1"), h("Set/A.md"))), "me")
                .as_ref(),
            Some(&first),
            "seen again, the same version"
        );
        lineage.save(&file).unwrap();
        let mut lineage = Lineage::load(&file);

        let edited = lineage
            .observe("id:a", Some((h("v2"), h("Set/A.md"))), "me")
            .unwrap();
        assert!(newer_clock(&edited.content, &first.content));
        assert_eq!(edited.place, first.place, "an edit isn't a move");

        let moved = lineage
            .observe("id:a", Some((h("v2"), h("Set/B.md"))), "me")
            .unwrap();
        assert!(newer_clock(&moved.place, &edited.place));

        let deleted = lineage.observe("id:a", None, "me").unwrap();
        assert!(newer_clock(&deleted.content, &moved.content));
        assert!(newer_clock(&deleted.place, &moved.place));
        assert_eq!(
            lineage.observe("id:a", None, "me"),
            Some(deleted.clone()),
            "deleted once"
        );

        // What a round settles is kept, joined with what was here.
        let mut theirs = deleted.clone();
        theirs.content.insert("peer".into(), 4);
        lineage.record(&crate::sync::plan::Settled {
            key: "id:a".into(),
            version: (h("v9"), h("Set/C.md")),
            gone: false,
            stamp: theirs.clone(),
        });
        let back = lineage
            .observe("id:a", Some((h("v9"), h("Set/C.md"))), "me")
            .unwrap();
        assert_eq!(back, theirs);
        assert!(covers(&back.content, &deleted.content));
    }

    #[test]
    fn a_spool_hands_back_only_bytes_that_match_their_name() {
        use crate::sync::apply::Blobs;
        let root = TempDir::new("spool");
        let spool = Spool::open(&root.0, "r1").unwrap();
        let hash = spool.put(b"an image").unwrap();
        assert!(spool.has(&hash));
        assert_eq!(spool.get(&hash).as_deref(), Some(b"an image".as_slice()));
        std::fs::write(root.0.join("r1").join(hash.to_hex()), b"tampered").unwrap();
        assert_eq!(spool.get(&hash), None);
        drop(spool);
        assert!(
            !root.0.join("r1").exists(),
            "a spool is gone once its round is"
        );
    }
}
