//! Every operation names the bytes it was planned from and is refused otherwise, under the write
//! gate. Nothing is removed before its replacement is in place: files are staged under hidden names
//! with a journal, and `recover` puts them down after a crash. Nothing the peer let go of is
//! destroyed; it goes to this device's trash.

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::manifest::{self, Entry, Hash};
use super::plan::{Batch, Op};

/// How one group of operations went.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Result_ {
    Applied,
    /// A file wasn't what the plan was made from. Nothing of the group ran.
    Refused(String),
    /// Something failed part way; what did run left nothing lost.
    Failed(String),
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct Applied {
    pub results: BTreeMap<u32, Result_>,
    /// Every path the operations named, as it is now.
    pub touched: BTreeMap<String, Option<Entry>>,
    /// Files this run wrote or put down, for the folder watcher.
    #[serde(skip)]
    pub written: Vec<PathBuf>,
}

impl Applied {
    /// Includes the ones that failed part way.
    pub fn changed(&self) -> usize {
        self.results
            .values()
            .filter(|r| matches!(r, Result_::Applied | Result_::Failed(_)))
            .count()
    }
}

/// Where the bytes for a write come from.
pub trait Blobs {
    fn get(&self, hash: &Hash) -> Option<Vec<u8>>;
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
struct Staged {
    /// The hidden name it sits under, relative to the notes root.
    tmp: String,
    origin: String,
    /// `None` for a file leaving the folder.
    target: Option<String>,
    /// Where in the trash it is wanted, for one leaving by way of the trash.
    trash: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct Journal {
    root: String,
    staged: Vec<Staged>,
}

#[derive(PartialEq)]
enum Phase {
    Ready,
    Refused(String),
    /// Failed before anything of the group was written.
    Undone(String),
    /// Failed with some of the group already written.
    Partial(String),
}

pub fn apply(
    root: &Path,
    journals: &Path,
    round: &str,
    batches: &[Batch],
    blobs: &dyn Blobs,
) -> Applied {
    let _held = crate::write::gate();
    let mut out = Applied::default();
    let mut phase: Vec<Phase> = Vec::with_capacity(batches.len());
    let mut cased: HashSet<PathBuf> = HashSet::new();

    // Look: every file the group depends on is still the one planned from.
    for batch in batches {
        phase.push(match verify(root, batch, blobs) {
            Ok(()) => Phase::Ready,
            Err(why) => Phase::Refused(why),
        });
    }

    // Stage everything that moves or goes away, journal first.
    let mut staged: Vec<Vec<Staged>> = vec![Vec::new(); batches.len()];
    // What each file being removed outright was planned to hold, by the hidden
    // name it is staged under.
    let mut superseded: std::collections::HashMap<String, Hash> = Default::default();
    let mut n = 0usize;
    for (b, batch) in batches.iter().enumerate() {
        if phase[b] != Phase::Ready {
            continue;
        }
        for op in &batch.ops {
            let (origin, target, trash) = match op {
                Op::Move { from, to, .. } => (from, Some(to.clone()), None),
                Op::Trash { path, to, .. } => (path, None, Some(to.clone())),
                Op::Delete { path, .. } => (path, None, None),
                _ => continue,
            };
            n += 1;
            let dir = origin.rsplit_once('/').map(|(d, _)| d);
            let name = format!(".set-sync-{round}-{n}");
            let tmp = match dir {
                Some(dir) => format!("{dir}/{name}"),
                None => name,
            };
            if let Op::Delete { expect, .. } = op {
                superseded.insert(tmp.clone(), *expect);
            }
            staged[b].push(Staged {
                tmp,
                origin: origin.clone(),
                target,
                trash,
            });
        }
    }
    let journal_path = journals.join(format!("{round}.json"));
    let all: Vec<Staged> = staged.iter().flatten().cloned().collect();
    if !all.is_empty() {
        let journal = Journal {
            root: root.to_string_lossy().into_owned(),
            staged: all,
        };
        let written = std::fs::create_dir_all(journals).is_ok()
            && serde_json::to_vec(&journal)
                .ok()
                .is_some_and(|bytes| crate::write::write_atomically(&journal_path, &bytes).is_ok());
        if !written {
            // Without a journal a crash could strand a file under a hidden name.
            for (b, list) in staged.iter().enumerate() {
                if !list.is_empty() && phase[b] == Phase::Ready {
                    phase[b] = Phase::Undone("couldn't write the sync journal".to_string());
                }
            }
        }
    }
    for b in 0..batches.len() {
        if phase[b] != Phase::Ready {
            continue;
        }
        for i in 0..staged[b].len() {
            let s = &staged[b][i];
            if let Err(e) = rename(root, &s.origin, &s.tmp) {
                for earlier in staged[b][..i].iter().rev() {
                    let _ = rename(root, &earlier.tmp, &earlier.origin);
                }
                phase[b] = Phase::Undone(e);
                break;
            }
        }
    }

    // Contexts first, so a write into a new one finds it there.
    for (b, batch) in batches.iter().enumerate() {
        if phase[b] != Phase::Ready {
            continue;
        }
        for op in &batch.ops {
            if let Op::MakeDir { name } = op {
                if let Ok(dir) = resolve(root, name) {
                    if let Err(e) = std::fs::create_dir_all(&dir) {
                        phase[b] = Phase::Undone(format!("making {name}: {e}"));
                    }
                }
            }
        }
    }

    // Leap: the writes, in the order the group lists them.
    for (b, batch) in batches.iter().enumerate() {
        if phase[b] != Phase::Ready {
            continue;
        }
        let mut wrote_any = false;
        for op in &batch.ops {
            let Op::Write { path, blob, expect } = op else {
                continue;
            };
            let result = (|| -> Result<(), String> {
                let target = resolve(root, path)?;
                let fits = match expect {
                    None => std::fs::symlink_metadata(&target).is_err(),
                    Some(h) => hash_of(&target) == Some(*h),
                };
                if !fits {
                    return Err(format!("{path} changed since this round was planned"));
                }
                let bytes = blobs
                    .get(blob)
                    .ok_or_else(|| format!("the bytes for {path} never arrived"))?;
                if Hash::of(&bytes) != *blob {
                    return Err(format!("the bytes for {path} arrived damaged"));
                }
                realize_case(root, path, &mut cased);
                ensure_parent(&target)?;
                crate::write::write_atomically(&target, &bytes)?;
                out.written.push(target);
                Ok(())
            })();
            match result {
                Ok(()) => wrote_any = true,
                Err(e) => {
                    phase[b] = if wrote_any {
                        Phase::Partial(e)
                    } else {
                        Phase::Undone(e)
                    };
                    break;
                }
            }
        }
    }

    // A group undone before writing gets everything back; one that failed part way keeps what was
    // leaving.
    let mut bin = Bin::default();
    for (b, list) in staged.iter().enumerate() {
        for s in list {
            if !exists(root, &s.tmp) {
                continue;
            }
            let restore = match &phase[b] {
                Phase::Ready => false,
                Phase::Undone(_) | Phase::Refused(_) => true,
                Phase::Partial(_) => s.target.is_none(),
            };
            let spot = match (&s.target, &s.trash) {
                _ if restore => Some(s.origin.clone()),
                (Some(target), _) => Some(target.clone()),
                (None, Some(wanted)) => Some(bin.place(root, wanted)),
                // Something other than the app may have written between the look and the staging;
                // then it goes back rather than away.
                (None, None) => {
                    let as_planned = resolve(root, &s.tmp)
                        .ok()
                        .is_some_and(|tmp| hash_of(&tmp) == superseded.get(&s.tmp).copied());
                    (!as_planned).then(|| s.origin.clone())
                }
            };
            let Some(spot) = spot else {
                if let Ok(tmp) = resolve(root, &s.tmp) {
                    let _ = std::fs::remove_file(tmp);
                }
                continue;
            };
            match put_down(root, &s.tmp, &spot, &mut cased) {
                Some(path) => {
                    if !restore && s.target.is_none() {
                        touch(&path);
                    }
                    out.written.push(path);
                }
                // It couldn't be put where it was going. Back where it came
                // from is better than under a hidden name.
                None => {
                    if let Some(path) = put_down(root, &s.tmp, &s.origin, &mut cased) {
                        out.written.push(path);
                    }
                    if phase[b] == Phase::Ready {
                        phase[b] = Phase::Partial(format!("{} couldn't be moved", s.origin));
                    }
                }
            }
        }
    }
    let _ = std::fs::remove_file(&journal_path);

    // Never a context and never the root.
    let mut emptied: BTreeSet<String> = BTreeSet::new();
    for list in &staged {
        for s in list {
            let mut dir = s.origin.rsplit_once('/').map(|(d, _)| d.to_string());
            while let Some(d) = dir {
                if !d.contains('/') {
                    break;
                }
                emptied.insert(d.clone());
                dir = d.rsplit_once('/').map(|(p, _)| p.to_string());
            }
        }
    }
    // Deepest first, so a parent is looked at once its children are gone.
    let mut emptied: Vec<String> = emptied.into_iter().collect();
    emptied.sort_by_key(|d| std::cmp::Reverse(d.matches('/').count()));
    for dir in emptied {
        if let Ok(abs) = resolve(root, &dir) {
            remove_if_empty(&abs);
        }
    }

    // Contexts removed on the other side go last, once the folders inside them
    // that this run emptied are gone, and only if nothing is left in them.
    for (b, batch) in batches.iter().enumerate() {
        if phase[b] != Phase::Ready {
            continue;
        }
        for op in &batch.ops {
            if let Op::RemoveDir { name } = op {
                retire_context(root, name);
            }
        }
    }

    for (b, batch) in batches.iter().enumerate() {
        for op in &batch.ops {
            for path in op_paths(op) {
                out.touched
                    .entry(path.to_string())
                    .or_insert_with(|| manifest::describe(root, path));
            }
        }
        let result = match std::mem::replace(&mut phase[b], Phase::Ready) {
            Phase::Ready => Result_::Applied,
            Phase::Refused(why) => Result_::Refused(why),
            Phase::Undone(why) => Result_::Refused(why),
            Phase::Partial(why) => Result_::Failed(why),
        };
        out.results.insert(batch.group, result);
    }
    out
}

fn verify(root: &Path, batch: &Batch, blobs: &dyn Blobs) -> Result<(), String> {
    for op in &batch.ops {
        match op {
            Op::Move {
                from: path, expect, ..
            }
            | Op::Trash { path, expect, .. }
            | Op::Delete { path, expect } => {
                let abs = resolve(root, path)?;
                if hash_of(&abs) != Some(*expect) {
                    return Err(format!("{path} changed since this round was planned"));
                }
            }
            Op::Write { path, blob, expect } => {
                let abs = resolve(root, path)?;
                if let Some(h) = expect {
                    if hash_of(&abs) != Some(*h) {
                        return Err(format!("{path} changed since this round was planned"));
                    }
                }
                if blobs.get(blob).is_none() {
                    return Err(format!("the bytes for {path} never arrived"));
                }
            }
            Op::MakeDir { name } | Op::RemoveDir { name } => {
                resolve(root, name)?;
            }
        }
    }
    Ok(())
}

fn op_paths(op: &Op) -> Vec<&str> {
    match op {
        Op::Move { from, to, .. } => vec![from, to],
        Op::Trash { path, .. } | Op::Delete { path, .. } | Op::Write { path, .. } => vec![path],
        Op::MakeDir { .. } | Op::RemoveDir { .. } => vec![],
    }
}

/// Safe to call at any time.
pub fn recover(root: &Path, journals: &Path) -> Vec<PathBuf> {
    let _held = crate::write::gate();
    let mut written = Vec::new();
    let mut cased = HashSet::new();
    let Ok(entries) = std::fs::read_dir(journals) else {
        return written;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().is_none_or(|e| e != "json") {
            continue;
        }
        let Some(journal) = std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Journal>(&bytes).ok())
        else {
            continue;
        };
        if Path::new(&journal.root) != root {
            // Another notes folder's. Left for when that folder is back.
            continue;
        }
        for s in journal.staged {
            if !exists(root, &s.tmp) {
                continue;
            }
            // Where it was going if that is free, where it came from if not.
            let spot = match &s.target {
                Some(target) if !exists(root, target) => target.clone(),
                _ => s.origin.clone(),
            };
            if let Some(put) = put_down(root, &s.tmp, &spot, &mut cased) {
                written.push(put);
            }
        }
        let _ = std::fs::remove_file(&path);
    }
    written
}

/// Rename `tmp` to `wanted`, or to the first free name beside it. Answers where
/// it landed.
fn put_down(root: &Path, tmp: &str, wanted: &str, cased: &mut HashSet<PathBuf>) -> Option<PathBuf> {
    realize_case(root, wanted, cased);
    let spot = free_near(root, wanted);
    let to = resolve(root, &spot).ok()?;
    ensure_parent(&to).ok()?;
    rename(root, tmp, &spot).ok()?;
    Some(to)
}

fn free_near(root: &Path, wanted: &str) -> String {
    super::plan::numbered(wanted)
        .find(|candidate| !exists(root, candidate))
        .expect("some number is always free")
}

/// A case-insensitive filesystem lets `Notes/` answer for `notes/`, stranding a renamed page's
/// children in the old folder. Renamed only where the two names are one folder.
fn realize_case(root: &Path, rel: &str, cased: &mut HashSet<PathBuf>) {
    if resolve(root, rel).is_err() {
        return; // never a name outside the notes folder
    }
    let Some((dirs, _)) = rel.rsplit_once('/') else {
        return;
    };
    let mut parent = root.to_path_buf();
    for wanted in dirs.split('/').filter(|part| !part.is_empty()) {
        let here = parent.join(wanted);
        if !cased.contains(&here) {
            if !std::fs::symlink_metadata(&here).is_ok_and(|m| m.is_dir()) {
                return; // not there at all: it is made with the right name
            }
            let names: Vec<String> = match std::fs::read_dir(&parent) {
                Ok(entries) => entries
                    .flatten()
                    .map(|e| e.file_name().to_string_lossy().into_owned())
                    .collect(),
                Err(_) => return,
            };
            if !names.iter().any(|n| n == wanted) {
                let fold = manifest::fold(wanted);
                if let Some(actual) = names.iter().find(|n| manifest::fold(n) == fold) {
                    // Best effort: a filesystem that can't rename by case alone
                    // leaves the folder as it is, which is where it was anyway.
                    let _ = std::fs::rename(parent.join(actual), &here);
                }
            }
            cased.insert(here.clone());
        }
        parent = here;
    }
}

fn exists(root: &Path, rel: &str) -> bool {
    resolve(root, rel).is_ok_and(|p| std::fs::symlink_metadata(p).is_ok())
}

fn rename(root: &Path, from: &str, to: &str) -> Result<(), String> {
    let (from_abs, to_abs) = (resolve(root, from)?, resolve(root, to)?);
    ensure_parent(&to_abs)?;
    std::fs::rename(&from_abs, &to_abs).map_err(|e| format!("moving {from} to {to}: {e}"))
}

fn hash_of(path: &Path) -> Option<Hash> {
    let meta = std::fs::symlink_metadata(path).ok()?;
    if !meta.is_file() {
        return None;
    }
    std::fs::read(path).ok().map(|bytes| Hash::of(&bytes))
}

/// The plan does not know what the trash already holds, so the top of each path moves to the first
/// free name.
#[derive(Default)]
struct Bin {
    /// Wanted top (`Work/Set-Trash/Plan`) to the one given.
    given: std::collections::HashMap<String, String>,
}

impl Bin {
    fn place(&mut self, root: &Path, wanted: &str) -> String {
        let marker = format!("/{}/", manifest::TRASH_DIR);
        let Some(at) = wanted.find(&marker) else {
            return wanted.to_string();
        };
        let (bin, rest) = (
            &wanted[..at + marker.len() - 1],
            &wanted[at + marker.len()..],
        );
        let (top, below) = match rest.split_once('/') {
            Some((top, below)) => (top, Some(below)),
            None => (rest, None),
        };
        // A page and its folder are one name: `Plan.md`, `Plan/`.
        let page = below.is_some() || manifest::is_note(top);
        let base = if page {
            crate::paths::strip_md(top)
        } else {
            top
        };
        let key = format!("{bin}/{base}");
        let given = match self.given.get(&key) {
            Some(given) => given.clone(),
            None => {
                let in_use: HashSet<&String> = self.given.values().collect();
                let free = super::plan::numbered(&key)
                    .find(|candidate| {
                        let taken = in_use.contains(candidate)
                            || exists(root, candidate)
                            || (page && exists(root, &format!("{candidate}.md")));
                        !taken
                    })
                    .expect("some number is always free");
                self.given.insert(key, free.clone());
                free
            }
        };
        match (below, page) {
            (Some(below), _) => format!("{given}/{below}"),
            (None, true) => format!("{given}.md"),
            (None, false) => given,
        }
    }
}

/// The app's trash dates an entry by its file, and a rename keeps the old date.
fn touch(path: &Path) {
    if let Ok(file) = std::fs::File::options().write(true).open(path) {
        let _ = file.set_modified(std::time::SystemTime::now());
    }
}

/// Its own trash goes to the root trash under the context's name, which is how the app shows a
/// restorable context.
fn retire_context(root: &Path, name: &str) {
    let Ok(dir) = resolve(root, name) else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    let mut has_trash = false;
    for entry in entries.flatten() {
        let entry_name = entry.file_name();
        if entry_name.eq_ignore_ascii_case(manifest::TRASH_DIR) {
            has_trash = true;
        } else if entry_name != ".DS_Store" {
            return;
        }
    }
    if !has_trash {
        remove_if_empty(&dir);
        return;
    }
    let wanted = format!("{}/{name}", manifest::TRASH_DIR);
    let free = super::plan::numbered(&wanted)
        .find(|candidate| !exists(root, candidate))
        .expect("some number is always free");
    let _ = rename(root, name, &free);
}

/// Remove a folder that holds nothing but what Finder leaves behind.
fn remove_if_empty(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut litter = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        if name == ".DS_Store" {
            litter.push(entry.path());
        } else {
            return;
        }
    }
    for file in litter {
        let _ = std::fs::remove_file(file);
    }
    let _ = std::fs::remove_dir(dir);
}

fn ensure_parent(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("creating {}: {e}", parent.display()))?;
    }
    Ok(())
}

pub(crate) fn resolve(root: &Path, rel: &str) -> Result<PathBuf, String> {
    if rel.is_empty() {
        return Err("refusing an empty path".to_string());
    }
    let mut out = root.to_path_buf();
    for component in Path::new(rel).components() {
        match component {
            Component::Normal(part) => out.push(part),

            _ => return Err(format!("refusing suspicious path from peer: {rel:?}")),
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::TempDir;
    use std::collections::HashMap;

    struct Mem(HashMap<Hash, Vec<u8>>);

    impl Mem {
        fn of(items: &[&str]) -> (Self, Vec<Hash>) {
            let mut map = HashMap::new();
            let mut hashes = Vec::new();
            for item in items {
                let h = Hash::of(item.as_bytes());
                map.insert(h, item.as_bytes().to_vec());
                hashes.push(h);
            }
            (Mem(map), hashes)
        }
    }

    impl Blobs for Mem {
        fn get(&self, hash: &Hash) -> Option<Vec<u8>> {
            self.0.get(hash).cloned()
        }
    }

    fn h(text: &str) -> Hash {
        Hash::of(text.as_bytes())
    }

    fn batch(group: u32, ops: Vec<Op>) -> Batch {
        Batch { group, ops }
    }

    fn no_blobs() -> Mem {
        Mem(HashMap::new())
    }

    fn leftovers(d: &TempDir) -> Vec<String> {
        let mut out = Vec::new();
        fn walk(dir: &Path, root: &Path, out: &mut Vec<String>) {
            for e in std::fs::read_dir(dir).unwrap().flatten() {
                let p = e.path();
                if p.is_dir() {
                    walk(&p, root, out);
                } else {
                    let name = e.file_name().to_string_lossy().into_owned();
                    if name.starts_with(".set-sync") || name.ends_with(".set-tmp") {
                        out.push(p.strip_prefix(root).unwrap().to_string_lossy().into_owned());
                    }
                }
            }
        }
        walk(&d.0, &d.0, &mut out);
        out
    }

    #[test]
    fn a_move_a_write_and_a_delete_land_as_planned() {
        let d = TempDir::new("apply-basic");
        let j = TempDir::new("apply-journal");
        d.write("Set/A.md", "a");
        d.write("Set/Gone.md", "gone");
        d.write("Set/Old/Child.md", "child");
        let (blobs, hashes) = Mem::of(&["new"]);

        let applied = apply(
            &d.0,
            &j.0,
            "r1",
            &[
                batch(
                    0,
                    vec![Op::Move {
                        from: "Set/A.md".into(),
                        to: "Set/B.md".into(),
                        expect: h("a"),
                    }],
                ),
                batch(
                    1,
                    vec![Op::Write {
                        path: "Set/New.md".into(),
                        blob: hashes[0],
                        expect: None,
                    }],
                ),
                batch(
                    2,
                    vec![Op::Delete {
                        path: "Set/Gone.md".into(),
                        expect: h("gone"),
                    }],
                ),
                batch(
                    3,
                    vec![Op::Move {
                        from: "Set/Old/Child.md".into(),
                        to: "Set/New/Child.md".into(),
                        expect: h("child"),
                    }],
                ),
            ],
            &blobs,
        );
        assert!(
            applied.results.values().all(|r| *r == Result_::Applied),
            "{:?}",
            applied.results
        );
        assert_eq!(d.read("Set/B.md").as_deref(), Some("a"));
        assert_eq!(d.read("Set/A.md"), None);
        assert_eq!(d.read("Set/New.md").as_deref(), Some("new"));
        assert_eq!(d.read("Set/Gone.md"), None);
        assert_eq!(d.read("Set/New/Child.md").as_deref(), Some("child"));
        assert!(
            !d.0.join("Set/Old").exists(),
            "the folder the move emptied is gone"
        );
        assert!(d.0.join("Set").exists(), "a context is never tidied away");
        assert!(leftovers(&d).is_empty());
        assert!(applied.touched["Set/B.md"].is_some());
        assert!(applied.touched["Set/A.md"].is_none());
    }

    #[test]
    fn a_file_that_changed_since_planning_is_left_exactly_as_it_is() {
        let d = TempDir::new("apply-cas");
        let j = TempDir::new("apply-journal");
        d.write("Set/A.md", "edited just now");
        let (blobs, hashes) = Mem::of(&["from the peer"]);

        let applied = apply(
            &d.0,
            &j.0,
            "r1",
            &[batch(
                7,
                vec![
                    Op::Write {
                        path: "Set/Copy.md".into(),
                        blob: hashes[0],
                        expect: None,
                    },
                    Op::Write {
                        path: "Set/A.md".into(),
                        blob: hashes[0],
                        expect: Some(h("what was planned from")),
                    },
                ],
            )],
            &blobs,
        );
        assert!(matches!(applied.results[&7], Result_::Refused(_)));
        assert_eq!(d.read("Set/A.md").as_deref(), Some("edited just now"));
        assert_eq!(
            d.read("Set/Copy.md"),
            None,
            "nothing of a refused group runs"
        );
    }

    #[test]
    fn two_pages_swapping_names_need_no_ordering() {
        let d = TempDir::new("apply-swap");
        let j = TempDir::new("apply-journal");
        d.write("Set/A.md", "was a");
        d.write("Set/B.md", "was b");

        let applied = apply(
            &d.0,
            &j.0,
            "r1",
            &[
                batch(
                    0,
                    vec![Op::Move {
                        from: "Set/A.md".into(),
                        to: "Set/B.md".into(),
                        expect: h("was a"),
                    }],
                ),
                batch(
                    1,
                    vec![Op::Move {
                        from: "Set/B.md".into(),
                        to: "Set/A.md".into(),
                        expect: h("was b"),
                    }],
                ),
            ],
            &no_blobs(),
        );
        assert!(applied.results.values().all(|r| *r == Result_::Applied));
        assert_eq!(d.read("Set/A.md").as_deref(), Some("was b"));
        assert_eq!(d.read("Set/B.md").as_deref(), Some("was a"));
    }

    #[test]
    fn a_name_can_only_be_changed_in_case_on_a_filesystem_that_ignores_case() {
        let d = TempDir::new("apply-case");
        let j = TempDir::new("apply-journal");
        d.write("Set/notes.md", "n");
        let applied = apply(
            &d.0,
            &j.0,
            "r1",
            &[batch(
                0,
                vec![Op::Move {
                    from: "Set/notes.md".into(),
                    to: "Set/Notes.md".into(),
                    expect: h("n"),
                }],
            )],
            &no_blobs(),
        );
        assert_eq!(applied.results[&0], Result_::Applied);
        let names: Vec<String> = std::fs::read_dir(d.0.join("Set"))
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["Notes.md"]);
    }

    #[test]
    fn a_page_renamed_in_case_takes_its_folder_along_whatever_the_filesystem() {
        let d = TempDir::new("apply-folder-case");
        let j = TempDir::new("apply-journal");
        d.write("Set/notes.md", "page");
        d.write("Set/notes/Child.md", "child");
        d.write("Set/notes/Other.md", "other");
        let names_in = |dir: &str| -> Vec<String> {
            let mut names: Vec<String> = std::fs::read_dir(d.0.join(dir))
                .unwrap()
                .flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect();
            names.sort();
            names
        };
        let applied = apply(
            &d.0,
            &j.0,
            "r1",
            &[
                batch(
                    0,
                    vec![Op::Move {
                        from: "Set/notes.md".into(),
                        to: "Set/Notes.md".into(),
                        expect: h("page"),
                    }],
                ),
                batch(
                    1,
                    vec![Op::Move {
                        from: "Set/notes/Child.md".into(),
                        to: "Set/Notes/Child.md".into(),
                        expect: h("child"),
                    }],
                ),
                batch(
                    2,
                    vec![Op::Move {
                        from: "Set/notes/Other.md".into(),
                        to: "Set/Notes/Other.md".into(),
                        expect: h("other"),
                    }],
                ),
            ],
            &no_blobs(),
        );
        assert!(
            applied.results.values().all(|r| *r == Result_::Applied),
            "{applied:?}"
        );
        assert_eq!(
            names_in("Set"),
            vec!["Notes", "Notes.md"],
            "no folder left under the old name"
        );
        assert_eq!(names_in("Set/Notes"), vec!["Child.md", "Other.md"]);
        assert_eq!(
            manifest::build(&d.0)
                .files
                .keys()
                .cloned()
                .collect::<Vec<_>>(),
            vec!["Set/Notes.md", "Set/Notes/Child.md", "Set/Notes/Other.md"],
            "the next scan sees what the plan meant"
        );
    }

    #[test]
    fn two_folders_that_differ_in_case_are_left_alone_where_case_matters() {
        let d = TempDir::new("apply-two-folders");
        let j = TempDir::new("apply-journal");
        d.write("Set/Notes/A.md", "a");
        if d.0.join("Set/notes").exists() {
            return;
        }
        d.write("Set/notes/B.md", "b");
        let (blobs, hashes) = Mem::of(&["c"]);
        let applied = apply(
            &d.0,
            &j.0,
            "r1",
            &[batch(
                0,
                vec![Op::Write {
                    path: "Set/notes/C.md".into(),
                    blob: hashes[0],
                    expect: None,
                }],
            )],
            &blobs,
        );
        assert_eq!(applied.results[&0], Result_::Applied);
        assert_eq!(d.read("Set/Notes/A.md").as_deref(), Some("a"));
        assert_eq!(d.read("Set/notes/B.md").as_deref(), Some("b"));
        assert_eq!(d.read("Set/notes/C.md").as_deref(), Some("c"));
    }

    #[test]
    fn a_write_that_fails_puts_back_what_its_group_had_moved_aside() {
        let d = TempDir::new("apply-undo");
        let j = TempDir::new("apply-journal");
        d.write("Set/Old.md", "old");
        d.write("Set/Taken.md", "someone else's");
        let (blobs, hashes) = Mem::of(&["new"]);

        let applied = apply(
            &d.0,
            &j.0,
            "r1",
            &[batch(
                0,
                vec![
                    Op::Delete {
                        path: "Set/Old.md".into(),
                        expect: h("old"),
                    },
                    // Planned free, but something took it: the group undoes.
                    Op::Write {
                        path: "Set/Taken.md".into(),
                        blob: hashes[0],
                        expect: None,
                    },
                ],
            )],
            &blobs,
        );
        assert!(matches!(applied.results[&0], Result_::Refused(_)));
        assert_eq!(
            d.read("Set/Old.md").as_deref(),
            Some("old"),
            "the delete was undone"
        );
        assert_eq!(d.read("Set/Taken.md").as_deref(), Some("someone else's"));
        assert!(leftovers(&d).is_empty());
    }

    #[test]
    fn a_crash_part_way_leaves_nothing_under_a_hidden_name_once_recovered() {
        let d = TempDir::new("apply-crash");
        let j = TempDir::new("apply-journal");
        d.write("Set/A.md", "moving");
        d.write("Set/B.md", "deleting");

        // What a run that died just after staging leaves behind.
        std::fs::rename(d.0.join("Set/A.md"), d.0.join("Set/.set-sync-r9-1")).unwrap();
        std::fs::rename(d.0.join("Set/B.md"), d.0.join("Set/.set-sync-r9-2")).unwrap();
        let journal = Journal {
            root: d.0.to_string_lossy().into_owned(),
            staged: vec![
                Staged {
                    tmp: "Set/.set-sync-r9-1".into(),
                    origin: "Set/A.md".into(),
                    target: Some("Set/Moved.md".into()),
                    trash: None,
                },
                Staged {
                    tmp: "Set/.set-sync-r9-2".into(),
                    origin: "Set/B.md".into(),
                    target: None,
                    trash: Some("Set/Set-Trash/B.md".into()),
                },
            ],
        };
        std::fs::write(j.0.join("r9.json"), serde_json::to_vec(&journal).unwrap()).unwrap();

        recover(&d.0, &j.0);
        assert_eq!(d.read("Set/Moved.md").as_deref(), Some("moving"));
        assert_eq!(
            d.read("Set/B.md").as_deref(),
            Some("deleting"),
            "an unfinished delete keeps the file"
        );
        assert!(leftovers(&d).is_empty());
        assert!(
            std::fs::read_dir(&j.0).unwrap().next().is_none(),
            "the journal is spent"
        );
    }

    #[test]
    fn a_context_is_removed_only_when_nothing_is_left_in_it() {
        let d = TempDir::new("apply-context");
        let j = TempDir::new("apply-journal");
        std::fs::create_dir_all(d.0.join("Empty")).unwrap();
        d.write("Empty/.DS_Store", "finder");
        d.write("Busy/A.md", "still here");
        apply(
            &d.0,
            &j.0,
            "r1",
            &[batch(
                0,
                vec![
                    Op::RemoveDir {
                        name: "Empty".into(),
                    },
                    Op::RemoveDir {
                        name: "Busy".into(),
                    },
                ],
            )],
            &no_blobs(),
        );
        assert!(!d.0.join("Empty").exists());
        assert_eq!(d.read("Busy/A.md").as_deref(), Some("still here"));
    }

    #[test]
    fn what_the_other_device_let_go_of_goes_to_the_trash_around_what_is_there() {
        let d = TempDir::new("apply-trash");
        let j = TempDir::new("apply-journal");
        d.write("Work/Plans/A.md", "page");
        d.write("Work/Plans/A/B.md", "child");
        d.write("Work/Plans/A/Set-page-assets/pic.png", "png");
        d.write("Work/Set-Trash/A.md", "an older A, trashed here last week");
        let trash = |path: &str, to: &str, text: &str| Op::Trash {
            path: path.into(),
            to: to.into(),
            expect: h(text),
        };

        let applied = apply(
            &d.0,
            &j.0,
            "r1",
            &[
                // The child first: whichever comes first names the page.
                batch(
                    1,
                    vec![trash("Work/Plans/A/B.md", "Work/Set-Trash/A/B.md", "child")],
                ),
                batch(
                    2,
                    vec![trash("Work/Plans/A.md", "Work/Set-Trash/A.md", "page")],
                ),
                batch(
                    3,
                    vec![trash(
                        "Work/Plans/A/Set-page-assets/pic.png",
                        "Work/Set-Trash/A/Set-page-assets/pic.png",
                        "png",
                    )],
                ),
            ],
            &no_blobs(),
        );
        assert!(applied.results.values().all(|r| *r == Result_::Applied));
        assert_eq!(
            d.read("Work/Set-Trash/A.md").as_deref(),
            Some("an older A, trashed here last week")
        );
        assert_eq!(d.read("Work/Set-Trash/A 2.md").as_deref(), Some("page"));
        assert_eq!(d.read("Work/Set-Trash/A 2/B.md").as_deref(), Some("child"));
        assert_eq!(
            d.read("Work/Set-Trash/A 2/Set-page-assets/pic.png")
                .as_deref(),
            Some("png")
        );
        assert!(!d.0.join("Work/Plans").exists(), "no husk where it was");
        assert_eq!(applied.touched["Work/Plans/A.md"], None);
        assert!(leftovers(&d).is_empty());
    }

    #[test]
    fn a_context_left_with_only_its_trash_goes_to_the_root_trash_whole() {
        let d = TempDir::new("apply-context-trash");
        let j = TempDir::new("apply-journal");
        d.write("Old/A.md", "page");
        let applied = apply(
            &d.0,
            &j.0,
            "r1",
            &[
                batch(
                    0,
                    vec![Op::Trash {
                        path: "Old/A.md".into(),
                        to: "Old/Set-Trash/A.md".into(),
                        expect: h("page"),
                    }],
                ),
                batch(1, vec![Op::RemoveDir { name: "Old".into() }]),
            ],
            &no_blobs(),
        );
        assert!(applied.results.values().all(|r| *r == Result_::Applied));
        assert!(!d.0.join("Old").exists());
        assert_eq!(
            d.read("Set-Trash/Old/Set-Trash/A.md").as_deref(),
            Some("page"),
            "where the app puts a deleted context, its own trash inside it"
        );
    }

    #[test]
    fn nothing_a_peer_sends_can_reach_outside_the_notes_folder() {
        let d = TempDir::new("apply-escape");
        let j = TempDir::new("apply-journal");
        let (blobs, hashes) = Mem::of(&["pwned"]);
        for rel in [
            "../outside.md",
            "Set/../../outside.md",
            "/etc/passwd",
            "./../x.md",
        ] {
            let applied = apply(
                &d.0,
                &j.0,
                "r1",
                &[batch(
                    0,
                    vec![Op::Write {
                        path: rel.into(),
                        blob: hashes[0],
                        expect: None,
                    }],
                )],
                &blobs,
            );
            assert!(matches!(applied.results[&0], Result_::Refused(_)), "{rel}");
        }
        assert!(!d.0.parent().unwrap().join("outside.md").exists());
    }
}
