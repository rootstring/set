//! Body: line-based three-way merge. Frontmatter: field by field (`updatedAt` differs on every
//! save). No merge without a real ancestor: a guessed one undoes deletions. Every decision is made
//! from values in the versions, never from which device runs it, so both ends produce the same
//! bytes.

use super::manifest::Hash;

/// Lines kept as written, so a YAML list under `tags:` from another editor survives.
type Front = Vec<(String, String)>;

/// Lines are what goes back out: never respell a field neither side changed.
#[derive(Clone, Debug, PartialEq)]
struct Field {
    key: String,
    value: String,
    written: String,
}

/// Past this, both versions are kept.
pub const MAX_MERGE: usize = 4 * 1024 * 1024;

/// `None`: same lines changed, not text, or too big. The caller keeps both.
pub fn markdown(base: &[u8], local: &[u8], remote: &[u8]) -> Option<Vec<u8>> {
    if [base, local, remote].iter().any(|v| v.len() > MAX_MERGE) {
        return None;
    }
    let (base, local, remote) = (text(base)?, text(local)?, text(remote)?);

    let (local_front, local_body) = fields(&local);
    let (remote_front, remote_body) = fields(&remote);

    // diff3 is not symmetric where both insert at one point; order by content hash so both devices
    // compute the same bytes.
    let local_first = Hash::of(local.as_bytes()).0 < Hash::of(remote.as_bytes()).0;
    let (ours, theirs) = if local_first {
        (local_body, remote_body)
    } else {
        (remote_body, local_body)
    };

    let (base_front, base_body) = fields(&base);

    let body = diffy::merge(base_body, ours, theirs).ok()?;

    let front = merge_front(
        &base_front,
        &local_front,
        &remote_front,
        local_first,
        local_wins(&local_front, &remote_front, &local, &remote),
    );

    Some(compose(&front, &body).into_bytes())
}

/// Newer edit wins; an exact tie is broken by content hash.
fn local_wins(local: &[Field], remote: &[Field], local_text: &str, remote_text: &str) -> bool {
    let at = |front: &[Field]| {
        get(front, "updatedAt")
            .and_then(|field| field.value.parse::<f64>().ok())
            .unwrap_or(0.0)
    };
    let (l, r) = (at(local), at(remote));
    if l != r {
        return l > r;
    }
    Hash::of(local_text.as_bytes()).0 > Hash::of(remote_text.as_bytes()).0
}

/// A field only one side touched takes that side. `updatedAt` is overwritten outright.
/// `local_first` also orders fields, so both devices write the same spelling.
fn merge_front(
    base: &[Field],
    local: &[Field],
    remote: &[Field],
    local_first: bool,
    local_wins: bool,
) -> Vec<Field> {
    let mut out: Vec<Field> = Vec::new();

    let (first, second) = if local_first {
        (local, remote)
    } else {
        (remote, local)
    };
    let keys = first.iter().chain(second).map(|field| &field.key);

    for key in keys {
        if out.iter().any(|field| &field.key == key) {
            continue;
        }
        let (b, l, r) = (get(base, key), get(local, key), get(remote, key));
        fn says(field: Option<&Field>) -> Option<&str> {
            field.map(|f| f.value.as_str())
        }

        // Ours stands if we are the only side that moved this field, or if
        // both did and ours is the newer edit. Theirs stands in the mirror of
        // that case, which is the same rule read from the other device.
        let chosen = if says(l) == says(r) {
            l
        } else if says(l) == says(b) {
            r
        } else if says(r) == says(b) || local_wins {
            l
        } else {
            r
        };
        out.extend(chosen.cloned());
    }

    if let Some(slot) = out.iter_mut().find(|field| field.key == "updatedAt") {
        let newest = [local, remote]
            .iter()
            .filter_map(|front| get(front, "updatedAt"))
            .filter_map(|field| field.value.parse::<f64>().ok())
            .fold(f64::NEG_INFINITY, f64::max);
        if newest.is_finite() {
            slot.value = format!("{newest}");
            slot.written = format!("updatedAt: {newest}");
        }
    }

    out
}

fn get<'a>(front: &'a [Field], key: &str) -> Option<&'a Field> {
    front.iter().find(|field| field.key == key)
}

/// Only text: pasting half a PNG onto another is worse than keeping both.
fn text(bytes: &[u8]) -> Option<String> {
    Some(std::str::from_utf8(bytes).ok()?.replace("\r\n", "\n"))
}

/// Same shape as `scan::read_file_meta` and `splitFile` in TS. Lines that do not start a field
/// belong to the field above; skipping them lost `tags:` lists on every merge.
pub(crate) fn split(text: &str) -> (Front, &str) {
    let (front, body) = fields(text);
    let front = front.into_iter().map(|f| (f.key, f.value)).collect();
    (front, body)
}

fn fields(text: &str) -> (Vec<Field>, &str) {
    let Some(rest) = text.strip_prefix("---\n") else {
        return (Vec::new(), text);
    };
    let Some(end) = rest.find("\n---") else {
        return (Vec::new(), text);
    };

    let mut front: Vec<Field> = Vec::new();
    for line in rest[..end].split('\n') {
        match (field_start(line), front.last_mut()) {
            (Some(sep), _) => front.push(Field {
                key: line[..sep].trim().to_string(),
                value: line[sep + 1..].trim().to_string(),
                written: line.to_string(),
            }),
            (None, Some(field)) => {
                for part in [&mut field.value, &mut field.written] {
                    part.push('\n');
                    part.push_str(line);
                }
            }
            // Before any field: a field with no key.
            (None, None) => front.push(Field {
                key: String::new(),
                value: line.to_string(),
                written: line.to_string(),
            }),
        }
    }

    // Step over "
    // ---
    // " and the blank line `composeFile` puts after it.
    let body = rest.get(end + 5..).unwrap_or("");
    (front, body.strip_prefix('\n').unwrap_or(body))
}

/// Where the colon is, if `line` starts a frontmatter field rather than
/// continuing the one above it.
fn field_start(line: &str) -> Option<usize> {
    if line.starts_with(|c: char| c.is_whitespace() || c == '-' || c == '#') {
        return None;
    }
    line.find(':')
}

/// As `replaceId` in frontmatter.ts: line endings folded to LF, nothing else touched.
pub(crate) fn replace_field(text: &str, key: &str, value: &str) -> Option<String> {
    let normalized = text.replace("\r\n", "\n");
    let rest = normalized.strip_prefix("---\n")?;
    let end = rest.find("\n---")?;
    let prefix = format!("{key}:");
    let mut replaced = false;
    let lines: Vec<String> = rest[..end]
        .split('\n')
        .map(|line| {
            if !replaced && line.starts_with(&prefix) {
                replaced = true;
                format!(
                    "{key}: {}",
                    serde_json::to_string(value).unwrap_or_default()
                )
            } else {
                line.to_string()
            }
        })
        .collect();
    replaced.then(|| format!("---\n{}{}", lines.join("\n"), &rest[end..]))
}

fn compose(front: &[Field], body: &str) -> String {
    if front.is_empty() {
        return body.to_string();
    }
    let lines: Vec<&str> = front.iter().map(|f| f.written.as_str()).collect();
    format!("---\n{}\n---\n\n{body}", lines.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replacing_a_field_touches_that_line_and_nothing_else() {
        let text = "---\nid: \"old\"\ntitle: \"id: not this\"\n---\n\nid: nor this\n";
        assert_eq!(
            replace_field(text, "id", "new").as_deref(),
            Some("---\nid: \"new\"\ntitle: \"id: not this\"\n---\n\nid: nor this\n")
        );
        assert_eq!(replace_field("no frontmatter\n", "id", "new"), None);
        assert_eq!(
            replace_field("---\ntitle: \"A\"\n---\n\nx\n", "id", "new"),
            None
        );
    }

    /// A note as Set writes it: fenced frontmatter, blank line, body.
    fn note(title: &str, updated: u64, body: &str) -> Vec<u8> {
        format!(
            "---\nid: \"p1\"\ntitle: {title:?}\nparentId: null\ncreatedAt: 1\nupdatedAt: {updated}\n---\n\n{body}\n"
        )
        .into_bytes()
    }

    fn merged(base: &[u8], local: &[u8], remote: &[u8]) -> String {
        String::from_utf8(markdown(base, local, remote).expect("should have merged")).unwrap()
    }

    #[test]
    fn a_note_survives_being_taken_apart_and_put_back_together() {
        let original = String::from_utf8(note("Groceries", 5, "Milk\nEggs")).unwrap();
        let (front, body) = fields(&original);
        assert_eq!(compose(&front, body), original);
    }

    #[test]
    fn markdown_with_no_frontmatter_is_all_body() {
        let (front, body) = split("# Just a heading\n\nand some prose\n");
        assert!(front.is_empty());
        assert_eq!(body, "# Just a heading\n\nand some prose\n");
    }

    #[test]
    fn edits_to_different_parts_of_a_note_both_survive() {
        let base = note("Groceries", 1, "Milk\nEggs\nBread");
        let local = note("Groceries", 2, "Milk\nEggs\nBread\nCheese");
        let remote = note("Groceries", 3, "Coffee\nMilk\nEggs\nBread");

        let out = merged(&base, &local, &remote);
        assert!(
            out.contains("Cheese"),
            "the local edit went missing:\n{out}"
        );
        assert!(
            out.contains("Coffee"),
            "the remote edit went missing:\n{out}"
        );
    }

    #[test]
    fn two_devices_merging_the_same_pair_produce_the_same_file() {
        let base = note("Notes", 1, "one\ntwo\nthree");
        let local = note("Notes", 2, "one\nLOCAL\ntwo\nthree");
        let remote = note("Notes", 3, "one\ntwo\nthree\nREMOTE");

        assert_eq!(
            merged(&base, &local, &remote),
            merged(&base, &remote, &local),
            "each device sees itself as `local`; if that changed the result \
             they would swap files for ever"
        );
    }

    #[test]
    fn rewriting_the_same_line_two_ways_is_a_real_conflict() {
        let base = note("Notes", 1, "the original line");
        let local = note("Notes", 2, "the line as I typed it");
        let remote = note("Notes", 3, "the line as they typed it");

        assert_eq!(
            markdown(&base, &local, &remote),
            None,
            "a conflict has to be reported, not resolved by guessing"
        );
    }

    #[test]
    fn the_timestamp_every_save_rewrites_never_causes_a_conflict() {
        // Both sides always differ on `updatedAt`.
        let base = note("Notes", 1, "body");
        let local = note("Notes", 222, "body\nmine");
        let remote = note("Notes", 333, "theirs\nbody");

        let out = merged(&base, &local, &remote);
        assert!(
            out.contains("updatedAt: 333"),
            "expected the newer time:\n{out}"
        );
        assert_eq!(out.matches("updatedAt").count(), 1);
    }

    #[test]
    fn a_rename_on_one_device_and_an_edit_on_the_other_both_land() {
        let base = note("Old name", 1, "body");
        let local = note("New name", 5, "body");
        let remote = note("Old name", 3, "body\nplus a line");

        let out = merged(&base, &local, &remote);
        assert!(
            out.contains(r#"title: "New name""#),
            "lost the rename:\n{out}"
        );
        assert!(out.contains("plus a line"), "lost the edit:\n{out}");
    }

    #[test]
    fn when_both_devices_rename_a_page_the_newer_name_wins() {
        let base = note("Old", 1, "body");
        let older = note("Renamed early", 2, "body");
        let newer = note("Renamed later", 9, "body");

        for (local, remote) in [(&older, &newer), (&newer, &older)] {
            let out = merged(&base, local, remote);
            assert!(
                out.contains(r#"title: "Renamed later""#),
                "the newer rename should stand whichever side it came from:\n{out}"
            );
        }
    }

    #[test]
    fn the_merged_file_is_newer_than_both_of_its_parents() {
        // A merge that looked older than what it replaced would be ignored and never converge.
        let base = note("Notes", 1, "body");
        let local = note("Notes", 40, "body\nmine");
        let remote = note("Notes", 70, "theirs\nbody");

        let (front, _) = fields(&merged(&base, &local, &remote));
        let at: f64 = get(&front, "updatedAt").unwrap().value.parse().unwrap();
        assert!(at >= 70.0, "{at} is older than the versions it merged");
    }

    #[test]
    fn a_real_timestamp_is_written_as_digits_rather_than_in_exponent_form() {
        // Written as `1.72e12` it would still parse but look hand-mangled.
        let base = note("Notes", 1_720_000_000_000, "one\ntwo");
        let local = note("Notes", 1_788_725_000_123, "one\ntwo\nmine");
        let remote = note("Notes", 1_788_725_000_456, "theirs\none\ntwo");

        let out = merged(&base, &local, &remote);
        assert!(
            out.contains("updatedAt: 1788725000456"),
            "expected plain digits:\n{out}"
        );
        assert_eq!(
            crate::scan::page_identity(&out).1,
            Some(1_788_725_000_456.0),
            "the app's own reader has to get the same number back"
        );
    }

    #[test]
    fn a_merged_note_still_reads_as_a_note() {
        let base = note("Notes", 1, "one\ntwo");
        let local = note("Notes", 2, "one\ntwo\nthree");
        let remote = note("Notes", 3, "zero\none\ntwo");

        let out = merged(&base, &local, &remote);
        let (front, body) = fields(&out);

        assert_eq!(
            get(&front, "id").map(|f| f.value.as_str()),
            Some(r#""p1""#),
            "the page lost its id"
        );
        assert!(
            !body.contains("---"),
            "the fence leaked into the body:\n{out}"
        );
        assert_eq!(
            crate::scan::page_identity(&out).0.as_deref(),
            Some("p1"),
            "the app's own reader has to be able to open it"
        );
    }

    #[test]
    fn a_merge_never_leaves_conflict_markers_in_a_note() {
        let base = note("Notes", 1, "shared line");
        let local = note("Notes", 2, "my version");
        let remote = note("Notes", 3, "their version");

        // A note full of <<<<<<< is not something to hand back.
        assert!(markdown(&base, &local, &remote).is_none());
    }

    #[test]
    fn binary_files_are_never_merged() {
        let png = [0x89, b'P', b'N', b'G', 0x00, 0xff, 0xfe];
        assert_eq!(markdown(&png, &png, &png), None);
    }

    #[test]
    fn a_note_too_big_to_be_worth_merging_is_left_to_keep_both() {
        let base = note("Notes", 1, "one\ntwo");
        let local = note("Notes", 2, "one\ntwo\nmine");
        let huge = note("Notes", 3, &"x\n".repeat(MAX_MERGE / 2 + 1));

        assert_eq!(
            markdown(&base, &local, &huge),
            None,
            "a line diff this size belongs nowhere near the sync task"
        );
    }

    #[test]
    fn a_field_only_one_side_has_lands_in_the_same_place_on_both_devices() {
        // Same bytes, not just the same fields.
        let base = b"---\nid: \"p1\"\nupdatedAt: 1\n---\n\none\ntwo\n".to_vec();
        let local =
            b"---\nid: \"p1\"\nlocked: true\nupdatedAt: 2\n---\n\none\ntwo\nmine\n".to_vec();
        let remote =
            b"---\nid: \"p1\"\ntitle: \"T\"\nupdatedAt: 3\n---\n\ntheirs\none\ntwo\n".to_vec();

        let ours = merged(&base, &local, &remote);
        let theirs = merged(&base, &remote, &local);
        assert_eq!(ours, theirs, "the two devices wrote different files");
        assert!(ours.contains("locked") && ours.contains("title"), "{ours}");
    }

    #[test]
    fn a_field_one_side_deleted_stays_deleted() {
        let base = b"---\nid: \"p1\"\nlocked: true\nupdatedAt: 1\n---\n\nbody\n".to_vec();
        let local = b"---\nid: \"p1\"\nupdatedAt: 2\n---\n\nbody\nmine\n".to_vec();
        let remote = b"---\nid: \"p1\"\nlocked: true\nupdatedAt: 3\n---\n\nbody\n".to_vec();

        let out = merged(&base, &local, &remote);
        assert!(!out.contains("locked"), "the unlock was undone:\n{out}");
    }

    #[test]
    fn identical_edits_on_both_devices_merge_to_that_edit() {
        let base = note("Notes", 1, "one\ntwo");
        let local = note("Notes", 2, "one\ntwo\nthree");
        let remote = note("Notes", 3, "one\ntwo\nthree");

        let out = merged(&base, &local, &remote);
        let (_, body) = split(&out);
        assert_eq!(body, "one\ntwo\nthree\n");
    }

    // Frontmatter Set did not write.

    #[test]
    fn a_list_in_the_frontmatter_survives_a_merge() {
        let front = "---\nid: \"p1\"\ntags:\n  - reading\n  - later\nupdatedAt: 1\n---\n\n";
        let base = format!("{front}one\ntwo\n");
        let local = format!("{front}one\ntwo\nmine\n").replace("updatedAt: 1", "updatedAt: 2");
        let remote = format!("{front}theirs\none\ntwo\n").replace("updatedAt: 1", "updatedAt: 3");

        let out = merged(base.as_bytes(), local.as_bytes(), remote.as_bytes());
        assert!(
            out.contains("tags:\n  - reading\n  - later\n"),
            "the list was dropped or mangled:\n{out}"
        );
    }

    #[test]
    fn an_edit_to_a_list_is_an_edit_to_that_field() {
        let base = "---\nid: \"p1\"\ntags:\n  - a\nupdatedAt: 1\n---\n\nbody\n";
        let local = "---\nid: \"p1\"\ntags:\n  - a\n  - b\nupdatedAt: 2\n---\n\nbody\n";
        let remote = "---\nid: \"p1\"\ntags:\n  - a\nupdatedAt: 3\n---\n\nbody\nmore\n";

        let out = merged(base.as_bytes(), local.as_bytes(), remote.as_bytes());
        assert!(
            out.contains("  - a\n  - b\n"),
            "the new tag was lost:\n{out}"
        );
        assert!(out.contains("more"), "the body edit was lost:\n{out}");
    }

    #[test]
    fn frontmatter_set_didnt_write_goes_back_out_as_it_came_in() {
        let original =
            "---\n# a comment first\nid: \"p1\"\ntags:\n  - a\nempty:\nupdatedAt: 1\n---\n\nbody\n";
        let (front, body) = fields(original);
        assert_eq!(compose(&front, body), original);
    }

    #[test]
    fn a_body_that_only_looks_like_frontmatter_is_not_respelled_by_a_merge() {
        // Loose Markdown opening with a rule: everything down to the next one
        // reads as fields, and has to come back out as it was written.
        let top = "---\nhttps://example.com\nTitle:   spaced  \nkey:value\n---\n\n";
        let base = format!("{top}one\ntwo\n");
        let local = format!("{top}one\ntwo\nmine\n");
        let remote = format!("{top}theirs\none\ntwo\n");
        let out = markdown(base.as_bytes(), local.as_bytes(), remote.as_bytes()).unwrap();
        assert_eq!(
            String::from_utf8(out).unwrap(),
            format!("{top}theirs\none\ntwo\nmine\n")
        );
    }

    #[test]
    fn a_change_both_sides_made_the_same_way_merges_cleanly() {
        // A round cut short: one side holds the merge, the other its own edit. Not a conflict.
        let base = note("N", 1, "one\ntwo");
        let merged = note("N", 3, "zero\none\ntwo\nthree");
        let theirs = note("N", 2, "one\ntwo\nthree");
        let out = markdown(&base, &merged, &theirs).expect("identical changes aren't a conflict");
        assert_eq!(
            split(std::str::from_utf8(&out).unwrap()).1,
            split(std::str::from_utf8(&merged).unwrap()).1
        );
    }
}
