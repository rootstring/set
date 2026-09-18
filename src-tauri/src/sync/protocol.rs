use serde::{Deserialize, Serialize};

use super::apply::Applied;
use super::manifest::{Hash, Scan};
use super::pairing::Secret;
use super::plan::{Batch, Settled, Stamp, Version};
use super::state::{Generation, GenerationId, Mark};

/// Exact match, not a minimum: bump whenever the wire shape or a round's meaning changes.
pub const VERSION: u32 = 5;

pub const ALPN: &[u8] = b"set/sync/1";

pub const MAX_MESSAGE: usize = 64 * 1024 * 1024;

pub const MAX_CLAIM: usize = 4 * 1024;

pub const FETCH_BATCH_BYTES: u64 = 8 * 1024 * 1024;
pub const FETCH_BATCH_FILES: usize = 32;

/// One fetch is one message; a larger file is left where it is and named in the log.
pub const MAX_FILE: u64 = MAX_MESSAGE as u64 - 1024 * 1024;

#[derive(Debug, Serialize, Deserialize)]
pub enum Request {
    Hello {
        version: u32,
        device_name: String,
        notes_id: String,
    },

    Manifest,

    Fetch {
        paths: Vec<String>,
    },

    Claim {
        version: u32,
        secret: Secret,

        device_name: String,

        notes_id: Option<String>,
    },

    /// `seen` is where this device last knew the peer's lineage to stand (`state::Mark`).
    Begin {
        seen: Option<Mark>,
    },

    /// Base versions of notes to merge, by content hash, from the peer's
    /// ancestor store.
    Ancestors {
        contents: Vec<Hash>,
    },

    /// Bytes the peer's half of the plan needs, spooled until `Apply`.
    Upload {
        blobs: Vec<Vec<u8>>,
    },

    /// The peer's half of the plan.
    Apply {
        batches: Vec<Batch>,
    },

    /// Stored by the peer before the planner does.
    Commit {
        generation: Generation,
        lineage: Vec<Settled>,
        mark: Mark,
    },

    /// Carries what only the planner knows: merges and conflict copies as `(page, copy)`.
    End {
        merged: Vec<String>,
        conflicts: Vec<(String, String)>,
    },

    /// The stamp of the peer's copy of each page, given what the peer holds of
    /// it (`None`: nothing), which the peer keeps as seen (`plan::Clock`).
    Lineage {
        pages: Vec<(String, Option<Version>)>,
    },
}

#[derive(Debug, Serialize, Deserialize)]
pub enum Response {
    Hello {
        version: u32,
        device_name: String,
        notes_id: String,
    },
    Manifest(Scan),

    Files(Vec<Option<Vec<u8>>>),
    Ok,
    Error(String),

    Paired {
        notes_id: String,
    },

    Refused {
        code: String,

        message: String,
    },

    /// `seen` is where the peer last knew this device's lineage to stand.
    Began {
        generations: Vec<GenerationId>,
        seen: Option<Mark>,
    },

    /// Where the peer's lineage stands with the round's outcome kept.
    Committed {
        mark: Mark,
    },

    /// The peer is in a round already, with this device or another.
    Busy,

    Applied(Applied),

    /// `actor` is what the peer's own versions are stamped as made by.
    Lineage {
        actor: String,
        stamps: Vec<Option<Stamp>>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    NotPaired,

    Version { theirs: u32 },

    DifferentNotes,
}

impl Refusal {
    pub fn code(&self) -> &'static str {
        match self {
            Refusal::NotPaired => "not_paired",
            Refusal::Version { .. } => "version_mismatch",
            Refusal::DifferentNotes => "different_notes",
        }
    }
}

impl std::fmt::Display for Refusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Refusal::NotPaired => write!(f, "this device isn't paired with that one"),
            Refusal::Version { theirs } => write!(
                f,
                "the other device speaks sync protocol {theirs}, this one speaks {VERSION}. Update the older one"
            ),
            Refusal::DifferentNotes => write!(
                f,
                "the other device is syncing a different notes folder; pair the devices that share one folder"
            ),
        }
    }
}

/// Version first: another protocol may mean something else by a notes id.
pub fn check_hello(ours: &str, theirs: &str, their_version: u32) -> Result<(), Refusal> {
    if their_version != VERSION {
        return Err(Refusal::Version {
            theirs: their_version,
        });
    }
    if ours != theirs {
        return Err(Refusal::DifferentNotes);
    }
    Ok(())
}

pub fn batches(paths: &[String], size_of: impl Fn(&str) -> u64) -> Vec<Vec<String>> {
    let mut out: Vec<Vec<String>> = Vec::new();
    let mut current: Vec<String> = Vec::new();
    let mut bytes = 0u64;
    for path in paths {
        let size = size_of(path);

        if !current.is_empty()
            && (current.len() >= FETCH_BATCH_FILES || bytes + size > FETCH_BATCH_BYTES)
        {
            out.push(std::mem::take(&mut current));
            bytes = 0;
        }
        bytes += size;
        current.push(path.clone());
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
}

pub fn encode<T: Serialize>(value: &T) -> Result<Vec<u8>, String> {
    postcard::to_allocvec(value).map_err(|e| format!("encoding sync message: {e}"))
}

pub fn decode<T: for<'de> Deserialize<'de>>(bytes: &[u8]) -> Result<T, String> {
    postcard::from_bytes(bytes).map_err(|e| format!("decoding sync message: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::manifest::{Entry, Hash, Manifest};

    #[test]
    fn a_hello_is_accepted_only_on_the_same_protocol_and_the_same_notes() {
        assert_eq!(check_hello("v", "v", VERSION), Ok(()));
        assert_eq!(
            check_hello("notes-a", "notes-b", VERSION),
            Err(Refusal::DifferentNotes)
        );
        assert_eq!(
            check_hello("mine", "theirs", 99),
            Err(Refusal::Version { theirs: 99 }),
            "a version difference outranks what it could be mistaken for"
        );
        let refusal = check_hello("v", "v", VERSION + 1).unwrap_err();
        assert!(
            refusal.to_string().contains("Update the older one"),
            "the message should say what to do: {refusal}"
        );
    }

    #[test]
    fn requests_and_responses_survive_the_wire() {
        let request = Request::Fetch {
            paths: vec!["A.md".to_string(), "B/C.png".to_string()],
        };
        let bytes = encode(&request).unwrap();
        let back: Request = decode(&bytes).unwrap();
        assert!(matches!(back, Request::Fetch { paths } if paths.len() == 2));

        let mut manifest = Manifest::default();
        manifest.contexts.insert("Set".to_string());
        manifest.files.insert(
            "A.md".to_string(),
            Entry {
                hash: Hash::of(b"body"),
                content: Hash::of(b"body-without-the-clock"),
                size: 4,
                updated_at: 100.0,
                page_id: Some("p1".to_string()),
            },
        );
        let scan = Scan {
            manifest,
            unreadable: ["Set/Locked.md".to_string()].into(),
        };
        let bytes = encode(&Response::Manifest(scan.clone())).unwrap();
        match decode::<Response>(&bytes).unwrap() {
            Response::Manifest(back) => assert_eq!(back, scan),
            other => panic!("expected a manifest, got {other:?}"),
        }
    }

    #[test]
    fn the_variant_order_on_the_wire_never_shifts() {
        let index = |request: &Request| encode(request).unwrap()[0];
        assert_eq!(
            index(&Request::Hello {
                version: VERSION,
                device_name: String::new(),
                notes_id: String::new(),
            }),
            0
        );
        assert_eq!(index(&Request::Manifest), 1);
        assert_eq!(index(&Request::Fetch { paths: Vec::new() }), 2);
        assert_eq!(
            index(&Request::Claim {
                version: VERSION,
                secret: crate::sync::pairing::Secret::generate(),
                device_name: String::new(),
                notes_id: None,
            }),
            3
        );
        assert_eq!(index(&Request::Begin { seen: None }), 4);
        assert_eq!(
            index(&Request::Ancestors {
                contents: Vec::new()
            }),
            5
        );
        assert_eq!(index(&Request::Upload { blobs: Vec::new() }), 6);
        assert_eq!(
            index(&Request::Apply {
                batches: Vec::new()
            }),
            7
        );
        assert_eq!(
            index(&Request::Commit {
                generation: crate::sync::state::Generation::new(Manifest::default()),
                lineage: Vec::new(),
                mark: crate::sync::state::Lineage::default().mark(),
            }),
            8
        );
        assert_eq!(
            index(&Request::End {
                merged: Vec::new(),
                conflicts: Vec::new()
            }),
            9
        );
        assert_eq!(index(&Request::Lineage { pages: Vec::new() }), 10);
    }

    #[test]
    fn the_response_variant_order_never_shifts_either() {
        let index = |response: &Response| encode(response).unwrap()[0];
        assert_eq!(
            index(&Response::Hello {
                version: VERSION,
                device_name: String::new(),
                notes_id: String::new(),
            }),
            0
        );
        assert_eq!(index(&Response::Manifest(Scan::default())), 1);
        assert_eq!(index(&Response::Files(Vec::new())), 2);
        assert_eq!(index(&Response::Ok), 3);
        assert_eq!(index(&Response::Error(String::new())), 4);
        assert_eq!(
            index(&Response::Paired {
                notes_id: String::new()
            }),
            5
        );
        assert_eq!(
            index(&Response::Refused {
                code: String::new(),
                message: String::new(),
            }),
            6
        );
        assert_eq!(
            index(&Response::Began {
                generations: Vec::new(),
                seen: None
            }),
            7
        );
        assert_eq!(
            index(&Response::Committed {
                mark: crate::sync::state::Lineage::default().mark()
            }),
            8
        );
        assert_eq!(index(&Response::Busy), 9);
        assert_eq!(
            index(&Response::Applied(crate::sync::apply::Applied::default())),
            10
        );
        assert_eq!(
            index(&Response::Lineage {
                actor: String::new(),
                stamps: Vec::new()
            }),
            11
        );
    }

    #[test]
    fn a_plan_survives_the_wire() {
        use crate::sync::plan::Op;
        let batches = vec![Batch {
            group: 3,
            ops: vec![
                Op::Move {
                    from: "Set/A.md".to_string(),
                    to: "Set/B.md".to_string(),
                    expect: Hash::of(b"a"),
                },
                Op::Write {
                    path: "Set/C.md".to_string(),
                    blob: Hash::of(b"c"),
                    expect: None,
                },
            ],
        }];
        let bytes = encode(&Request::Apply {
            batches: batches.clone(),
        })
        .unwrap();
        match decode::<Request>(&bytes).unwrap() {
            Request::Apply { batches: back } => assert_eq!(back, batches),
            other => panic!("expected a plan, got {other:?}"),
        }
    }

    #[test]
    fn a_claim_survives_the_wire_with_its_secret_intact() {
        let secret = crate::sync::pairing::Secret::generate();
        let bytes = encode(&Request::Claim {
            version: VERSION,
            secret: secret.clone(),
            device_name: "Laptop".to_string(),
            notes_id: Some("notes-1".to_string()),
        })
        .unwrap();
        match decode::<Request>(&bytes).unwrap() {
            Request::Claim {
                version,
                secret: back,
                device_name,
                notes_id,
            } => {
                assert_eq!(version, VERSION);
                assert!(
                    back.same_as(&secret),
                    "a secret that doesn't survive the wire can never be redeemed"
                );
                assert_eq!(device_name, "Laptop");
                assert_eq!(notes_id.as_deref(), Some("notes-1"));
            }
            other => panic!("expected a claim, got {other:?}"),
        }
    }

    #[test]
    fn a_batch_is_capped_by_bytes_as_well_as_by_count() {
        let paths: Vec<String> = (0..4).map(|i| format!("{i}.png")).collect();

        let batches = batches(&paths, |_| 3 * 1024 * 1024);
        assert_eq!(batches.len(), 2);
        assert_eq!(batches[0].len(), 2);
        assert_eq!(batches[1].len(), 2);
    }

    #[test]
    fn a_single_oversized_file_still_gets_its_own_batch() {
        let paths = vec!["huge.png".to_string(), "small.md".to_string()];
        let batches = batches(&paths, |p| {
            if p == "huge.png" {
                FETCH_BATCH_BYTES * 4
            } else {
                10
            }
        });
        assert_eq!(batches.len(), 2, "the big one must not swallow the rest");
        assert_eq!(batches[0], vec!["huge.png".to_string()]);
        assert_eq!(batches[1], vec!["small.md".to_string()]);
    }

    #[test]
    fn many_small_files_are_capped_by_count() {
        let paths: Vec<String> = (0..FETCH_BATCH_FILES * 2 + 1)
            .map(|i| format!("{i}.md"))
            .collect();
        let batches = batches(&paths, |_| 1);
        assert_eq!(batches.len(), 3);
        assert_eq!(batches[0].len(), FETCH_BATCH_FILES);
    }
}
