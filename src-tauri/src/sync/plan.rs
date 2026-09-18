//! The coordinating device plans both sides from the two manifests and the last agreed version.
//! Nothing here touches disk or network.
//! Pages are matched by id, not path, so a retitle or move is one page moved. Each device has its
//! own trash, never listed; a page one side trashed goes to the other side's trash unless edited
//! since.
//! Files without an id (images, loose Markdown) are keyed relative to the page owning their folder,
//! so they follow it. Final paths are resolved owner-first, and names are allocated as a case- and
//! normalization-insensitive filesystem would compare them.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use serde::{Deserialize, Serialize};

use super::manifest::{self, Entry, Hash, Manifest, Scan};
use super::merge::replace_field;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub enum Side {
    Local,
    Remote,
}

impl Side {
    pub fn other(self) -> Side {
        match self {
            Side::Local => Side::Remote,
            Side::Remote => Side::Local,
        }
    }

    pub const BOTH: [Side; 2] = [Side::Local, Side::Remote];
}

/// `id:<page id>` for a page, otherwise its location.
pub type Key = String;

/// `rel` from the notes root when no page owns any folder above it.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Location {
    pub owner: Option<Key>,
    pub rel: String,
}

#[derive(Clone, Debug)]
pub struct Item {
    pub path: String,
    pub entry: Entry,
    pub loc: Location,
}

/// One file (or one page) as the base, this device and the peer each have it.
#[derive(Clone, Debug, Default)]
pub struct Group {
    pub key: Key,
    pub base: Option<Item>,
    pub local: Option<Item>,
    pub remote: Option<Item>,
}

impl Group {
    pub fn side(&self, side: Side) -> Option<&Item> {
        match side {
            Side::Local => self.local.as_ref(),
            Side::Remote => self.remote.as_ref(),
        }
    }

    fn side_mut(&mut self, side: Side) -> &mut Option<Item> {
        match side {
            Side::Local => &mut self.local,
            Side::Remote => &mut self.remote,
        }
    }

    fn any(&self) -> &Item {
        self.local
            .as_ref()
            .or(self.remote.as_ref())
            .or(self.base.as_ref())
            .expect("a group always has at least one item")
    }

    /// Whether this is a page (or loose Markdown): something that can be merged.
    pub fn is_note(&self) -> bool {
        manifest::is_note(&self.any().path)
    }
}

/// Each file in one state, with its key and location.
fn index(files: &BTreeMap<String, Entry>) -> BTreeMap<String, (Key, Location)> {
    // Two files with one id (only from a peer that skipped `ids::repair`): the first in app order
    // keeps it.
    let mut by_id: Vec<(&String, &String)> = files
        .iter()
        .filter(|(path, _)| manifest::is_note(path))
        .filter_map(|(path, entry)| entry.page_id.as_ref().map(|id| (path, id)))
        .collect();
    by_id.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
    let mut ids: HashSet<&str> = HashSet::new();
    let mut id_key: HashMap<&str, Key> = HashMap::new();
    for (path, id) in by_id {
        if ids.insert(id) {
            id_key.insert(path, format!("id:{id}"));
        }
    }

    // A folder differing from its page only in case is still its folder on a case-insensitive
    // filesystem. Exact match wins.
    let mut folded: HashMap<String, &str> = HashMap::new();
    for path in files.keys().filter(|p| manifest::is_note(p)) {
        folded.entry(manifest::fold(path)).or_insert(path);
    }

    let mut memo: HashMap<String, (Key, Location)> = HashMap::new();
    for path in files.keys() {
        resolve_key(path, files, &folded, &id_key, &mut memo);
    }
    memo.into_iter().collect()
}

fn resolve_key(
    path: &str,
    files: &BTreeMap<String, Entry>,
    folded: &HashMap<String, &str>,
    id_key: &HashMap<&str, Key>,
    memo: &mut HashMap<String, (Key, Location)>,
) -> (Key, Location) {
    if let Some(found) = memo.get(path) {
        return found.clone();
    }

    let mut loc = Location {
        owner: None,
        rel: path.to_string(),
    };
    let mut dir = parent_dir(path);
    while let Some(d) = dir {
        let exact = format!("{d}.md");
        let owner_note = if files.contains_key(&exact) && manifest::is_note(&exact) {
            Some(exact)
        } else {
            folded.get(&manifest::fold(&exact)).map(|p| p.to_string())
        };
        if let Some(owner_note) = owner_note {
            let (owner_key, _) = resolve_key(&owner_note, files, folded, id_key, memo);
            loc = Location {
                owner: Some(owner_key),
                rel: path[d.len() + 1..].to_string(),
            };
            break;
        }
        dir = parent_dir(d);
    }

    let key = match id_key.get(path) {
        Some(key) => key.clone(),
        None => match &loc.owner {
            Some(owner) => format!("at:{owner}\u{1f}{}", loc.rel),
            None => format!("at:\u{1f}{}", loc.rel),
        },
    };
    memo.insert(path.to_string(), (key.clone(), loc.clone()));
    (key, loc)
}

fn parent_dir(path: &str) -> Option<&str> {
    path.rsplit_once('/').map(|(dir, _)| dir)
}

/// Group every file of the three states by what it is.
pub fn groups(base: &Manifest, local: &Manifest, remote: &Manifest) -> Vec<Group> {
    let mut out: BTreeMap<Key, Group> = BTreeMap::new();
    let mut add = |files: &BTreeMap<String, Entry>, which: Option<Side>| {
        for (path, (key, loc)) in index(files) {
            let item = Item {
                path: path.clone(),
                entry: files[&path].clone(),
                loc,
            };
            let group = out.entry(key.clone()).or_insert_with(|| Group {
                key: key.clone(),
                ..Group::default()
            });
            match which {
                None => group.base = Some(item),
                Some(side) => *group.side_mut(side) = Some(item),
            }
        }
    };
    add(&base.files, None);
    add(&local.files, Some(Side::Local));
    add(&remote.files, Some(Side::Remote));

    adopt_new_ids(&mut out);
    out.into_values().collect()
}

/// Loose Markdown the app has since given an id is still the file the base knew by place, not a
/// delete plus a create.
fn adopt_new_ids(groups: &mut BTreeMap<Key, Group>) {
    let id_keys: Vec<Key> = groups
        .keys()
        .filter(|k| k.starts_with("id:"))
        .cloned()
        .collect();
    for key in id_keys {
        for side in Side::BOTH {
            let Some(path) = groups[&key].side(side).map(|i| i.path.clone()) else {
                continue;
            };
            if groups[&key].base.is_some() {
                break;
            }
            let found = groups
                .iter()
                .find(|(k, g)| {
                    !k.starts_with("id:")
                        && g.side(side).is_none()
                        && g.base
                            .as_ref()
                            .is_some_and(|b| b.path == path && b.entry.page_id.is_none())
                })
                .map(|(k, _)| k.clone());
            let Some(found) = found else {
                continue;
            };
            let old = groups.remove(&found).expect("just found");
            let group = groups.get_mut(&key).expect("still there");
            group.base = old.base.clone();
            for other in Side::BOTH {
                if group.side(other).is_none() {
                    *group.side_mut(other) = old.side(other).cloned();
                }
            }
        }
    }
}

/// What a group's content comes to.
#[derive(Clone, Debug, PartialEq)]
pub enum Content {
    /// Nowhere to be found.
    Gone,
    /// Both hold the same thing (maybe saved at different moments).
    Same,
    /// The version `side` holds is the one that stands.
    Take(Side),
    /// Both changed a note since they agreed; fold the two against the base.
    Merge { base: Hash },
    /// Both changed it and there is no folding them: keep both.
    Conflict,
    /// `side` still holds what the other side deleted, unchanged since.
    Delete(Side),
}

// A pair's baseline is not enough with three devices: versions arriving via a third look like
// edits, deletes look like creates, and the pairs undo each other for ever. So every copy carries a
// version vector for its content and one for its place. A version whose clock covers another is
// newer whatever the baseline says; only independent versions fall to the baseline.

/// For each device, how many versions it has made of one thing.
pub type Clock = BTreeMap<String, u64>;

/// Whether `a` has seen every version `b` has: `b` is `a`, or older.
pub fn covers(a: &Clock, b: &Clock) -> bool {
    b.iter()
        .all(|(device, n)| a.get(device).is_some_and(|m| m >= n))
}

/// Strictly newer: `a` has seen `b` and more.
pub fn newer_clock(a: &Clock, b: &Clock) -> bool {
    covers(a, b) && a != b
}

/// What has seen both `a` and `b`.
pub fn join(a: &Clock, b: &Clock) -> Clock {
    let mut out = a.clone();
    for (device, n) in b {
        let m = out.entry(device.clone()).or_insert(0);
        *m = (*m).max(*n);
    }
    out
}

/// `clock`, and one version more made by `device`.
pub fn bump(clock: &Clock, device: &str) -> Clock {
    let mut out = clock.clone();
    *out.entry(device.to_string()).or_insert(0) += 1;
    out
}

/// Where one copy's versions stand: what it says, and where it is.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Stamp {
    pub content: Clock,
    pub place: Clock,
}

/// What a copy says and where it is, as lineage sees them: (content, place).
pub type Version = (Hash, Hash);

/// A place, for lineage: the path, hashed.
pub fn place_of(path: &str) -> Hash {
    Hash::of(path.as_bytes())
}

/// For a side without the group, the stamp it deleted its copy at.
#[derive(Clone, Debug, Default)]
pub struct Lineages {
    /// As `state::Lineage::actor`: any version the round makes itself is one more of its own.
    pub here: String,
    /// The other device, likewise.
    pub there: String,
    pub local: HashMap<Key, Stamp>,
    pub remote: HashMap<Key, Stamp>,
}

impl Lineages {
    fn stamp(&self, side: Side, key: &str) -> Option<&Stamp> {
        match side {
            Side::Local => self.local.get(key),
            Side::Remote => self.remote.get(key),
        }
    }

    /// Both sides' stamps for `key`, if they can be compared at all.
    fn both(&self, side: Side, key: &str) -> Option<(&Stamp, &Stamp)> {
        if !self.consistent(key) {
            return None;
        }
        Some((self.stamp(side, key)?, self.stamp(side.other(), key)?))
    }

    /// A device that knows fewer of its own versions than the other has seen had its lineage put
    /// back and is reusing counts. Such a pair falls to the baseline.
    fn consistent(&self, key: &str) -> bool {
        let count = |side: Side, actor: &str, clock: fn(&Stamp) -> &Clock| {
            self.stamp(side, key)
                .and_then(|stamp| clock(stamp).get(actor).copied())
                .unwrap_or(0)
        };
        let clocks: [fn(&Stamp) -> &Clock; 2] = [|s| &s.content, |s| &s.place];
        clocks.into_iter().all(|clock| {
            count(Side::Remote, &self.here, clock) <= count(Side::Local, &self.here, clock)
                && count(Side::Local, &self.there, clock) <= count(Side::Remote, &self.there, clock)
        })
    }

    /// `side`'s copy says something newer than the other side's.
    fn newer_content(&self, side: Side, key: &str) -> bool {
        self.both(side, key)
            .is_some_and(|(a, b)| newer_clock(&a.content, &b.content))
    }

    /// `side`'s copy is somewhere newer than the other side's.
    fn newer_place(&self, side: Side, key: &str) -> bool {
        self.both(side, key)
            .is_some_and(|(a, b)| newer_clock(&a.place, &b.place))
    }

    /// `gone` deleted it having seen the other side's copy, content and place.
    fn let_go(&self, gone: Side, key: &str) -> bool {
        self.both(gone, key)
            .is_some_and(|(t, p)| covers(&t.content, &p.content) && covers(&t.place, &p.place))
    }

    /// Covers every version either side had; new where neither held exactly that.
    fn settle(&self, group: &Group, content: Hash, path: &str) -> Stamp {
        let (mut joined_content, mut joined_place) = (Clock::new(), Clock::new());
        for side in Side::BOTH {
            if let Some(stamp) = self.stamp(side, &group.key) {
                joined_content = join(&joined_content, &stamp.content);
                joined_place = join(&joined_place, &stamp.place);
            }
        }
        let held =
            |matches: &dyn Fn(&Item) -> bool, clock: &dyn Fn(&Stamp) -> &Clock, joined: &Clock| {
                Side::BOTH.iter().any(|side| {
                    group.side(*side).is_some_and(matches)
                        && self
                            .stamp(*side, &group.key)
                            .is_some_and(|s| clock(s) == joined)
                })
            };
        let content_held = held(
            &|i| i.entry.content == content,
            &|s| &s.content,
            &joined_content,
        );
        let place_held = held(&|i| i.path == path, &|s| &s.place, &joined_place);
        Stamp {
            content: if content_held {
                joined_content
            } else {
                bump(&joined_content, &self.here)
            },
            place: if place_held {
                joined_place
            } else {
                bump(&joined_place, &self.here)
            },
        }
    }

    /// The side that let go's stamp if it had seen the copy; otherwise newer than both.
    fn settle_deleted(&self, group: &Group, holder: Side) -> Stamp {
        let gone = self.stamp(holder.other(), &group.key);
        let kept = self.stamp(holder, &group.key);
        let empty = Stamp::default();
        let (t, p) = (gone.unwrap_or(&empty), kept.unwrap_or(&empty));
        let joined = Stamp {
            content: join(&t.content, &p.content),
            place: join(&t.place, &p.place),
        };
        if gone.is_some_and(|t| *t == joined) {
            joined
        } else {
            Stamp {
                content: bump(&joined.content, &self.here),
                place: bump(&joined.place, &self.here),
            }
        }
    }
}

/// What a round settled for one group, for both devices' lineage.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Settled {
    pub key: Key,
    pub version: Version,
    /// Deleted, `version` being what was deleted.
    pub gone: bool,
    pub stamp: Stamp,
}

/// Every group of a round, with what each side holds: the lineage a round asks
/// of both devices before it plans.
pub fn questions(
    base: &Manifest,
    local: &Manifest,
    remote: &Manifest,
) -> Vec<(Key, Option<Version>, Option<Version>)> {
    let version = |item: Option<&Item>| item.map(|i| (i.entry.content, place_of(&i.path)));
    groups(base, local, remote)
        .into_iter()
        .map(|g| {
            (
                g.key.clone(),
                version(g.local.as_ref()),
                version(g.remote.as_ref()),
            )
        })
        .collect()
}

pub fn classify(group: &Group, lineages: &Lineages) -> Content {
    let base = group.base.as_ref();
    match (group.local.as_ref(), group.remote.as_ref()) {
        (None, None) => Content::Gone,
        (Some(one), None) | (None, Some(one)) => {
            let side = if group.local.is_some() {
                Side::Local
            } else {
                Side::Remote
            };
            // The other side deleted it having seen this very copy.
            if lineages.let_go(side.other(), &group.key) {
                return Content::Delete(side);
            }
            match base {
                // An edit, or a move, outlives a delete on the other side.
                Some(b) if one.entry.content == b.entry.content && same_place(one, b) => {
                    Content::Delete(side)
                }
                _ => Content::Take(side),
            }
        }
        (Some(l), Some(r)) => {
            if l.entry.content == r.entry.content {
                return Content::Same;
            }
            for side in Side::BOTH {
                if lineages.newer_content(side, &group.key) {
                    return Content::Take(side);
                }
            }
            // Made independently of each other: the baseline decides.
            match base {
                Some(b) if l.entry.content == b.entry.content => Content::Take(Side::Remote),
                Some(b) if r.entry.content == b.entry.content => Content::Take(Side::Local),
                Some(b) if group.is_note() => Content::Merge {
                    base: b.entry.content,
                },
                // Never agreed, or not a note: guessing an ancestor reverts deletions silently.
                _ => Content::Conflict,
            }
        }
    }
}

/// Later `updatedAt`, then the larger content hash.
fn newer(a: &Item, b: &Item) -> bool {
    if a.entry.updated_at != b.entry.updated_at {
        return a.entry.updated_at > b.entry.updated_at;
    }
    if a.entry.content != b.entry.content {
        return a.entry.content > b.entry.content;
    }
    a.path < b.path
}

/// A file whose page was deleted on one side is located from the root there: same file, same
/// folder.
fn same_place(a: &Item, b: &Item) -> bool {
    a.loc == b.loc || a.path == b.path
}

/// Where a surviving group ends up, and which side's item that location came
/// from.
fn location(group: &Group, lineages: &Lineages) -> (Location, Side) {
    let (loc, side) = choose_location(group, lineages);
    if loc.owner.is_some() {
        return (loc, side);
    }
    // Located from the root because its page is missing there; if known under a page elsewhere,
    // that page is kept.
    let path = &group.side(side).expect("chosen from a side it has").path;
    let owned = [
        group.base.as_ref(),
        group.local.as_ref(),
        group.remote.as_ref(),
    ]
    .into_iter()
    .flatten()
    .find(|item| &item.path == path && item.loc.owner.is_some());
    match owned {
        Some(item) => (item.loc.clone(), side),
        None => (loc, side),
    }
}

fn choose_location(group: &Group, lineages: &Lineages) -> (Location, Side) {
    let (l, r) = match (group.local.as_ref(), group.remote.as_ref()) {
        (Some(l), Some(r)) => (l, r),
        (Some(l), None) => return (l.loc.clone(), Side::Local),
        (None, Some(r)) => return (r.loc.clone(), Side::Remote),
        (None, None) => unreachable!("a surviving group is somewhere"),
    };
    if same_place(l, r) {
        return if l.loc.owner.is_none() && r.loc.owner.is_some() {
            (r.loc.clone(), Side::Remote)
        } else {
            (l.loc.clone(), Side::Local)
        };
    }

    // A place the other side has already seen the page moved on from is older.
    for side in Side::BOTH {
        if lineages.newer_place(side, &group.key) {
            let item = group.side(side).expect("both present");
            return (item.loc.clone(), side);
        }
    }

    match group.base.as_ref() {
        Some(b) if same_place(b, l) => (r.loc.clone(), Side::Remote),
        Some(b) if same_place(b, r) => (l.loc.clone(), Side::Local),
        // Both moved it, or it was never agreed on: the newer version's place.
        _ if newer(l, r) => (l.loc.clone(), Side::Local),
        _ => (r.loc.clone(), Side::Remote),
    }
}

/// Every operation names the bytes it expects and does nothing otherwise.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Op {
    Move {
        from: String,
        to: String,
        expect: Hash,
    },
    /// Sync never destroys the last copy a device holds; only emptying that device's trash does.
    Trash {
        path: String,
        to: String,
        expect: Hash,
    },
    /// A file whose newer version this same group writes somewhere else.
    Delete {
        path: String,
        expect: Hash,
    },
    /// `expect` is `None` for a path that must be free.
    Write {
        path: String,
        blob: Hash,
        expect: Option<Hash>,
    },
    MakeDir {
        name: String,
    },
    RemoveDir {
        name: String,
    },
}

/// The operations for one group, which stand or fall together.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Batch {
    pub group: u32,
    pub ops: Vec<Op>,
}

/// Where the bytes a write needs come from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Blob {
    Local(String),
    Remote(String),
    Made(Vec<u8>),
}

/// A file that should be on both devices once the round is done.
#[derive(Clone, Debug, PartialEq)]
pub struct Final {
    pub path: String,
    pub content: Hash,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Kind {
    Unchanged,
    Moved,
    Copied(Side),
    Merged,
    Conflict { copy: String },
    Deleted,
}

#[derive(Clone, Debug)]
pub struct Outcome {
    pub group: u32,
    pub key: Key,
    pub kind: Kind,
    /// What both devices should hold once this group is applied.
    pub finals: Vec<Final>,
    /// Recorded again if the two do not get there this round.
    pub fallback: Vec<(String, Entry)>,
    /// The stamp its final version settles at, for both devices' lineage.
    pub stamp: Stamp,
    /// For a group deleted: the version deleted, which both devices' lineage
    /// keeps as let go.
    pub deleted: Option<Final>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Skip {
    /// A file changed between being listed and being read.
    Moving,
    /// Too big for one message.
    TooBig { size: u64 },
    /// No telling a delete from a file that is there and unseen.
    Unreadable,
}

#[derive(Clone, Debug)]
pub struct Skipped {
    pub key: Key,
    pub path: String,
    pub why: Skip,
    pub fallback: Vec<(String, Entry)>,
}

/// Trashing this many pages or fewer in one round never needs asking about.
pub const MASS_TRASH_FLOOR: usize = 10;

#[derive(Debug, Default)]
pub struct Plan {
    pub local: Vec<Batch>,
    pub remote: Vec<Batch>,
    pub blobs: BTreeMap<Hash, Blob>,
    pub outcomes: Vec<Outcome>,
    pub skipped: Vec<Skipped>,
    /// The contexts both should have afterwards.
    pub contexts: BTreeSet<String>,
}

/// How many pages a plan would send to each device's trash, when that is more
/// than anyone is likely to have meant.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MassTrash {
    pub local: usize,
    pub remote: usize,
}

impl Plan {
    /// Pages headed for `side`'s trash.
    fn trashing(&self, side: Side) -> usize {
        self.batches(side)
            .iter()
            .flat_map(|batch| &batch.ops)
            .filter(|op| matches!(op, Op::Trash { path, .. } if manifest::is_note(path)))
            .count()
    }

    /// More than `MASS_TRASH_FLOOR` and more than a quarter of that device's pages: cheaper to stop
    /// here than to restore one page at a time.
    pub fn mass_trash(&self, local: &Manifest, remote: &Manifest) -> Option<MassTrash> {
        let pages = |m: &Manifest| m.files.keys().filter(|p| manifest::is_note(p)).count();
        let is_mass =
            |trashing: usize, held: usize| trashing > MASS_TRASH_FLOOR && trashing * 4 > held;
        let (l, r) = (self.trashing(Side::Local), self.trashing(Side::Remote));
        (is_mass(l, pages(local)) || is_mass(r, pages(remote))).then_some(MassTrash {
            local: l,
            remote: r,
        })
    }

    pub fn batches(&self, side: Side) -> &[Batch] {
        match side {
            Side::Local => &self.local,
            Side::Remote => &self.remote,
        }
    }

    pub fn is_empty(&self) -> bool {
        self.local.is_empty() && self.remote.is_empty()
    }
}

/// What the caller has to fetch before a plan can be finished.
#[derive(Debug, Default, PartialEq)]
pub struct Wants {
    /// Peer files needed here, with the hash each was listed with.
    pub remote: BTreeMap<String, Hash>,
    /// Local files whose bytes the plan needs (notes being merged or copied).
    pub local: BTreeMap<String, Hash>,
    /// Content of the base versions of notes to merge.
    pub ancestors: BTreeSet<Hash>,
}

pub struct Draft {
    groups: Vec<Group>,
    contents: Vec<Content>,
    lineages: Lineages,
    /// Groups decided to sit the round out before any bytes are looked at.
    sat_out: HashMap<usize, Skip>,
    base_contexts: BTreeSet<String>,
    local_contexts: BTreeSet<String>,
    remote_contexts: BTreeSet<String>,
}

/// The first half of planning: match, classify, and say what to fetch.
pub fn draft(
    base: &Manifest,
    local: &Scan,
    remote: &Scan,
    max_file: u64,
    lineages: &Lineages,
) -> (Draft, Wants) {
    let seen = |side: Side| match side {
        Side::Local => local,
        Side::Remote => remote,
    };
    let (local, remote) = (&local.manifest, &remote.manifest);
    let groups = groups(base, local, remote);
    let contents: Vec<Content> = groups.iter().map(|g| classify(g, lineages)).collect();
    let mut wants = Wants::default();
    let mut sat_out = HashMap::new();

    // A file last held somewhere unreadable this round is not known to be gone.
    for (i, group) in groups.iter().enumerate() {
        let unseen = Side::BOTH.iter().any(|side| {
            group.side(*side).is_none()
                && group
                    .base
                    .as_ref()
                    .is_some_and(|b| seen(*side).hides(&b.path))
        });
        if unseen {
            sat_out.insert(i, Skip::Unreadable);
        }
    }

    // A page deleted on one side may be kept because a child was edited on the other; fetch its
    // bytes now, a round cannot go back.
    let owners: HashSet<&str> = groups
        .iter()
        .zip(&contents)
        .filter(|(_, c)| !matches!(c, Content::Gone | Content::Delete(_)))
        .flat_map(|(g, _)| [g.base.as_ref(), g.local.as_ref(), g.remote.as_ref()])
        .flatten()
        .filter_map(|item| item.loc.owner.as_deref())
        .collect();
    for (group, content) in groups.iter().zip(&contents) {
        if let (Content::Delete(Side::Remote), true) =
            (content, owners.contains(group.key.as_str()))
        {
            let item = group.remote.as_ref().expect("the side deleting has it");
            if item.entry.size <= max_file {
                wants.remote.insert(item.path.clone(), item.entry.hash);
            }
        }
    }

    for (i, (group, content)) in groups.iter().zip(&contents).enumerate() {
        if sat_out.contains_key(&i) {
            continue;
        }
        let needs: Vec<Side> = match content {
            Content::Take(side) => vec![*side],
            Content::Merge { .. } | Content::Conflict => vec![Side::Local, Side::Remote],
            _ => vec![],
        };
        // Only what crosses is limited: a merge is read on both sides, but the merge is what
        // crosses.
        let crossing = match content {
            Content::Take(side) => group.side(*side).map_or(0, |i| i.entry.size),
            Content::Merge { .. } | Content::Conflict => Side::BOTH
                .iter()
                .filter_map(|s| group.side(*s))
                .map(|i| i.entry.size)
                .max()
                .unwrap_or(0),
            _ => 0,
        };
        if crossing > max_file {
            sat_out.insert(i, Skip::TooBig { size: crossing });
            continue;
        }
        for side in needs {
            let Some(item) = group.side(side) else {
                continue;
            };
            let is_bytes_needed = !matches!(content, Content::Take(_)) || side == Side::Remote;
            match side {
                Side::Remote => {
                    wants.remote.insert(item.path.clone(), item.entry.hash);
                }
                Side::Local if is_bytes_needed => {
                    wants.local.insert(item.path.clone(), item.entry.hash);
                }
                Side::Local => {}
            }
        }
        if let Content::Merge { base } = content {
            wants.ancestors.insert(*base);
        }
    }

    (
        Draft {
            groups,
            contents,
            lineages: lineages.clone(),
            sat_out,
            base_contexts: base.contexts.clone(),
            local_contexts: local.contexts.clone(),
            remote_contexts: remote.contexts.clone(),
        },
        wants,
    )
}

/// Bytes, as the caller fetched them.
pub trait Provider {
    /// The bytes of `path` on `side`, if it still holds the version listed.
    fn bytes(&self, side: Side, path: &str, hash: &Hash) -> Option<Vec<u8>>;

    /// Without the bytes (an image that only has to travel).
    fn present(&self, side: Side, path: &str, hash: &Hash) -> bool;

    /// A base version of a note, by content.
    fn ancestor(&self, content: &Hash) -> Option<Vec<u8>>;
}

pub struct Names {
    pub local: String,
    pub remote: String,
}

impl Names {
    fn of(&self, side: Side) -> &str {
        match side {
            Side::Local => &self.local,
            Side::Remote => &self.remote,
        }
    }
}

/// What a surviving group resolves to once bytes are in.
enum Resolved {
    /// The final version is one a side already holds.
    Held(Side),
    /// A merge, or a pull of bytes both can't hold yet.
    Made(Vec<u8>),
    /// Two versions: `winner` at the page's place, the other as a copy.
    Split { winner: Side, copy: Vec<u8> },
}

struct Node {
    group: usize,
    loc: Location,
    source_path: String,
    /// Paths it holds now, to prefer keeping a name someone already has.
    current: Vec<String>,
    copy_of: Option<usize>,
}

/// The second half: merge, place, name, and turn it all into operations.
pub fn finish(draft: Draft, provider: &dyn Provider, names: &Names) -> Plan {
    let Draft {
        groups,
        mut contents,
        lineages,
        sat_out,
        base_contexts,
        local_contexts,
        remote_contexts,
    } = draft;
    let mut plan = Plan::default();

    // What needs bytes and could not get them sits this round out.
    let mut resolved: Vec<Option<Resolved>> = Vec::with_capacity(groups.len());
    let mut skipped_groups: HashSet<usize> = HashSet::new();
    let mut merged: HashSet<usize> = HashSet::new();

    for (i, group) in groups.iter().enumerate() {
        if let Some(why) = sat_out.get(&i) {
            skipped_groups.insert(i);
            plan.skipped.push(skipped(group, why.clone()));
            resolved.push(None);
            continue;
        }
        let outcome = match &contents[i] {
            Content::Gone | Content::Delete(_) => Some(None),
            Content::Same => Some(Some(Resolved::Held(Side::Local))),
            Content::Take(side) => {
                let item = group.side(*side).expect("the side it is taken from has it");
                provider
                    .present(*side, &item.path, &item.entry.hash)
                    .then_some(Some(Resolved::Held(*side)))
            }
            Content::Merge { base } => {
                let l = group.local.as_ref().expect("merging needs both");
                let r = group.remote.as_ref().expect("merging needs both");
                match (
                    provider.bytes(Side::Local, &l.path, &l.entry.hash),
                    provider.bytes(Side::Remote, &r.path, &r.entry.hash),
                ) {
                    (Some(lb), Some(rb)) => {
                        let folded = provider
                            .ancestor(base)
                            .and_then(|ancestor| super::merge::markdown(&ancestor, &lb, &rb));
                        match folded {
                            Some(bytes) => {
                                merged.insert(i);
                                Some(Some(held_or_made(bytes, &lb, &rb)))
                            }
                            None => {
                                contents[i] = Content::Conflict;
                                Some(Some(split(group, &lb, &rb, names)))
                            }
                        }
                    }
                    _ => None,
                }
            }
            Content::Conflict => {
                let l = group.local.as_ref().expect("a conflict needs both");
                let r = group.remote.as_ref().expect("a conflict needs both");
                match (
                    provider.bytes(Side::Local, &l.path, &l.entry.hash),
                    provider.bytes(Side::Remote, &r.path, &r.entry.hash),
                ) {
                    (Some(lb), Some(rb)) => Some(Some(split(group, &lb, &rb, names))),
                    _ => None,
                }
            }
        };
        match outcome {
            Some(r) => resolved.push(r),
            None => {
                skipped_groups.insert(i);
                plan.skipped.push(skipped(group, Skip::Moving));
                resolved.push(None);
            }
        }
    }

    // A child edited on one device while the other emptied its trash must not end up in a folder
    // with no page.
    let mut surviving: HashSet<Key> = HashSet::new();
    let mut by_key: HashMap<&str, usize> = HashMap::new();
    for (i, group) in groups.iter().enumerate() {
        by_key.insert(&group.key, i);
        if resolved[i].is_some() || skipped_groups.contains(&i) {
            surviving.insert(group.key.clone());
        }
    }
    loop {
        let mut revived = Vec::new();
        for (i, group) in groups.iter().enumerate() {
            if !surviving.contains(&group.key) || skipped_groups.contains(&i) {
                continue;
            }
            let (loc, _) = if resolved[i].is_some() {
                location(group, &lineages)
            } else {
                continue;
            };
            if let Some(owner) = &loc.owner {
                if let Some(&o) = by_key.get(owner.as_str()) {
                    if !surviving.contains(owner) {
                        if let Content::Delete(side) = contents[o] {
                            revived.push((o, side));
                        }
                    }
                }
            }
        }
        if revived.is_empty() {
            break;
        }
        for (o, side) in revived {
            let item = groups[o].side(side).expect("the side deleting has it");
            if provider.present(side, &item.path, &item.entry.hash) {
                contents[o] = Content::Take(side);
                resolved[o] = Some(Resolved::Held(side));
            } else {
                // Changed since it was listed (or too big to carry): it sits
                // this round out where it is, which keeps it just as well.
                skipped_groups.insert(o);
                plan.skipped.push(skipped(&groups[o], Skip::Moving));
            }
            surviving.insert(groups[o].key.clone());
        }
    }

    // Place everything. Copies made by a conflict sit beside their page.
    let mut nodes: Vec<Node> = Vec::new();
    for (i, group) in groups.iter().enumerate() {
        let Some(res) = &resolved[i] else {
            continue;
        };
        let (loc, from) = location(group, &lineages);
        let source_path = group
            .side(from)
            .expect("located from a side it has")
            .path
            .clone();
        let current: Vec<String> = Side::BOTH
            .iter()
            .filter_map(|s| group.side(*s).map(|item| item.path.clone()))
            .collect();
        let main = nodes.len();
        nodes.push(Node {
            group: i,
            loc: loc.clone(),
            source_path: source_path.clone(),
            current,
            copy_of: None,
        });
        if let Resolved::Split { winner, copy } = res {
            let loser = winner.other();
            let tag = conflict_tag(names.of(loser));
            // A copy already there from a round cut short syncs by itself.
            if copy_exists(&groups, group, copy, &tag) {
                continue;
            }
            nodes.push(Node {
                group: i,
                loc: Location {
                    owner: loc.owner.clone(),
                    rel: tagged(&loc.rel, &tag),
                },
                source_path: tagged(&source_path, &tag),
                current: Vec::new(),
                copy_of: Some(main),
            });
        }
    }

    // What sits this round out keeps its place on both devices, so nothing
    // else may be given it.
    let mut pinned: HashSet<String> = HashSet::new();
    for i in &skipped_groups {
        let group = &groups[*i];
        // The base's too: a file a side couldn't read is still where it was.
        for item in [&group.base, &group.local, &group.remote]
            .into_iter()
            .flatten()
        {
            pinned.insert(manifest::fold(&item.path));
        }
    }
    let paths = place(&nodes, &groups, &pinned);

    // Turn it into operations.
    let mut main_path: HashMap<usize, String> = HashMap::new();
    let mut copy_path: HashMap<usize, String> = HashMap::new();
    for (n, node) in nodes.iter().enumerate() {
        match node.copy_of {
            None => {
                main_path.insert(node.group, paths[n].clone());
            }
            Some(_) => {
                copy_path.insert(node.group, paths[n].clone());
            }
        }
    }

    let going: HashMap<usize, Side> = contents
        .iter()
        .enumerate()
        .filter(|(i, _)| resolved[*i].is_none() && !skipped_groups.contains(i))
        .filter_map(|(i, content)| match content {
            Content::Delete(side) => Some((i, *side)),
            _ => None,
        })
        .collect();
    let trash = trash_paths(&groups, &going, &by_key);

    for (i, group) in groups.iter().enumerate() {
        let gid = i as u32;
        let fallback = fallback(group);
        if skipped_groups.contains(&i) {
            continue;
        }
        let Some(res) = &resolved[i] else {
            // Gone, or deleted on the side that still has it.
            if let Content::Delete(side) = &contents[i] {
                let item = group.side(*side).expect("the side deleting has it");
                push(
                    &mut plan,
                    *side,
                    gid,
                    Op::Trash {
                        path: item.path.clone(),
                        to: trash[&i].clone(),
                        expect: item.entry.hash,
                    },
                );
                plan.outcomes.push(Outcome {
                    group: gid,
                    key: group.key.clone(),
                    kind: Kind::Deleted,
                    finals: Vec::new(),
                    fallback,
                    stamp: lineages.settle_deleted(group, *side),
                    deleted: Some(Final {
                        path: item.path.clone(),
                        content: item.entry.content,
                    }),
                });
            }
            continue;
        };
        let target = main_path[&i].clone();
        let mut finals = Vec::new();

        // The final version of the page, and where each side gets it from.
        let (final_hash, final_content, source) = match res {
            Resolved::Held(side) => {
                let item = group.side(*side).expect("held by that side");
                (item.entry.hash, item.entry.content, Some(*side))
            }
            Resolved::Made(bytes) => {
                let hash = Hash::of(bytes);
                plan.blobs.insert(hash, Blob::Made(bytes.clone()));
                (hash, manifest::content_of(bytes), None)
            }
            Resolved::Split { winner, .. } => {
                let item = group.side(*winner).expect("the winner has it");
                (item.entry.hash, item.entry.content, Some(*winner))
            }
        };
        finals.push(Final {
            path: target.clone(),
            content: final_content,
        });

        // The copy is written first, so the older version is safe before the page changes.
        let copy = match (res, copy_path.get(&i)) {
            (Resolved::Split { copy, .. }, Some(path)) => {
                let hash = Hash::of(copy);
                plan.blobs.insert(hash, Blob::Made(copy.clone()));
                finals.push(Final {
                    path: path.clone(),
                    content: manifest::content_of(copy),
                });
                Some((path.clone(), hash))
            }
            _ => None,
        };

        let content_same = matches!(contents[i], Content::Same);
        for side in Side::BOTH {
            let item = group.side(side);
            let mut ops = Vec::new();
            if let Some((path, hash)) = &copy {
                ops.push(Op::Write {
                    path: path.clone(),
                    blob: *hash,
                    expect: None,
                });
            }
            // This side already holds the final version when it is the source,
            // when both held the same thing, or when a merge came out as
            // exactly what it has.
            let holds = content_same
                || source == Some(side)
                || item.is_some_and(|it| it.entry.hash == final_hash);
            match (item, holds) {
                (Some(it), true) => {
                    if it.path != target {
                        ops.push(Op::Move {
                            from: it.path.clone(),
                            to: target.clone(),
                            expect: it.entry.hash,
                        });
                    }
                }
                (Some(it), false) => {
                    let blob = blob_for(&mut plan, side, source, group, final_hash);
                    if it.path == target {
                        ops.push(Op::Write {
                            path: target.clone(),
                            blob,
                            expect: Some(it.entry.hash),
                        });
                    } else {
                        ops.push(Op::Delete {
                            path: it.path.clone(),
                            expect: it.entry.hash,
                        });
                        ops.push(Op::Write {
                            path: target.clone(),
                            blob,
                            expect: None,
                        });
                    }
                }
                (None, _) => {
                    let blob = blob_for(&mut plan, side, source, group, final_hash);
                    ops.push(Op::Write {
                        path: target.clone(),
                        blob,
                        expect: None,
                    });
                }
            }
            for op in ops {
                push(&mut plan, side, gid, op);
            }
        }

        let kind = if let Some((path, _)) = &copy {
            Kind::Conflict { copy: path.clone() }
        } else if merged.contains(&i) {
            Kind::Merged
        } else if let Content::Take(side) = contents[i] {
            Kind::Copied(side)
        } else if Side::BOTH
            .iter()
            .any(|s| group.side(*s).is_some_and(|it| it.path != target))
        {
            Kind::Moved
        } else {
            Kind::Unchanged
        };
        let stamp = lineages.settle(group, final_content, &target);
        plan.outcomes.push(Outcome {
            group: gid,
            key: group.key.clone(),
            kind,
            finals,
            fallback,
            stamp,
            deleted: None,
        });
    }

    plan_contexts(
        &mut plan,
        &base_contexts,
        &local_contexts,
        &remote_contexts,
        groups.len() as u32,
    );
    plan
}

/// Laid out as the app's trash: the topmost page at the top of `Set-Trash/`, its subtree under it.
/// What is already in the trash is for `apply` to step around.
fn trash_paths(
    groups: &[Group],
    going: &HashMap<usize, Side>,
    by_key: &HashMap<&str, usize>,
) -> HashMap<usize, String> {
    let item = |g: usize| groups[g].side(going[&g]).expect("the side deleting has it");
    let going_owner = |g: usize| {
        let owner = *by_key.get(item(g).loc.owner.as_deref()?)?;
        (going.get(&owner) == going.get(&g)).then_some(owner)
    };

    let mut order: Vec<usize> = going.keys().copied().collect();
    order.sort_unstable();

    // The pages at the top of what is going, named first.
    let mut taken: HashSet<(Side, String)> = HashSet::new();
    let mut top_name: HashMap<usize, String> = HashMap::new();
    for &g in order.iter().filter(|g| going_owner(**g).is_none()) {
        let path = &item(g).path;
        let bin = crate::paths::trash_of(crate::paths::context_of(path));
        let name = path
            .rsplit_once('/')
            .map_or(path.as_str(), |(_, name)| name);
        let folded = |path: &str| (going[&g], manifest::fold(path));
        let free = numbered(&format!("{bin}/{name}"))
            .find(|candidate| {
                !taken.contains(&folded(candidate))
                    && !taken.contains(&folded(crate::paths::strip_md(candidate)))
            })
            .expect("some number is always free");
        taken.insert(folded(&free));
        taken.insert(folded(crate::paths::strip_md(&free)));
        top_name.insert(g, free);
    }

    // Everything else, under the page that owns it.
    fn resolve(
        g: usize,
        top_name: &HashMap<usize, String>,
        going_owner: &dyn Fn(usize) -> Option<usize>,
        rel: &dyn Fn(usize) -> String,
    ) -> String {
        match going_owner(g) {
            None => top_name[&g].clone(),
            Some(owner) => {
                let owner = resolve(owner, top_name, going_owner, rel);
                format!("{}/{}", crate::paths::strip_md(&owner), rel(g))
            }
        }
    }
    order
        .iter()
        .map(|&g| {
            let rel = |g: usize| item(g).loc.rel.clone();
            (g, resolve(g, &top_name, &going_owner, &rel))
        })
        .collect()
}

fn skipped(group: &Group, why: Skip) -> Skipped {
    Skipped {
        key: group.key.clone(),
        path: group.any().path.clone(),
        why,
        fallback: fallback(group),
    }
}

fn fallback(group: &Group) -> Vec<(String, Entry)> {
    group
        .base
        .iter()
        .map(|b| (b.path.clone(), b.entry.clone()))
        .collect()
}

fn push(plan: &mut Plan, side: Side, group: u32, op: Op) {
    let batches = match side {
        Side::Local => &mut plan.local,
        Side::Remote => &mut plan.remote,
    };
    match batches.last_mut() {
        Some(batch) if batch.group == group => batch.ops.push(op),
        _ => batches.push(Batch {
            group,
            ops: vec![op],
        }),
    }
}

/// Where the bytes for `side`'s write come from: the other side's file, or bytes
/// already recorded as made.
fn blob_for(plan: &mut Plan, side: Side, source: Option<Side>, group: &Group, hash: Hash) -> Hash {
    if let Some(from) = source {
        debug_assert_ne!(from, side, "a side never fetches its own file");
        let item = group.side(from).expect("the source has it");
        plan.blobs.entry(hash).or_insert_with(|| match from {
            Side::Local => Blob::Local(item.path.clone()),
            Side::Remote => Blob::Remote(item.path.clone()),
        });
    }
    hash
}

/// A merge that came out as exactly one side's bytes is that side's version.
fn held_or_made(merged: Vec<u8>, local: &[u8], remote: &[u8]) -> Resolved {
    if merged == local {
        Resolved::Held(Side::Local)
    } else if merged == remote {
        Resolved::Held(Side::Remote)
    } else {
        Resolved::Made(merged)
    }
}

/// Keep both: the newer version at the page's place, the older one as a page of
/// its own named for the device it came from.
fn split(group: &Group, local: &[u8], remote: &[u8], names: &Names) -> Resolved {
    let l = group.local.as_ref().expect("both");
    let r = group.remote.as_ref().expect("both");
    let winner = if newer(l, r) {
        Side::Local
    } else {
        Side::Remote
    };
    let loser = winner.other();
    let (loser_item, loser_bytes) = match loser {
        Side::Local => (l, local),
        Side::Remote => (r, remote),
    };
    let copy = if group.is_note() {
        as_copy(loser_bytes, loser_item, names.of(loser))
    } else {
        loser_bytes.to_vec()
    };
    Resolved::Split { winner, copy }
}

/// A new id, so the two never share one.
fn as_copy(bytes: &[u8], item: &Item, device: &str) -> Vec<u8> {
    let Ok(text) = std::str::from_utf8(bytes) else {
        return bytes.to_vec();
    };
    let mut out = text.to_string();
    if let Some(id) = &item.entry.page_id {
        let fresh =
            crate::page_id::derive(&format!("{id}/conflict/{}", item.entry.content.to_hex()));
        if let Some(replaced) = replace_field(&out, "id", &fresh) {
            out = replaced;
        }
    }
    if let Some(title) = frontmatter_title(&out) {
        let retitled = format!("{title} ({})", conflict_tag(device));
        if let Some(replaced) = replace_field(&out, "title", &retitled) {
            out = replaced;
        }
    }
    out.into_bytes()
}

/// A page's copy is known by its derived id; anything else by the same bytes under the copy's name.
fn copy_exists(groups: &[Group], group: &Group, copy: &[u8], tag: &str) -> bool {
    let id = std::str::from_utf8(copy)
        .ok()
        .filter(|_| group.is_note())
        .and_then(|text| crate::scan::page_identity(text).0);
    if let Some(id) = id {
        let key = format!("id:{id}");
        return groups.iter().any(|g| g.key == key);
    }
    let content = Hash::of(copy);
    let names: Vec<String> = Side::BOTH
        .iter()
        .filter_map(|side| group.side(*side))
        .map(|item| manifest::fold(&tagged(&item.path, tag)))
        .collect();
    groups
        .iter()
        .flat_map(|g| [g.local.as_ref(), g.remote.as_ref()])
        .flatten()
        .any(|item| item.entry.content == content && names.contains(&manifest::fold(&item.path)))
}

pub(super) fn frontmatter_title(text: &str) -> Option<String> {
    let (front, _) = super::merge::split(text);
    let raw = front.iter().find(|(k, _)| k == "title")?.1.clone();
    Some(serde_json::from_str::<String>(&raw).unwrap_or(raw))
}

/// "conflict from <device>", made safe to put in a file name.
fn conflict_tag(device: &str) -> String {
    let cleaned: String = device
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '-',
            c if c.is_control() => '-',
            c => c,
        })
        .collect();
    let cleaned = cleaned.trim().trim_end_matches('.');
    format!(
        "conflict from {}",
        if cleaned.is_empty() {
            "another device"
        } else {
            cleaned
        }
    )
}

/// `path` with `suffix` put between its name and its extension.
fn suffixed(path: &str, suffix: &str) -> String {
    let name_at = path.rfind('/').map_or(0, |slash| slash + 1);
    let ext_at = match path[name_at..].rfind('.') {
        Some(dot) if dot > 0 => name_at + dot,
        _ => path.len(),
    };
    format!("{}{suffix}{}", &path[..ext_at], &path[ext_at..])
}

/// `path` with ` (tag)` put before its extension.
fn tagged(path: &str, tag: &str) -> String {
    suffixed(path, &format!(" ({tag})"))
}

/// The names tried for `path`, in order: itself, then `stem 2.ext`,
/// `stem 3.ext`, …
pub(super) fn numbered(path: &str) -> impl Iterator<Item = String> + '_ {
    (1usize..).map(move |n| match n {
        1 => path.to_string(),
        n => suffixed(path, &format!(" {n}")),
    })
}

/// The first of `desired`'s numbered names that no placed file and no pinned
/// file folds to.
fn allocate(desired: &str, taken: &HashSet<String>, dirs: &HashSet<String>) -> String {
    numbered(desired)
        .find(|candidate| {
            let folded = manifest::fold(candidate);
            !taken.contains(&folded) && !dirs.contains(&folded)
        })
        .expect("some number is always free")
}

/// Give every node its final path, owners before what they own.
fn place(nodes: &[Node], groups: &[Group], pinned: &HashSet<String>) -> Vec<String> {
    let mut taken: HashSet<String> = pinned.clone();
    let mut dirs: HashSet<String> = HashSet::new();
    let mut out: Vec<Option<String>> = vec![None; nodes.len()];
    let mut placed_key: HashMap<&str, String> = HashMap::new();
    let node_of_key: HashMap<&str, usize> = nodes
        .iter()
        .enumerate()
        .filter(|(_, n)| n.copy_of.is_none())
        .map(|(n, node)| (groups[node.group].key.as_str(), n))
        .collect();

    let mut pending: Vec<usize> = (0..nodes.len()).collect();
    while !pending.is_empty() {
        let mut ready: Vec<(usize, String)> = Vec::new();
        for &n in &pending {
            let node = &nodes[n];
            // The page keeps the name; the copy moves along on a collision.
            if let Some(main) = node.copy_of {
                if out[main].is_none() {
                    continue;
                }
            }
            let desired = match &node.loc.owner {
                None => Some(node.loc.rel.clone()),
                Some(owner) => match placed_key.get(owner.as_str()) {
                    Some(owner_path) => Some(format!(
                        "{}/{}",
                        crate::paths::strip_md(owner_path),
                        node.loc.rel
                    )),
                    // The owner isn't being placed at all: keep the folder
                    // this file was found in.
                    None if !node_of_key.contains_key(owner.as_str()) => {
                        Some(node.source_path.clone())
                    }
                    None => None,
                },
            };
            if let Some(desired) = desired {
                ready.push((n, desired));
            }
        }
        if ready.is_empty() {
            // Owners that own each other (A under B on one device, B under A on the other): leave
            // one where it was found.
            let n = *pending
                .iter()
                .min_by_key(|n| &groups[nodes[**n].group].key)
                .expect("pending isn't empty");
            ready.push((n, nodes[n].source_path.clone()));
        }

        // Within a round of placing, whoever already has the name keeps it.
        ready.sort_by(|a, b| {
            let rank = |(n, desired): &(usize, String)| {
                let holders = nodes[*n].current.iter().filter(|p| *p == desired).count();
                (
                    std::cmp::Reverse(holders),
                    groups[nodes[*n].group].key.clone(),
                )
            };
            rank(a).cmp(&rank(b))
        });
        for (n, desired) in ready {
            let path = allocate(&desired, &taken, &dirs);
            taken.insert(manifest::fold(&path));
            let mut dir = parent_dir(&path);
            while let Some(d) = dir {
                dirs.insert(manifest::fold(d));
                dir = parent_dir(d);
            }
            if nodes[n].copy_of.is_none() {
                placed_key.insert(&groups[nodes[n].group].key, path.clone());
            }
            out[n] = Some(path);
            pending.retain(|p| *p != n);
        }
    }
    out.into_iter()
        .map(|p| p.expect("everything placed"))
        .collect()
}

/// Run after every file operation of the round.
fn plan_contexts(
    plan: &mut Plan,
    base: &BTreeSet<String>,
    local: &BTreeSet<String>,
    remote: &BTreeSet<String>,
    group: u32,
) {
    let mut in_use: HashSet<String> = HashSet::new();
    for outcome in &plan.outcomes {
        for f in &outcome.finals {
            if let Some((top, _)) = f.path.split_once('/') {
                in_use.insert(manifest::fold(top));
            }
        }
    }
    for skipped in &plan.skipped {
        if let Some((top, _)) = skipped.path.split_once('/') {
            in_use.insert(manifest::fold(top));
        }
    }

    let all: BTreeSet<&String> = base.iter().chain(local).chain(remote).collect();
    for name in all {
        let (l, r, b) = (
            local.contains(name),
            remote.contains(name),
            base.contains(name),
        );
        let used = in_use.contains(&manifest::fold(name));
        match (l, r) {
            (true, true) => {
                plan.contexts.insert(name.clone());
            }
            (true, false) | (false, true) => {
                let has = if l { Side::Local } else { Side::Remote };
                if b && !used {
                    push(plan, has, group, Op::RemoveDir { name: name.clone() });
                } else {
                    plan.contexts.insert(name.clone());
                    push(plan, has.other(), group, Op::MakeDir { name: name.clone() });
                }
            }
            (false, false) => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note(id: &str, title: &str, updated: u64, body: &str) -> String {
        format!(
            "---\nid: \"{id}\"\ntitle: \"{title}\"\nparentId: null\ncreatedAt: 1\nupdatedAt: {updated}\n---\n\n{body}\n"
        )
    }

    /// A folder, as literal files.
    #[derive(Clone, Default)]
    struct Folder(BTreeMap<String, Vec<u8>>);

    impl Folder {
        fn with(mut self, path: &str, text: &str) -> Self {
            self.0.insert(path.to_string(), text.as_bytes().to_vec());
            self
        }

        fn manifest(&self) -> Manifest {
            let mut m = Manifest::default();
            for (path, bytes) in &self.0 {
                m.files
                    .insert(path.clone(), manifest::describe_bytes(bytes, path, || 1.0));
                if let Some((top, _)) = path.split_once('/') {
                    m.contexts.insert(top.to_string());
                }
            }
            m
        }
    }

    struct Fake<'a> {
        local: &'a Folder,
        remote: &'a Folder,
        ancestors: Vec<Vec<u8>>,
    }

    impl Provider for Fake<'_> {
        fn bytes(&self, side: Side, path: &str, hash: &Hash) -> Option<Vec<u8>> {
            let folder = match side {
                Side::Local => self.local,
                Side::Remote => self.remote,
            };
            folder.0.get(path).filter(|b| Hash::of(b) == *hash).cloned()
        }
        fn present(&self, side: Side, path: &str, hash: &Hash) -> bool {
            self.bytes(side, path, hash).is_some()
        }
        fn ancestor(&self, content: &Hash) -> Option<Vec<u8>> {
            self.ancestors
                .iter()
                .find(|b| manifest::content_of(b) == *content)
                .cloned()
        }
    }

    /// A folder every file of which could be read.
    fn seen(manifest: Manifest) -> Scan {
        Scan {
            manifest,
            ..Scan::default()
        }
    }

    fn names() -> Names {
        Names {
            local: "Laptop".to_string(),
            remote: "Desktop".to_string(),
        }
    }

    /// Plan a round and carry it out on in-memory folders, answering what both
    /// hold afterwards.
    fn run(base: &Folder, local: &Folder, remote: &Folder) -> (Folder, Folder, Plan) {
        let (drafted, _wants) = draft(
            &base.manifest(),
            &seen(local.manifest()),
            &seen(remote.manifest()),
            u64::MAX,
            &Lineages::default(),
        );
        let fake = Fake {
            local,
            remote,
            ancestors: base.0.values().cloned().collect(),
        };
        let plan = finish(drafted, &fake, &names());
        let apply = |folder: &Folder, side: Side| {
            let mut out = folder.clone();
            for batch in plan.batches(side) {
                for op in &batch.ops {
                    match op {
                        Op::Move { from, to, expect } => {
                            let bytes = out.0.remove(from).expect("move source");
                            assert_eq!(Hash::of(&bytes), *expect);
                            assert!(!out.0.contains_key(to), "moved onto {to}");
                            out.0.insert(to.clone(), bytes);
                        }
                        // Into the trash is out of the folder, as sync sees it.
                        Op::Trash { path, expect, .. } | Op::Delete { path, expect } => {
                            let bytes = out.0.remove(path).expect("delete target");
                            assert_eq!(Hash::of(&bytes), *expect);
                        }
                        Op::Write { .. } | Op::MakeDir { .. } | Op::RemoveDir { .. } => {}
                    }
                }
            }
            // Writes after moves and deletes, as apply does.
            for batch in plan.batches(side) {
                for op in &batch.ops {
                    if let Op::Write { path, blob, expect } = op {
                        match expect {
                            None => assert!(!out.0.contains_key(path), "{path} not free"),
                            Some(h) => assert_eq!(Hash::of(&out.0[path]), *h),
                        }
                        let bytes = match &plan.blobs[blob] {
                            Blob::Local(p) => local.0[p].clone(),
                            Blob::Remote(p) => remote.0[p].clone(),
                            Blob::Made(b) => b.clone(),
                        };
                        out.0.insert(path.clone(), bytes);
                    }
                }
            }
            out
        };
        (apply(local, Side::Local), apply(remote, Side::Remote), plan)
    }

    fn same_content(a: &Folder, b: &Folder) -> bool {
        a.manifest()
            .files
            .iter()
            .map(|(p, e)| (p.clone(), e.content))
            .collect::<Vec<_>>()
            == b.manifest()
                .files
                .iter()
                .map(|(p, e)| (p.clone(), e.content))
                .collect::<Vec<_>>()
    }

    fn paths(f: &Folder) -> Vec<&str> {
        f.0.keys().map(String::as_str).collect()
    }

    #[test]
    fn a_new_page_on_one_side_is_written_on_the_other() {
        let local = Folder::default().with("Set/A.md", &note("a", "A", 1, "hi"));
        let (l, r, _) = run(&Folder::default(), &local, &Folder::default());
        assert!(same_content(&l, &r));
        assert_eq!(paths(&r), vec!["Set/A.md"]);
    }

    #[test]
    fn a_retitled_page_is_moved_not_duplicated_even_when_its_old_name_is_reused() {
        // Linux retitles "Untitled" and makes a new one; the Mac edits the original.
        let base = Folder::default().with("Set/Untitled.md", &note("x", "Untitled", 1, "draft"));
        let linux = Folder::default()
            .with("Set/Groceries.md", &note("x", "Groceries", 2, "draft"))
            .with("Set/Untitled.md", &note("y", "Untitled", 3, "a new page"));
        let mac = Folder::default().with(
            "Set/Untitled.md",
            &note("x", "Untitled", 4, "draft\nmore from the mac"),
        );

        let (m, l, plan) = run(&base, &mac, &linux);
        assert!(same_content(&m, &l), "{:?} vs {:?}", paths(&m), paths(&l));
        assert_eq!(paths(&m), vec!["Set/Groceries.md", "Set/Untitled.md"]);
        let groceries = String::from_utf8(m.0["Set/Groceries.md"].clone()).unwrap();
        assert!(groceries.contains("more from the mac"), "{groceries}");
        assert!(groceries.contains("\"Groceries\""), "{groceries}");
        let untitled = String::from_utf8(m.0["Set/Untitled.md"].clone()).unwrap();
        assert!(untitled.contains("a new page") && untitled.contains("\"y\""));
        assert!(
            !plan
                .outcomes
                .iter()
                .any(|o| matches!(o.kind, Kind::Conflict { .. })),
            "nothing here conflicted"
        );
    }

    #[test]
    fn two_new_pages_with_one_name_are_two_pages_not_a_conflict() {
        let mac = Folder::default().with("Set/Untitled.md", &note("a", "Untitled", 1, "mac idea"));
        let linux =
            Folder::default().with("Set/Untitled.md", &note("b", "Untitled", 2, "linux idea"));
        let (m, l, plan) = run(&Folder::default(), &mac, &linux);
        assert!(same_content(&m, &l));
        assert_eq!(paths(&m), vec!["Set/Untitled 2.md", "Set/Untitled.md"]);
        assert!(!plan
            .outcomes
            .iter()
            .any(|o| matches!(o.kind, Kind::Conflict { .. })));
        // Each page kept its own id.
        let ids: BTreeSet<Option<String>> = m
            .manifest()
            .files
            .values()
            .map(|e| e.page_id.clone())
            .collect();
        assert_eq!(ids.len(), 2);
    }

    #[test]
    fn a_subtree_moved_on_one_side_moves_whole_and_keeps_its_images() {
        let base = Folder::default()
            .with("Set/Projects.md", &note("p", "Projects", 1, "index"))
            .with("Set/Projects/Launch.md", &note("c", "Launch", 1, "child"))
            .with("Set/Projects/Set-page-assets/k.png", "PNG");
        let local = Folder::default()
            .with("Set/Work.md", &note("p", "Work", 2, "index"))
            .with("Set/Work/Launch.md", &note("c", "Launch", 1, "child"))
            .with("Set/Work/Set-page-assets/k.png", "PNG");
        let remote = base.clone().with(
            "Set/Projects/Launch.md",
            &note("c", "Launch", 3, "child\nedited remotely"),
        );

        let (l, r, plan) = run(&base, &local, &remote);
        assert!(same_content(&l, &r));
        assert_eq!(
            paths(&r),
            vec![
                "Set/Work.md",
                "Set/Work/Launch.md",
                "Set/Work/Set-page-assets/k.png"
            ]
        );
        assert!(String::from_utf8(r.0["Set/Work/Launch.md"].clone())
            .unwrap()
            .contains("edited remotely"));
        assert!(
            !plan.remote.iter().flat_map(|b| &b.ops).any(|op| matches!(
                op,
                Op::Write { path, .. } if path.ends_with("k.png")
            )),
            "the image moved with its page rather than travelling again"
        );
    }

    /// Where each file a side lets go of is sent, by where it was.
    fn trashed(plan: &Plan, side: Side) -> BTreeMap<String, String> {
        plan.batches(side)
            .iter()
            .flat_map(|batch| &batch.ops)
            .filter_map(|op| match op {
                Op::Trash { path, to, .. } => Some((path.clone(), to.clone())),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn a_page_one_side_trashed_goes_to_the_other_sides_trash_with_what_it_owns() {
        // A trash is never listed, so a page trashed here is just gone from here.
        let base = Folder::default()
            .with("Work/Plans/A.md", &note("a", "A", 1, "x"))
            .with("Work/Plans/A/B.md", &note("b", "B", 1, "child"))
            .with("Work/Plans/A/B/Set-page-assets/pic.png", "png")
            .with("Work/Plans.md", &note("p", "Plans", 1, "stays"));
        let local = Folder::default().with("Work/Plans.md", &note("p", "Plans", 1, "stays"));
        let (l, r, plan) = run(&base, &local, &base);
        assert!(same_content(&l, &r));
        assert_eq!(paths(&r), vec!["Work/Plans.md"]);
        assert!(trashed(&plan, Side::Local).is_empty());
        assert_eq!(
            trashed(&plan, Side::Remote),
            BTreeMap::from([
                ("Work/Plans/A.md".into(), "Work/Set-Trash/A.md".into()),
                ("Work/Plans/A/B.md".into(), "Work/Set-Trash/A/B.md".into()),
                (
                    "Work/Plans/A/B/Set-page-assets/pic.png".into(),
                    "Work/Set-Trash/A/B/Set-page-assets/pic.png".into()
                ),
            ]),
            "laid out as the app's trash is, so restoring A brings the subtree back"
        );
    }

    #[test]
    fn two_pages_of_one_name_trashed_together_get_two_names() {
        let base = Folder::default()
            .with("Set/X/Notes.md", &note("a", "Notes", 1, "one"))
            .with("Set/X/Notes/In.md", &note("c", "In", 1, "inside one"))
            .with("Set/Y/Notes.md", &note("b", "Notes", 1, "two"));
        let (_, _, plan) = run(&base, &Folder::default(), &base);
        let to: BTreeSet<String> = trashed(&plan, Side::Remote).into_values().collect();
        assert_eq!(
            to,
            BTreeSet::from([
                "Set/Set-Trash/Notes.md".to_string(),
                "Set/Set-Trash/Notes/In.md".to_string(),
                "Set/Set-Trash/Notes 2.md".to_string(),
            ])
        );
    }

    #[test]
    fn a_plan_that_would_trash_much_of_a_folder_says_so() {
        let folder = |pages: usize| {
            (0..pages).fold(Folder::default(), |f, i| {
                f.with(
                    &format!("Set/P{i}.md"),
                    &note(&format!("p{i}"), "P", 1, "x"),
                )
            })
        };
        let mass = |held: usize, kept: usize| {
            let (base, local) = (folder(held), folder(kept));
            let (_, _, plan) = run(&base, &local, &base);
            plan.mass_trash(&local.manifest(), &base.manifest())
        };
        assert_eq!(mass(40, 40), None);
        assert_eq!(mass(40, 30), None, "ten is a tidy-up");
        assert_eq!(mass(400, 380), None, "twenty of four hundred is too");
        assert_eq!(
            mass(40, 0),
            Some(MassTrash {
                local: 0,
                remote: 40
            }),
            "a folder that turned up empty"
        );
        assert!(mass(40, 25).is_some());
    }

    #[test]
    fn an_edit_outlives_the_other_side_trashing_the_page() {
        let base = Folder::default().with("Set/A.md", &note("a", "A", 1, "x"));
        let trashed_it = Folder::default();
        let edited = Folder::default().with("Set/A.md", &note("a", "A", 2, "x\nstill writing"));
        let (l, r, plan) = run(&base, &trashed_it, &edited);
        assert!(same_content(&l, &r));
        assert_eq!(paths(&l), vec!["Set/A.md"], "back, with the edit");
        assert!(trashed(&plan, Side::Remote).is_empty());
    }

    #[test]
    fn a_child_edited_while_the_other_side_trashed_its_parent_keeps_the_parent() {
        let base = Folder::default()
            .with("Set/A.md", &note("a", "A", 1, "parent"))
            .with("Set/A/B.md", &note("b", "B", 1, "child"));
        let trashed_it = Folder::default();
        let edited = base
            .clone()
            .with("Set/A/B.md", &note("b", "B", 2, "child\nedited"));
        let (l, r, _) = run(&base, &trashed_it, &edited);
        assert!(same_content(&l, &r));
        assert_eq!(paths(&l), vec!["Set/A.md", "Set/A/B.md"]);
    }

    #[test]
    fn edits_to_different_lines_merge_and_the_same_line_keeps_both() {
        let base = Folder::default().with("Set/A.md", &note("a", "A", 1, "one\ntwo\nthree"));
        let local = Folder::default().with("Set/A.md", &note("a", "A", 2, "one\ntwo\nthree\nfour"));
        let remote =
            Folder::default().with("Set/A.md", &note("a", "A", 3, "zero\none\ntwo\nthree"));
        let (l, r, plan) = run(&base, &local, &remote);
        assert!(same_content(&l, &r));
        let text = String::from_utf8(l.0["Set/A.md"].clone()).unwrap();
        assert!(text.contains("zero") && text.contains("four"), "{text}");
        assert!(plan.outcomes.iter().any(|o| o.kind == Kind::Merged));

        let local = Folder::default().with("Set/A.md", &note("a", "A", 2, "ONE\ntwo\nthree"));
        let remote = Folder::default().with("Set/A.md", &note("a", "A", 3, "uno\ntwo\nthree"));
        let (l, r, _) = run(&base, &local, &remote);
        assert!(same_content(&l, &r));
        assert_eq!(
            paths(&l),
            vec!["Set/A (conflict from Laptop).md", "Set/A.md"],
            "the older version is the copy, named for where it came from"
        );
        let copy = String::from_utf8(l.0["Set/A (conflict from Laptop).md"].clone()).unwrap();
        assert!(copy.contains("ONE"), "{copy}");
        assert!(copy.contains("\"A (conflict from Laptop)\""), "{copy}");
        assert!(
            !copy.contains("id: \"a\""),
            "the copy has an id of its own: {copy}"
        );
        assert!(String::from_utf8(l.0["Set/A.md"].clone())
            .unwrap()
            .contains("uno"));
    }

    #[test]
    fn a_page_never_agreed_on_keeps_both_rather_than_guessing() {
        let local = Folder::default().with("Set/A.md", &note("a", "A", 2, "one\nmine"));
        let remote = Folder::default().with("Set/A.md", &note("a", "A", 3, "one\ntheirs"));
        let (l, r, _) = run(&Folder::default(), &local, &remote);
        assert!(same_content(&l, &r));
        assert_eq!(l.0.len(), 2);
    }

    #[test]
    fn a_note_saved_again_on_both_sides_is_nobodys_edit() {
        let base = Folder::default().with("Set/A.md", &note("a", "A", 1, "same"));
        let local = Folder::default().with("Set/A.md", &note("a", "A", 5, "same"));
        let remote = Folder::default().with("Set/A.md", &note("a", "A", 9, "same"));
        let (_, _, plan) = run(&base, &local, &remote);
        assert!(plan.is_empty(), "{:?} {:?}", plan.local, plan.remote);
    }

    #[test]
    fn names_that_are_one_file_on_a_mac_get_two_names() {
        let linux = Folder::default()
            .with("Set/Notes.md", &note("a", "Notes", 1, "upper"))
            .with("Set/notes.md", &note("b", "notes", 1, "lower"));
        let (m, l, _) = run(&Folder::default(), &Folder::default(), &linux);
        assert!(same_content(&m, &l));
        let folded: BTreeSet<String> = m.0.keys().map(|p| manifest::fold(p)).collect();
        assert_eq!(folded.len(), 2, "{:?}", paths(&m));
    }

    #[test]
    fn a_page_moved_two_ways_goes_where_the_newer_move_put_it_with_its_children() {
        let base = Folder::default()
            .with("Set/A.md", &note("a", "A", 1, "x"))
            .with("Set/A/C.md", &note("c", "C", 1, "child"));
        let local = Folder::default()
            .with("Set/L.md", &note("a", "L", 2, "x"))
            .with("Set/L/C.md", &note("c", "C", 1, "child"));
        let remote = Folder::default()
            .with("Set/R.md", &note("a", "R", 3, "x"))
            .with("Set/R/C.md", &note("c", "C", 1, "child"));
        let (l, r, _) = run(&base, &local, &remote);
        assert!(same_content(&l, &r));
        assert_eq!(paths(&l), vec!["Set/R.md", "Set/R/C.md"]);
    }

    #[test]
    fn pages_moved_under_each_other_on_two_sides_still_all_land_somewhere() {
        let base = Folder::default()
            .with("Set/A.md", &note("a", "A", 1, "a"))
            .with("Set/B.md", &note("b", "B", 1, "b"));
        let local = Folder::default()
            .with("Set/B.md", &note("b", "B", 1, "b"))
            .with("Set/B/A.md", &note("a", "A", 2, "a"));
        let remote = Folder::default()
            .with("Set/A.md", &note("a", "A", 1, "a"))
            .with("Set/A/B.md", &note("b", "B", 2, "b"));
        let (l, r, _) = run(&base, &local, &remote);
        assert!(same_content(&l, &r));
        assert_eq!(l.0.len(), 2, "{:?}", paths(&l));
    }

    #[test]
    fn a_file_that_changed_since_it_was_listed_sits_the_round_out() {
        let base = Folder::default().with("Set/A.md", &note("a", "A", 1, "v1"));
        let remote = Folder::default().with("Set/A.md", &note("a", "A", 2, "v2"));
        let (drafted, wants) = draft(
            &base.manifest(),
            &seen(base.manifest()),
            &seen(remote.manifest()),
            u64::MAX,
            &Lineages::default(),
        );
        assert!(wants.remote.contains_key("Set/A.md"));
        // By the time it is fetched, it is something else again.
        let moved_on = Folder::default().with("Set/A.md", &note("a", "A", 3, "v3"));
        let fake = Fake {
            local: &base,
            remote: &moved_on,
            ancestors: vec![],
        };
        let plan = finish(drafted, &fake, &names());
        assert!(plan.is_empty());
        assert_eq!(plan.skipped.len(), 1);
        assert_eq!(plan.skipped[0].why, Skip::Moving);
    }

    #[test]
    fn a_file_one_side_couldnt_read_is_not_taken_for_deleted() {
        let base = Folder::default()
            .with("Set/A.md", &note("a", "A", 1, "kept"))
            .with("Set/A/Child.md", &note("c", "Child", 1, "kept too"))
            .with("Set/B.md", &note("b", "B", 1, "v1"));
        let local = Folder::default().with("Set/B.md", &note("b", "B", 1, "v1"));
        let mut local_seen = seen(local.manifest());
        local_seen.unreadable = ["Set/A.md".to_string(), "Set/A".to_string()].into();

        let (drafted, wants) = draft(
            &base.manifest(),
            &local_seen,
            &seen(base.manifest()),
            u64::MAX,
            &Lineages::default(),
        );
        assert_eq!(wants, Wants::default());
        let fake = Fake {
            local: &local,
            remote: &base,
            ancestors: Vec::new(),
        };
        let plan = finish(drafted, &fake, &names());
        assert!(plan.is_empty(), "{:?}", plan.remote);
        assert!(plan.skipped.iter().all(|s| s.why == Skip::Unreadable));
        assert_eq!(plan.skipped.len(), 2);
    }

    #[test]
    fn a_file_too_big_to_carry_is_left_alone_and_said_so() {
        let local = Folder::default().with("Set/A/Set-page-assets/big.png", &"x".repeat(100));
        let (drafted, wants) = draft(
            &Manifest::default(),
            &seen(local.manifest()),
            &Scan::default(),
            50,
            &Lineages::default(),
        );
        assert!(wants.local.is_empty() && wants.remote.is_empty());
        let fake = Fake {
            local: &local,
            remote: &Folder::default(),
            ancestors: vec![],
        };
        let plan = finish(drafted, &fake, &names());
        assert!(
            !plan
                .remote
                .iter()
                .flat_map(|b| &b.ops)
                .any(|op| matches!(op, Op::Write { .. })),
            "{:?}",
            plan.remote
        );
        assert_eq!(plan.skipped[0].why, Skip::TooBig { size: 100 });
    }

    #[test]
    fn an_empty_context_is_made_on_the_other_side_and_a_removed_one_removed() {
        let mut local = Manifest::default();
        local.contexts.insert("Ideas".to_string());
        let (drafted, _) = draft(
            &Manifest::default(),
            &seen(local),
            &Scan::default(),
            u64::MAX,
            &Lineages::default(),
        );
        let empty = Folder::default();
        let plan = finish(
            drafted,
            &Fake {
                local: &empty,
                remote: &empty,
                ancestors: vec![],
            },
            &names(),
        );
        assert_eq!(
            plan.remote[0].ops,
            vec![Op::MakeDir {
                name: "Ideas".to_string()
            }]
        );

        let mut base = Manifest::default();
        base.contexts.insert("Old".to_string());
        let (drafted, _) = draft(
            &base,
            &Scan::default(),
            &seen(base.clone()),
            u64::MAX,
            &Lineages::default(),
        );
        let plan = finish(
            drafted,
            &Fake {
                local: &empty,
                remote: &empty,
                ancestors: vec![],
            },
            &names(),
        );
        assert_eq!(
            plan.remote[0].ops,
            vec![Op::RemoveDir {
                name: "Old".to_string()
            }]
        );
    }

    #[test]
    fn loose_markdown_the_app_since_gave_an_id_is_still_the_same_file() {
        let loose = "# From another editor\n";
        let base = Folder::default().with("Set/Imported.md", loose);
        let local = Folder::default().with(
            "Set/Imported.md",
            &note("z", "Imported", 5, "# From another editor"),
        );
        let (l, r, plan) = run(&base, &local, &base);
        assert!(same_content(&l, &r));
        assert_eq!(paths(&r), vec!["Set/Imported.md"]);
        assert!(!plan
            .outcomes
            .iter()
            .any(|o| matches!(o.kind, Kind::Conflict { .. })));
    }

    fn clock(pairs: &[(&str, u64)]) -> Clock {
        pairs.iter().map(|(d, n)| (d.to_string(), *n)).collect()
    }

    fn stamp(content: &[(&str, u64)], place: &[(&str, u64)]) -> Stamp {
        Stamp {
            content: clock(content),
            place: clock(place),
        }
    }

    #[test]
    fn a_version_the_other_side_has_already_seen_is_the_older_one_whatever_the_baseline_says() {
        // The peer has since had v2 via a third device and made v3 from it.
        let v1 = note("a", "A", 5, "v1");
        let v2 = note("a", "A", 6, "v2");
        let v3 = note("a", "A", 7, "v3");
        let base = Folder::default().with("Set/A.md", &v1);
        let local = Folder::default().with("Set/A.md", &v2);
        let remote = Folder::default().with("Set/A.md", &v3);
        let groups = groups(&base.manifest(), &local.manifest(), &remote.manifest());

        let mut lineages = Lineages {
            here: "L".into(),
            ..Lineages::default()
        };
        lineages
            .local
            .insert("id:a".into(), stamp(&[("L", 2)], &[("L", 1)]));
        lineages
            .remote
            .insert("id:a".into(), stamp(&[("L", 2), ("R", 1)], &[("L", 1)]));
        assert_eq!(classify(&groups[0], &lineages), Content::Take(Side::Remote));
        assert!(
            matches!(
                classify(&groups[0], &Lineages::default()),
                Content::Merge { .. }
            ),
            "without lineage it would have looked like two edits"
        );

        // Made independently: the baseline decides, and what settles covers both.
        lineages
            .remote
            .insert("id:a".into(), stamp(&[("L", 1), ("R", 1)], &[("L", 1)]));
        assert!(matches!(
            classify(&groups[0], &lineages),
            Content::Merge { .. }
        ));
        let settled = lineages.settle(&groups[0], manifest::content_of(b"merged"), "Set/A.md");
        assert_eq!(
            settled.content,
            clock(&[("L", 3), ("R", 1)]),
            "a merge is a version of its own"
        );
        assert_eq!(settled.place, clock(&[("L", 1)]), "and it hasn't moved");
    }

    #[test]
    fn a_device_that_knows_fewer_of_its_own_versions_than_its_peer_is_not_believed() {
        // Lineage put back: stamps `L: 2`, a count the peer has seen used for something else.
        let base = Folder::default().with("Set/A.md", &note("a", "A", 1, "agreed"));
        let local = Folder::default().with("Set/A.md", &note("a", "A", 9, "a new edit"));
        let groups = groups(&base.manifest(), &local.manifest(), &base.manifest());
        let mut lineages = Lineages {
            here: "L".into(),
            there: "R".into(),
            ..Lineages::default()
        };
        lineages
            .local
            .insert("id:a".into(), stamp(&[("L", 2)], &[("L", 1)]));
        lineages
            .remote
            .insert("id:a".into(), stamp(&[("L", 3), ("R", 1)], &[("L", 1)]));
        assert_eq!(
            classify(&groups[0], &lineages),
            Content::Take(Side::Local),
            "the peer's clock covers this one, and would have thrown the edit away"
        );

        let settled = lineages.settle(
            &groups[0],
            local.manifest().files["Set/A.md"].content,
            "Set/A.md",
        );
        assert_eq!(
            settled.content,
            clock(&[("L", 4), ("R", 1)]),
            "and what settles is past every count either had used"
        );
    }

    #[test]
    fn a_page_the_other_side_deleted_having_seen_it_is_deleted_whatever_the_baseline_says() {
        // The pair never agreed on A, but the peer held exactly this copy and deleted it.
        let a = note("a", "A", 5, "a");
        let local = Folder::default().with("Set/A.md", &a);
        let empty = Folder::default();
        let groups = groups(&empty.manifest(), &local.manifest(), &empty.manifest());
        assert_eq!(
            classify(&groups[0], &Lineages::default()),
            Content::Take(Side::Local)
        );

        let mut lineages = Lineages::default();
        lineages
            .local
            .insert("id:a".into(), stamp(&[("L", 1)], &[("L", 1)]));
        lineages.remote.insert(
            "id:a".into(),
            stamp(&[("L", 1), ("R", 1)], &[("L", 1), ("R", 1)]),
        );
        assert_eq!(
            classify(&groups[0], &lineages),
            Content::Delete(Side::Local)
        );

        // An edit it never saw outlives the delete.
        lineages
            .local
            .insert("id:a".into(), stamp(&[("L", 2)], &[("L", 1)]));
        assert_eq!(classify(&groups[0], &lineages), Content::Take(Side::Local));

        let asked = questions(&empty.manifest(), &local.manifest(), &empty.manifest());
        assert_eq!(
            asked,
            vec![(
                "id:a".to_string(),
                Some((manifest::content_of(a.as_bytes()), place_of("Set/A.md"))),
                None
            )]
        );
    }

    #[test]
    fn a_place_seen_moved_on_from_is_older_even_after_both_have_held_both() {
        // Lists of past places cannot order that; clocks do.
        let a = note("a", "A", 5, "a");
        let base = Folder::default().with("Set/A.md", &a);
        let local = Folder::default().with("Set/Set-Trash/A.md", &a);
        let groups = groups(&base.manifest(), &local.manifest(), &base.manifest());
        let mut lineages = Lineages::default();
        lineages
            .local
            .insert("id:a".into(), stamp(&[("L", 1)], &[("L", 3), ("R", 2)]));
        lineages
            .remote
            .insert("id:a".into(), stamp(&[("L", 1)], &[("L", 2), ("R", 2)]));
        assert_eq!(choose_location(&groups[0], &lineages).1, Side::Local);
        lineages
            .remote
            .insert("id:a".into(), stamp(&[("L", 1)], &[("L", 3), ("R", 3)]));
        assert_eq!(choose_location(&groups[0], &lineages).1, Side::Remote);
    }

    #[test]
    fn a_folder_left_in_another_case_is_still_its_pages_folder() {
        // A Mac that renamed the page one file at a time kept the folder's old name.
        let page = note("n", "notes", 2, "page");
        let child = note("c", "Child", 1, "child");
        let local = Folder::default()
            .with("Set/notes.md", &page)
            .with("Set/Notes/Child.md", &child);
        let remote = Folder::default()
            .with("Set/notes.md", &page)
            .with("Set/notes/Child.md", &child);
        let groups = groups(&remote.manifest(), &local.manifest(), &remote.manifest());
        let child_group = groups.iter().find(|g| g.key == "id:c").unwrap();
        assert_eq!(
            child_group.local.as_ref().unwrap().loc,
            child_group.remote.as_ref().unwrap().loc
        );
        let (l, r, plan) = run(&remote, &local, &remote);
        assert_eq!(paths(&l), vec!["Set/notes.md", "Set/notes/Child.md"]);
        assert!(same_content(&l, &r));
        assert!(plan.remote.is_empty());
    }

    #[test]
    fn a_conflict_copy_cut_short_last_round_is_not_made_twice() {
        let base = Folder::default().with("Set/A.md", &note("a", "A", 1, "one"));
        let local = Folder::default().with("Set/A.md", &note("a", "A", 2, "mine"));
        let remote = Folder::default().with("Set/A.md", &note("a", "A", 3, "theirs"));
        let (l, _, _) = run(&base, &local, &remote);
        // The local side got its copy, the remote side never heard of it.
        let (l2, r2, _) = run(&base, &l, &remote);
        assert!(same_content(&l2, &r2));
        assert_eq!(l2.0.len(), 2, "{:?}", paths(&l2));
    }

    #[test]
    fn nor_is_a_copy_of_something_that_isnt_a_page() {
        // No id to know the copy by: it is the same bytes under the copy's name.
        let base = Folder::default().with("Set/A/Set-page-assets/pic.png", "one");
        let local = Folder::default().with("Set/A/Set-page-assets/pic.png", "mine");
        let remote = Folder::default().with("Set/A/Set-page-assets/pic.png", "theirs");
        let (l, r, _) = run(&base, &local, &remote);
        assert_eq!(l.0.len(), 2, "{:?}", paths(&l));
        for (mine, theirs) in [(&l, &remote), (&local, &r)] {
            let (l2, r2, _) = run(&base, mine, theirs);
            assert!(same_content(&l2, &r2));
            assert_eq!(l2.0.len(), 2, "{:?}", paths(&l2));
        }
    }
}
