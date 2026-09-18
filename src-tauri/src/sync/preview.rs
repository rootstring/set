//! Made from the finished plan and nothing else, so it cannot say one thing while the round does
//! another.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use serde::Serialize;

use super::manifest::{self, Hash, Manifest};
use super::plan::{Blob, Kind, MassTrash, Op, Plan, Side, Skip};

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    /// Every file and context the round touches, or means to and can't.
    pub changes: Vec<Change>,

    /// With `changes`, the folder as both will have it afterwards.
    pub unchanged: Vec<String>,

    /// The contexts both have afterwards, so that an empty one still shows.
    pub contexts: Vec<String>,

    /// Filled in by the round; a note without one goes by its file name.
    pub titles: BTreeMap<String, String>,

    /// For the question to be put more pointedly.
    pub mass_trash: Option<Trashing>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Trashing {
    pub here: usize,
    pub there: usize,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    /// For something going to the trash, where it is now.
    pub path: String,

    /// A context rather than a file.
    pub dir: bool,

    /// `None` is a device that already has it as it should be.
    pub here: Option<Action>,
    pub there: Option<Action>,

    pub note: Option<Note>,

    /// Whether `Texts` can say what the change does to the words in it.
    pub diffable: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Action {
    pub verb: Verb,
    /// Where a moved file is now.
    pub from: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Verb {
    Add,
    Update,
    Move,
    /// To that device's own trash, where it can be put back from.
    Trash,
    /// A context left with nothing in it.
    Remove,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Note {
    /// Edited on both devices, and the two sets of edits fold into one note.
    Merged,
    /// The newer stays; the other is kept beside it as a `Copy`.
    Conflict,
    Copy,
    /// The rest are files the round leaves exactly where they are.
    TooBig,
    Unreadable,
    Changing,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Device {
    Here,
    There,
}

impl From<Side> for Device {
    fn from(side: Side) -> Self {
        match side {
            Side::Local => Device::Here,
            Side::Remote => Device::There,
        }
    }
}

/// Where to find the two versions of a note the round rewrites.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Text {
    /// This one when it changes here, the other when it only changes there.
    pub side: Side,
    pub before: Option<Held>,
    pub after: Hash,
    pub after_from: Blob,
}

/// A file as a device holds it now.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Held {
    pub path: String,
    pub hash: Hash,
    /// For the ancestor store.
    pub content: Option<Hash>,
}

/// By `Change::path`.
pub type Texts = HashMap<String, Text>;

pub fn of(plan: &Plan, local: &Manifest, remote: &Manifest) -> (Preview, Texts) {
    let copies: HashSet<&str> = plan
        .outcomes
        .iter()
        .filter_map(|outcome| match &outcome.kind {
            Kind::Conflict { copy } => Some(copy.as_str()),
            _ => None,
        })
        .collect();

    // Keyed by path and whether the file is leaving, so a trash and a create under one name are two
    // lines.
    let mut changes: BTreeMap<(String, bool), Change> = BTreeMap::new();
    let mut texts = Texts::new();
    let mut after: [BTreeSet<String>; 2] = [
        local.files.keys().cloned().collect(),
        remote.files.keys().cloned().collect(),
    ];

    for (side, after) in Side::BOTH.into_iter().zip(&mut after) {
        let held = |path: &str, hash: Hash| Held {
            path: path.to_string(),
            hash,
            content: match side {
                Side::Local => local,
                Side::Remote => remote,
            }
            .get(path)
            .map(|entry| entry.content),
        };
        for batch in plan.batches(side) {
            // A newer version written somewhere else: a move, as it reads.
            let mut replaced: Option<Held> = None;
            for op in &batch.ops {
                let (path, gone, dir, verb, from, write) = match op {
                    Op::Delete { path, expect } => {
                        after.remove(path);
                        replaced = Some(held(path, *expect));
                        continue;
                    }
                    Op::Move { from, to, .. } => {
                        after.remove(from);
                        after.insert(to.clone());
                        (to, false, false, Verb::Move, Some(from.clone()), None)
                    }
                    Op::Trash { path, .. } => {
                        after.remove(path);
                        (path, true, false, Verb::Trash, None, None)
                    }
                    Op::Write { path, blob, expect } => {
                        after.insert(path.clone());
                        let before = match expect {
                            Some(hash) => Some(held(path, *hash)),
                            None if copies.contains(path.as_str()) => None,
                            None => replaced.take(),
                        };
                        let (verb, from) = match &before {
                            Some(was) if was.path != *path => (Verb::Move, Some(was.path.clone())),
                            Some(_) => (Verb::Update, None),
                            None => (Verb::Add, None),
                        };
                        (path, false, false, verb, from, Some((*blob, before)))
                    }
                    Op::MakeDir { name } => (name, false, true, Verb::Add, None, None),
                    Op::RemoveDir { name } => (name, true, true, Verb::Remove, None, None),
                };
                let change = changes
                    .entry((path.clone(), gone))
                    .or_insert_with(|| Change {
                        path: path.clone(),
                        dir,
                        here: None,
                        there: None,
                        note: None,
                        diffable: false,
                    });
                let action = Some(Action { verb, from });
                match side {
                    Side::Local => change.here = action,
                    Side::Remote => change.there = action,
                }
                if let (Some((blob, before)), true) = (write, manifest::is_note(path)) {
                    if let Some(from) = plan.blobs.get(&blob) {
                        // This device's copy first: `Side::BOTH` starts here.
                        texts.entry(path.clone()).or_insert_with(|| Text {
                            side,
                            before,
                            after: blob,
                            after_from: from.clone(),
                        });
                        change.diffable = true;
                    }
                }
            }
        }
    }

    for outcome in &plan.outcomes {
        let mut mark = |path: &str, note: Note| {
            if let Some(change) = changes.get_mut(&(path.to_string(), false)) {
                change.note = Some(note);
            }
        };
        let main = outcome.finals.first().map(|f| f.path.as_str());
        match (&outcome.kind, main) {
            (Kind::Merged, Some(main)) => mark(main, Note::Merged),
            (Kind::Conflict { copy }, Some(main)) => {
                mark(main, Note::Conflict);
                mark(copy, Note::Copy);
            }
            _ => {}
        }
    }

    for skipped in &plan.skipped {
        changes
            .entry((skipped.path.clone(), false))
            .or_insert_with(|| Change {
                path: skipped.path.clone(),
                dir: false,
                here: None,
                there: None,
                note: None,
                diffable: false,
            })
            .note = Some(match skipped.why {
            Skip::TooBig { .. } => Note::TooBig,
            Skip::Unreadable => Note::Unreadable,
            Skip::Moving => Note::Changing,
        });
    }

    let [here, there] = after;
    let unchanged = here
        .union(&there)
        .filter(|path| !changes.contains_key(&((*path).clone(), false)))
        .cloned()
        .collect();

    let preview = Preview {
        changes: changes.into_values().collect(),
        unchanged,
        contexts: plan.contexts.iter().cloned().collect(),
        titles: BTreeMap::new(),
        mass_trash: plan
            .mass_trash(local, remote)
            .map(|MassTrash { local, remote }| Trashing {
                here: local,
                there: remote,
            }),
    };
    (preview, texts)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Diff {
    /// Whose copy this compares.
    pub side: Device,
    pub lines: Vec<Line>,
    /// The change runs past `MAX_LINES`, and this is the top of it.
    pub truncated: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Line {
    pub kind: LineKind,
    pub text: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LineKind {
    Same,
    Add,
    Del,
    /// Lines alike on both sides and left out, between two places that differ.
    Gap,
}

/// Not prose past this.
pub const MAX_TEXT: usize = 512 * 1024;

const MAX_LINES: usize = 400;

/// Lines shown either side of a change, to place it.
const CONTEXT: usize = 2;

/// `before` is `None` for a note new to the device, shown as what it says: none of its frontmatter
/// is anything anyone wrote.
pub fn diff(side: Side, before: Option<&[u8]>, after: &[u8]) -> Option<Diff> {
    let readable = |bytes: &[u8]| {
        (bytes.len() <= MAX_TEXT)
            .then(|| std::str::from_utf8(bytes).ok())
            .flatten()
            .map(without_save_time)
    };
    let (before, after) = match before {
        Some(bytes) => (readable(bytes)?, readable(after)?),
        None => (String::new(), body_of(&readable(after)?).to_string()),
    };

    let mut options = diffy::DiffOptions::new();
    options.set_context_len(CONTEXT);
    let patch = options.create_patch(&before, &after);

    let mut lines = Vec::new();
    for (i, hunk) in patch.hunks().iter().enumerate() {
        if i > 0 {
            lines.push(Line {
                kind: LineKind::Gap,
                text: String::new(),
            });
        }
        for line in hunk.lines() {
            let (kind, text) = match line {
                diffy::Line::Context(text) => (LineKind::Same, text),
                diffy::Line::Delete(text) => (LineKind::Del, text),
                diffy::Line::Insert(text) => (LineKind::Add, text),
            };
            lines.push(Line {
                kind,
                text: text.trim_end_matches(['\n', '\r']).to_string(),
            });
        }
    }
    let truncated = lines.len() > MAX_LINES;
    lines.truncate(MAX_LINES);
    Some(Diff {
        side: side.into(),
        lines,
        truncated,
    })
}

/// `None` for an empty title, which the app calls Untitled.
pub fn title_of(bytes: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(bytes).ok()?;
    let title = super::plan::frontmatter_title(text)?;
    let title = title.trim();
    (!title.is_empty()).then(|| title.to_string())
}

/// Otherwise every diff would include `updatedAt`.
fn without_save_time(text: &str) -> String {
    let Some((front, body)) = front_and_rest(text) else {
        return text.to_string();
    };
    let kept: Vec<&str> = front
        .split_inclusive('\n')
        .filter(|line| !line.trim_start().starts_with("updatedAt:"))
        .collect();
    format!("{}{body}", kept.concat())
}

/// A note's frontmatter up to its closing `---`, and everything from there on.
fn front_and_rest(text: &str) -> Option<(&str, &str)> {
    let end = text.strip_prefix("---")?.find("\n---")?;
    Some(text.split_at("---".len() + end))
}

/// What a note says, without its frontmatter or the blank lines under it.
fn body_of(text: &str) -> &str {
    let Some((_, rest)) = front_and_rest(text) else {
        return text;
    };
    // `rest` opens with the closing rule's own line.
    let body = rest[1..].split_once('\n').map_or("", |(_, body)| body);
    body.trim_start_matches(['\n', '\r'])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::plan::{Batch, Final, Outcome, Skipped, Stamp};

    fn h(text: &str) -> Hash {
        Hash::of(text.as_bytes())
    }

    fn manifest(paths: &[&str]) -> Manifest {
        let mut out = Manifest::default();
        for path in paths {
            out.files.insert(
                path.to_string(),
                manifest::describe_bytes(path.as_bytes(), path, || 0.0),
            );
        }
        out
    }

    fn outcome(group: u32, kind: Kind, finals: &[&str]) -> Outcome {
        Outcome {
            group,
            key: group.to_string(),
            kind,
            finals: finals
                .iter()
                .map(|path| Final {
                    path: path.to_string(),
                    content: h(path),
                })
                .collect(),
            fallback: Vec::new(),
            stamp: Stamp::default(),
            deleted: None,
        }
    }

    fn change<'a>(preview: &'a Preview, path: &str) -> &'a Change {
        preview
            .changes
            .iter()
            .find(|c| c.path == path)
            .unwrap_or_else(|| panic!("no change at {path}: {preview:#?}"))
    }

    fn verbs(change: &Change) -> (Option<Verb>, Option<Verb>) {
        (
            change.here.as_ref().map(|a| a.verb),
            change.there.as_ref().map(|a| a.verb),
        )
    }

    #[test]
    fn every_operation_reads_as_what_it_does_to_the_device_it_runs_on() {
        let local = manifest(&["Set/Stays.md", "Set/Edited.md", "Set/Old-name.md"]);
        let remote = manifest(&["Set/Stays.md", "Set/Edited.md", "Set/Let-go.md"]);
        let mut plan = Plan::default();
        plan.blobs
            .insert(h("new"), Blob::Remote("Set/Edited.md".into()));
        plan.blobs
            .insert(h("fresh"), Blob::Local("Set/Fresh.md".into()));
        plan.local = vec![Batch {
            group: 0,
            ops: vec![Op::Write {
                path: "Set/Edited.md".into(),
                blob: h("new"),
                expect: Some(h("old")),
            }],
        }];
        plan.remote = vec![
            Batch {
                group: 1,
                ops: vec![Op::Write {
                    path: "Set/Fresh.md".into(),
                    blob: h("fresh"),
                    expect: None,
                }],
            },
            Batch {
                group: 2,
                ops: vec![Op::Trash {
                    path: "Set/Let-go.md".into(),
                    to: "Set/Set-Trash/Let-go.md".into(),
                    expect: h("gone"),
                }],
            },
            Batch {
                group: 3,
                ops: vec![Op::MakeDir {
                    name: "Work".into(),
                }],
            },
        ];
        plan.local.push(Batch {
            group: 4,
            ops: vec![Op::Move {
                from: "Set/Old-name.md".into(),
                to: "Set/New-name.md".into(),
                expect: h("same"),
            }],
        });
        plan.contexts = ["Set".to_string(), "Work".to_string()].into();

        let (preview, texts) = of(&plan, &local, &remote);

        assert_eq!(
            verbs(change(&preview, "Set/Edited.md")),
            (Some(Verb::Update), None)
        );
        assert_eq!(
            verbs(change(&preview, "Set/Fresh.md")),
            (None, Some(Verb::Add))
        );
        assert_eq!(
            verbs(change(&preview, "Set/Let-go.md")),
            (None, Some(Verb::Trash))
        );
        let moved = change(&preview, "Set/New-name.md");
        assert_eq!(
            moved.here.as_ref().unwrap().from.as_deref(),
            Some("Set/Old-name.md")
        );
        assert!(change(&preview, "Work").dir);

        // The folder as it will be: the old name is gone from it, and what is
        // headed for a trash isn't listed as staying.
        assert_eq!(preview.unchanged, vec!["Set/Stays.md".to_string()]);
        assert_eq!(preview.contexts, vec!["Set", "Work"]);

        // Only a note being rewritten has two versions to compare.
        assert!(change(&preview, "Set/Edited.md").diffable && !moved.diffable);
        let text = &texts["Set/Edited.md"];
        assert_eq!(text.side, Side::Local);
        assert_eq!(text.before.as_ref().unwrap().hash, h("old"));
        assert!(texts["Set/Fresh.md"].before.is_none());
    }

    #[test]
    fn a_newer_version_written_under_another_name_is_a_move() {
        let local = manifest(&["Set/Draft.md"]);
        let mut plan = Plan::default();
        plan.blobs
            .insert(h("v2"), Blob::Remote("Set/Final.md".into()));
        plan.local = vec![Batch {
            group: 0,
            ops: vec![
                Op::Delete {
                    path: "Set/Draft.md".into(),
                    expect: h("v1"),
                },
                Op::Write {
                    path: "Set/Final.md".into(),
                    blob: h("v2"),
                    expect: None,
                },
            ],
        }];

        let (preview, texts) = of(&plan, &local, &manifest(&["Set/Final.md"]));

        let here = change(&preview, "Set/Final.md").here.clone().unwrap();
        assert_eq!(
            (here.verb, here.from.as_deref()),
            (Verb::Move, Some("Set/Draft.md"))
        );
        assert!(preview.unchanged.is_empty(), "{:?}", preview.unchanged);
        assert_eq!(
            texts["Set/Final.md"].before.as_ref().unwrap().path,
            "Set/Draft.md"
        );
    }

    #[test]
    fn merges_conflicts_and_files_sitting_out_say_so() {
        let both = manifest(&["Set/Shared.md", "Set/Fought.md", "Set/Film.mov"]);
        let mut plan = Plan::default();
        let copy = "Set/Fought (conflict, Mac).md";
        for blob in ["merged", "winner", "copy"] {
            plan.blobs
                .insert(h(blob), Blob::Made(blob.as_bytes().to_vec()));
        }
        let write = |path: &str, blob: &str, expect: Option<&str>| Op::Write {
            path: path.into(),
            blob: h(blob),
            expect: expect.map(h),
        };
        for side in [&mut plan.local, &mut plan.remote] {
            side.push(Batch {
                group: 0,
                ops: vec![write("Set/Shared.md", "merged", Some("mine"))],
            });
            side.push(Batch {
                group: 1,
                ops: vec![write(copy, "copy", None)],
            });
        }
        plan.remote[1]
            .ops
            .push(write("Set/Fought.md", "winner", Some("theirs")));
        plan.outcomes = vec![
            outcome(0, Kind::Merged, &["Set/Shared.md"]),
            outcome(
                1,
                Kind::Conflict {
                    copy: copy.to_string(),
                },
                &["Set/Fought.md", copy],
            ),
        ];
        plan.skipped = vec![Skipped {
            key: "film".into(),
            path: "Set/Film.mov".into(),
            why: Skip::TooBig { size: 1 << 30 },
            fallback: Vec::new(),
        }];

        let (preview, _) = of(&plan, &both, &both);

        assert_eq!(change(&preview, "Set/Shared.md").note, Some(Note::Merged));
        assert_eq!(change(&preview, "Set/Fought.md").note, Some(Note::Conflict));
        let kept = change(&preview, copy);
        assert_eq!(kept.note, Some(Note::Copy));
        assert_eq!(verbs(kept), (Some(Verb::Add), Some(Verb::Add)));
        let film = change(&preview, "Set/Film.mov");
        assert_eq!((verbs(film), film.note), ((None, None), Some(Note::TooBig)));
        assert!(preview.unchanged.is_empty(), "{:?}", preview.unchanged);
    }

    #[test]
    fn a_diff_shows_the_lines_that_change_and_not_the_save_time() {
        let before = "---\nid: a\nupdatedAt: 1\n---\none\ntwo\nthree\nfour\nfive\nsix\n";
        let after = "---\nid: a\nupdatedAt: 2\n---\none\ntwo\nthree\nfour\nfive\nsix, edited\n";
        let diff = diff(Side::Remote, Some(before.as_bytes()), after.as_bytes()).unwrap();

        assert_eq!(diff.side, Device::There);
        let shown: Vec<(LineKind, &str)> = diff
            .lines
            .iter()
            .map(|l| (l.kind, l.text.as_str()))
            .collect();
        assert_eq!(
            shown,
            vec![
                (LineKind::Same, "four"),
                (LineKind::Same, "five"),
                (LineKind::Del, "six"),
                (LineKind::Add, "six, edited"),
            ]
        );
    }

    #[test]
    fn a_new_note_is_all_additions_and_a_picture_has_no_diff() {
        let new = diff(Side::Local, None, b"hello\nthere\n").unwrap();
        assert!(new.lines.iter().all(|l| l.kind == LineKind::Add));
        assert_eq!(new.lines.len(), 2);

        // Only what it says: its frontmatter is new too, and nobody wrote it.
        let note = "---\nid: a\ntitle: \"Fresh\"\nupdatedAt: 2\n---\n\nfirst\n---\nafter a rule\n";
        let new = diff(Side::Local, None, note.as_bytes()).unwrap();
        let shown: Vec<&str> = new.lines.iter().map(|l| l.text.as_str()).collect();
        assert_eq!(shown, vec!["first", "---", "after a rule"]);
        assert!(new.lines.iter().all(|l| l.kind == LineKind::Add));

        assert_eq!(diff(Side::Local, None, &[0xff, 0xfe, 0x00]), None);
        assert_eq!(diff(Side::Local, None, &vec![b'a'; MAX_TEXT + 1]), None);
    }
}
