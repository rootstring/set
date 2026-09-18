use super::harness::{self, converge, Cut, Device, Saved};
use std::sync::{Arc, Mutex};

use crate::sync::manifest;
use crate::sync::preview;
use crate::sync::round::{self, Stage};

async fn pair() -> (Device, Device) {
    let notes = crate::page_id::random();
    (
        Device::new("Mac", &notes).await,
        Device::new("Linux", &notes).await,
    )
}

fn contains(device: &Device, id: &str, text: &str) -> bool {
    device.body(id).is_some_and(|b| b.contains(text))
}

#[tokio::test]
async fn a_page_made_on_one_device_arrives_on_the_other() {
    let (mac, linux) = pair().await;
    let id = mac.create("Set", "Hello", "first note");
    converge(&[&mac, &linux]).await;
    assert!(contains(&linux, &id, "first note"));
}

#[tokio::test]
async fn a_whole_subtree_arrives_with_images_too_big_for_one_batch() {
    let (mac, linux) = pair().await;
    let gallery = mac.create("Set", "Gallery", "pics");
    let child = mac.create_child(&gallery, "Deep", "nested");
    const MB: usize = 1024 * 1024;
    for i in 0..3 {
        mac.add_image(&gallery, &format!("k{i}.png"), &vec![i as u8; 3 * MB]);
    }
    converge(&[&mac, &linux]).await;
    assert!(contains(&linux, &child, "nested"));
    for i in 0..3 {
        let path = linux
            .root()
            .join(format!("Set/Gallery/Set-page-assets/k{i}.png"));
        assert_eq!(std::fs::metadata(path).unwrap().len(), 3 * MB as u64);
    }
}

#[tokio::test]
async fn an_edit_replaces_the_older_copy_and_a_settled_pair_does_nothing() {
    let (mac, linux) = pair().await;
    let id = mac.create("Set", "A", "v1");
    converge(&[&mac, &linux]).await;
    linux.edit(&id, |_| "v2".to_string());
    converge(&[&mac, &linux]).await;
    assert!(contains(&mac, &id, "v2"));

    let report = mac.sync(&linux).await.unwrap();
    assert_eq!((report.changed_here, report.changed_there), (0, 0));
    let report = linux.sync(&mac).await.unwrap();
    assert_eq!((report.changed_here, report.changed_there), (0, 0));
}

#[tokio::test]
async fn a_page_trashed_on_one_device_goes_to_the_others_own_trash() {
    let (mac, linux) = pair().await;
    let id = mac.create("Set", "Doomed", "bye");
    let child = mac.create_child(&id, "Also doomed", "bye too");
    mac.add_image(&child, "pic.png", b"png");
    converge(&[&mac, &linux]).await;

    mac.trash(&id);
    converge(&[&mac, &linux]).await;
    assert!(linux.page(&id).is_none() && linux.page(&child).is_none());
    let trashed: Vec<String> = linux.trash_pages().into_iter().map(|p| p.path).collect();
    assert_eq!(
        trashed,
        vec![
            "Set/Set-Trash/Doomed.md",
            "Set/Set-Trash/Doomed/Also-doomed.md"
        ],
        "as the app would have trashed it, so it restores whole"
    );
    assert!(linux
        .root()
        .join("Set/Set-Trash/Doomed/Also-doomed/Set-page-assets/pic.png")
        .exists());
    assert!(!linux.root().join("Set/Doomed").exists(), "no husk left");

    // Emptying a trash is that device's business alone.
    mac.delete_forever(&id);
    converge(&[&mac, &linux]).await;
    assert!(linux.trashed_page(&id).is_some());
    assert!(mac.page(&id).is_none() && linux.page(&id).is_none());
}

#[tokio::test]
async fn a_retitled_page_moves_with_its_children_rather_than_duplicating() {
    let (mac, linux) = pair().await;
    let id = mac.create("Set", "Old name", "body");
    let child = mac.create_child(&id, "Child", "kid");
    mac.add_image(&id, "k.png", b"png");
    converge(&[&mac, &linux]).await;
    mac.retitle(&id, "New name");
    converge(&[&mac, &linux]).await;
    assert_eq!(
        linux.paths(),
        vec![
            "Set/New-name.md".to_string(),
            "Set/New-name/Child.md".to_string(),
            "Set/New-name/Set-page-assets/k.png".to_string(),
        ]
    );
    assert!(linux.page(&child).is_some());
}

#[tokio::test]
async fn devices_that_already_hold_the_same_notes_pair_without_a_conflict() {
    let (mac, linux) = pair().await;
    let id = mac.create("Set", "Shared", "the same words");
    // The same file arrived on Linux some other way, and was saved again there.
    let text = std::fs::read_to_string(mac.root().join("Set/Shared.md")).unwrap();
    std::fs::write(linux.root().join("Set/Shared.md"), &text).unwrap();
    linux.edit(&id, |b| b.to_string());

    let report = mac.sync(&linux).await.unwrap();
    assert_eq!((report.changed_here, report.changed_there), (0, 0));
    assert!(report.conflicts.is_empty());
    converge(&[&mac, &linux]).await;
}

#[tokio::test]
async fn two_different_notes_folders_refuse_each_other() {
    let mac = Device::new("Mac", "notes-a").await;
    let linux = Device::new("Linux", "notes-b").await;
    let failure = mac.sync(&linux).await.expect_err("different folders");
    assert_eq!(failure.code, "different_notes");
}

#[tokio::test]
async fn retitling_untitled_and_making_a_new_one_while_the_other_edits_duplicates_nothing() {
    let (mac, linux) = pair().await;
    let x = mac.create("Set", "Untitled", "draft");
    converge(&[&mac, &linux]).await;

    linux.retitle(&x, "Groceries");
    let y = linux.create("Set", "Untitled", "a brand new page");
    mac.append(&x, "more from the mac");

    converge(&[&mac, &linux]).await;
    for device in [&mac, &linux] {
        assert!(device.conflict_copies().is_empty(), "{:?}", device.paths());
        assert_eq!(device.page(&x).unwrap().path, "Set/Groceries.md");
        assert!(contains(device, &x, "more from the mac"));
        assert_eq!(device.page(&y).unwrap().path, "Set/Untitled.md");
    }
}

#[tokio::test]
async fn typing_while_a_sync_lands_keeps_both_edits_at_every_moment() {
    for stage in [Stage::Planned, Stage::AppliedHere, Stage::AppliedThere] {
        for typing_on_coordinator in [true, false] {
            let (mac, linux) = pair().await;
            let id = mac.create("Set", "A", "one\ntwo\nthree");
            converge(&[&mac, &linux]).await;

            // The other device's edit, already on disk there.
            let (typist, other) = if typing_on_coordinator {
                (&mac, &linux)
            } else {
                (&linux, &mac)
            };
            other.edit(&id, |b| b.replace("two", "two from the other device"));

            // Someone is typing on the page; autosave hasn't fired yet.
            let mut editor = typist.open(&id);
            let folder = typist.folder();
            let saved = std::sync::Arc::new(std::sync::Mutex::new(None));
            let outcome = saved.clone();
            let editor_id = id.clone();
            mac.sync_with_hook(&linux, stage, move || {
                let result = editor.save(&folder, |b| format!("{b}four typed during the sync"));
                *outcome.lock().unwrap() = Some((result, editor_id.clone()));
            })
            .await
            .unwrap();
            assert!(
                saved.lock().unwrap().is_some(),
                "the editor saved mid-round"
            );

            converge(&[&mac, &linux]).await;
            for device in [&mac, &linux] {
                assert!(
                    contains(device, &id, "two from the other device")
                        && contains(device, &id, "four typed during the sync"),
                    "{stage:?}, typing on the coordinator: {typing_on_coordinator}: {:?}",
                    device.body(&id)
                );
                assert!(device.conflict_copies().is_empty());
            }
        }
    }
}

#[tokio::test]
async fn a_stale_editor_never_writes_over_what_sync_brought() {
    let (mac, linux) = pair().await;
    let id = mac.create("Set", "A", "one\ntwo");
    converge(&[&mac, &linux]).await;

    let mut editor = mac.open(&id);
    linux.append(&id, "from linux");
    converge(&[&mac, &linux]).await;

    assert_eq!(
        editor.save(&mac.folder(), |b| format!("zero\n{b}")),
        Saved::Merged
    );
    converge(&[&mac, &linux]).await;
    assert!(contains(&linux, &id, "from linux") && contains(&linux, &id, "zero"));
}

#[tokio::test]
async fn the_same_note_held_under_two_ids_loses_nothing() {
    // A folder copied by hand and opened in Set on both before pairing.
    let (mac, linux) = pair().await;
    let text = |id: &str| harness::compose(id, "Poems", None, 1, 2, "roses are red");
    std::fs::write(mac.root().join("Set/Poems.md"), text("mac-id")).unwrap();
    std::fs::write(linux.root().join("Set/Poems.md"), text("linux-id")).unwrap();
    mac.append("mac-id", "violets are blue");

    converge(&[&mac, &linux]).await;
    assert!(contains(&linux, "mac-id", "violets are blue"));
    assert!(contains(&linux, "linux-id", "roses are red"));
    assert!(mac.conflict_copies().is_empty());
}

#[tokio::test]
async fn two_new_pages_with_one_name_become_two_pages_each_keeping_its_id() {
    let (mac, linux) = pair().await;
    let a = mac.create("Set", "Untitled", "mac idea");
    let b = linux.create("Set", "Untitled", "linux idea");
    converge(&[&mac, &linux]).await;
    for device in [&mac, &linux] {
        assert!(device.conflict_copies().is_empty());
        assert!(contains(device, &a, "mac idea") && contains(device, &b, "linux idea"));
    }
}

#[cfg(unix)]
#[tokio::test]
async fn a_page_one_device_cant_read_is_not_deleted_on_the_other() {
    let (mac, linux) = pair().await;
    let id = mac.create("Set", "Locked", "keep me");
    let child = mac.create_child(&id, "Inside", "and me");
    converge(&[&mac, &linux]).await;

    let file = mac.root().join(mac.page(&id).unwrap().path);
    if !crate::testing::lock_away(&file) {
        return;
    }
    let report = mac.sync(&linux).await;
    let back = linux.sync(&mac).await;
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();
    }
    assert_eq!(
        report.unwrap().unreadable.len(),
        2,
        "the page and its child"
    );
    assert_eq!(
        back.unwrap().unreadable.len(),
        2,
        "whichever end coordinates"
    );
    assert!(contains(&linux, &id, "keep me") && contains(&linux, &child, "and me"));

    converge(&[&mac, &linux]).await;
    assert!(contains(&mac, &id, "keep me") && contains(&linux, &id, "keep me"));
}

#[tokio::test]
async fn a_round_that_would_trash_most_of_a_folder_asks_first() {
    let (mac, linux) = pair().await;
    let ids: Vec<String> = (0..30)
        .map(|i| mac.create("Set", &format!("Page {i}"), "kept, one hopes"))
        .collect();
    converge(&[&mac, &linux]).await;

    // The mac turns up with next to nothing: the wrong folder, a bad restore.
    for id in &ids[1..] {
        mac.trash(id);
    }
    // The preview says so, which is what makes the question a pointed one,
    // and a no leaves everything where it was.
    let asked = Arc::new(Mutex::new(None));
    let seen = asked.clone();
    let before = linux.snapshot();
    let round = linux
        .sync_asking(&mac, move |review| {
            *seen.lock().unwrap() = review.preview.mass_trash;
            false
        })
        .await
        .unwrap();
    assert!(matches!(round, round::Round::Declined), "{round:?}");
    let mass = asked.lock().unwrap().expect("flagged as a mass trash");
    assert_eq!((mass.here, mass.there), (29, 0));
    assert_eq!(linux.snapshot(), before, "nothing was touched");
    assert!(linux.trash_pages().is_empty());

    // The round before let go of its locks, or this one would find linux busy.
    let seen = asked.clone();
    mac.sync_asking(&linux, move |review| {
        *seen.lock().unwrap() = review.preview.mass_trash;
        false
    })
    .await
    .unwrap();
    let mass = asked.lock().unwrap().expect("flagged from this end too");
    assert_eq!((mass.here, mass.there), (0, 29));
    mac.sync(&linux).await.unwrap();
    assert_eq!(linux.pages().len(), 1);
    assert_eq!(
        linux.trash_pages().len(),
        29,
        "and all of it can be put back"
    );
}

#[tokio::test]
async fn a_round_shows_what_it_will_do_and_does_nothing_until_told_to() {
    use crate::sync::preview::{Device as On, LineKind, Verb};

    let (mac, linux) = pair().await;
    let edited = mac.create("Set", "Edited", "first line");
    let pushed = mac.create("Set", "Pushed", "as it was");
    let gone = mac.create("Set", "Long gone", "not for long");
    mac.create("Set", "Quiet", "nobody touches this");
    converge(&[&mac, &linux]).await;

    mac.append(&edited, "a line from the mac");
    mac.trash(&gone);
    mac.create("Set", "Brand new", "hello");
    linux.append(&pushed, "a line from linux");

    type Seen = (preview::Preview, Vec<(String, Option<preview::Diff>)>);
    let seen: Arc<Mutex<Option<Seen>>> = Arc::default();
    let look = |seen: &Arc<Mutex<Option<Seen>>>, go: bool| {
        let seen = seen.clone();
        move |review: &round::Review| {
            let diffs = review
                .preview
                .changes
                .iter()
                .map(|c| (c.path.clone(), (review.diff)(&c.path)))
                .collect();
            *seen.lock().unwrap() = Some((review.preview.clone(), diffs));
            go
        }
    };

    // No: both folders are exactly as they were.
    let (before_here, before_there) = (linux.snapshot(), mac.snapshot());
    let round = linux.sync_asking(&mac, look(&seen, false)).await.unwrap();
    assert!(matches!(round, round::Round::Declined), "{round:?}");
    assert_eq!(linux.snapshot(), before_here);
    assert_eq!(mac.snapshot(), before_there);

    let (shown, diffs) = seen.lock().unwrap().take().expect("it was asked");
    let verbs = |path: &str| {
        let change = shown
            .changes
            .iter()
            .find(|c| c.path == path)
            .unwrap_or_else(|| panic!("nothing about {path}: {shown:#?}"));
        (
            change.here.as_ref().map(|a| a.verb),
            change.there.as_ref().map(|a| a.verb),
        )
    };
    assert_eq!(verbs("Set/Edited.md"), (Some(Verb::Update), None));
    assert_eq!(verbs("Set/Pushed.md"), (None, Some(Verb::Update)));
    assert_eq!(verbs("Set/Long-gone.md"), (Some(Verb::Trash), None));
    assert_eq!(verbs("Set/Brand-new.md"), (Some(Verb::Add), None));
    assert_eq!(shown.unchanged, vec!["Set/Quiet.md".to_string()]);
    assert_eq!(shown.mass_trash, None);

    // Pages go by their titles, wherever a copy to read one from is: here, in
    // what was just fetched, or for a page this device no longer has, in what
    // the two last agreed on.
    let title = |path: &str| shown.titles.get(path).map(String::as_str);
    assert_eq!(title("Set/Quiet.md"), Some("Quiet"));
    assert_eq!(title("Set/Brand-new.md"), Some("Brand new"));
    assert_eq!(title("Set/Long-gone.md"), Some("Long gone"));

    // Each rewrite can be read: this device's copy against what is coming,
    // and the other's (which was never fetched) against what is going.
    let added = |path: &str| {
        let diff = diffs
            .iter()
            .find(|(p, _)| p == path)
            .and_then(|(_, diff)| diff.clone())
            .unwrap_or_else(|| panic!("no diff for {path}"));
        let lines: Vec<String> = diff
            .lines
            .into_iter()
            .filter(|l| l.kind == LineKind::Add)
            .map(|l| l.text)
            .collect();
        (diff.side, lines.join("|"))
    };
    assert_eq!(
        added("Set/Edited.md"),
        (On::Here, "a line from the mac".to_string())
    );
    assert_eq!(
        added("Set/Pushed.md"),
        (On::There, "a line from linux".to_string())
    );
    assert!(added("Set/Brand-new.md").1.contains("hello"));

    // Asked from the mac, the page it let go of is one only linux still holds,
    // and it is still called by its title.
    let gone_path = "Set/Long-gone.md";
    let round = mac.sync_asking(&linux, look(&seen, false)).await.unwrap();
    assert!(matches!(round, round::Round::Declined), "{round:?}");
    let (mirrored, _) = seen.lock().unwrap().take().expect("it was asked");
    let there = mirrored.changes.iter().find(|c| c.path == gone_path);
    assert_eq!(
        there.and_then(|c| c.there.as_ref()).map(|a| a.verb),
        Some(Verb::Trash),
        "{mirrored:#?}"
    );
    assert_eq!(
        mirrored.titles.get(gone_path).map(String::as_str),
        Some("Long gone")
    );

    // Yes: the round does what it showed, and the next has nothing to show.
    linux.sync_asking(&mac, look(&seen, true)).await.unwrap();
    assert!(contains(&linux, &edited, "a line from the mac"));
    assert!(contains(&mac, &pushed, "a line from linux"));
    assert!(linux.page(&gone).is_none() && linux.trashed_page(&gone).is_some());
    harness::assert_same(&mac.folder(), &linux.folder());

    *seen.lock().unwrap() = None;
    linux.sync_asking(&mac, look(&seen, false)).await.unwrap();
    assert!(
        seen.lock().unwrap().is_none(),
        "a round with nothing to do has nothing to ask"
    );
}

#[tokio::test]
async fn a_notes_folder_that_has_gone_fails_the_round_and_deletes_nothing() {
    let (mac, linux) = pair().await;
    let id = mac.create("Set", "Hello", "still here");
    converge(&[&mac, &linux]).await;

    let away = mac.root().with_extension("unplugged");
    std::fs::rename(mac.root(), &away).unwrap();
    let here = mac.sync(&linux).await;
    let there = linux.sync(&mac).await;
    std::fs::rename(&away, mac.root()).unwrap();

    assert_eq!(here.unwrap_err().code, "notes_folder");
    assert!(there.is_err(), "whichever end coordinates");
    assert!(contains(&linux, &id, "still here"));
    converge(&[&mac, &linux]).await;
    assert!(contains(&mac, &id, "still here"));
}

#[tokio::test]
async fn an_edit_made_after_lineage_was_lost_is_not_taken_for_an_old_version() {
    let (mac, linux) = pair().await;
    let id = mac.create("Set", "Notes", "one");
    converge(&[&mac, &linux]).await;
    linux.append(&id, "two from linux");
    converge(&[&mac, &linux]).await;

    // Counts start again at one, which linux has long since seen from the mac.
    std::fs::remove_file(&mac.dirs().lineage).unwrap();
    mac.append(&id, "three from the mac");
    converge(&[&mac, &linux]).await;
    assert!(contains(&linux, &id, "three from the mac"));
    assert!(contains(&mac, &id, "two from linux") && contains(&mac, &id, "three from the mac"));
}

#[tokio::test]
async fn an_edit_made_after_lineage_was_put_back_is_not_taken_for_an_old_version() {
    let (mac, linux) = pair().await;
    let id = mac.create("Set", "Notes", "one");
    converge(&[&mac, &linux]).await;
    let backup = std::fs::read(&mac.dirs().lineage).unwrap();
    mac.append(&id, "two from the mac");
    converge(&[&mac, &linux]).await;
    linux.append(&id, "three from linux");
    converge(&[&mac, &linux]).await;

    // A restored backup: the mac's next edit is stamped with the count it used
    // for "two", which linux's copy has seen and built on.
    std::fs::write(&mac.dirs().lineage, backup).unwrap();
    mac.append(&id, "four from the mac");
    converge(&[&mac, &linux]).await;
    assert!(contains(&linux, &id, "four from the mac"));
    assert!(contains(&mac, &id, "three from linux") && contains(&mac, &id, "four from the mac"));
}

#[tokio::test]
async fn edits_to_different_lines_merge() {
    let (mac, linux) = pair().await;
    let id = mac.create("Set", "A", "one\ntwo\nthree");
    converge(&[&mac, &linux]).await;
    mac.edit(&id, |b| format!("zero\n{b}"));
    linux.append(&id, "four");
    let report = linux.sync(&mac).await.unwrap();
    assert_eq!(report.merged, vec!["Set/A.md".to_string()]);
    {
        // What reloads the page open in the answering device's editor.
        let answered = mac.answered.lock().unwrap();
        let last = answered.last().expect("told when the round ended");
        assert!(last.changed > 0);
        assert_eq!(last.merged, vec!["Set/A.md".to_string()]);
    }
    converge(&[&mac, &linux]).await;
    assert!(contains(&mac, &id, "zero") && contains(&mac, &id, "four"));
}

#[tokio::test]
async fn the_same_line_rewritten_twice_keeps_both_exactly_once() {
    let (mac, linux) = pair().await;
    let id = mac.create("Set", "A", "the original");
    converge(&[&mac, &linux]).await;
    mac.edit(&id, |_| "how the mac put it".to_string());
    linux.edit(&id, |_| "how linux put it, later".to_string());

    converge(&[&mac, &linux]).await;
    converge(&[&mac, &linux]).await;
    for device in [&mac, &linux] {
        assert_eq!(
            device.conflict_copies(),
            vec!["Set/A (conflict from Mac).md".to_string()],
            "the older version is the copy, once"
        );
        assert!(contains(device, &id, "how linux put it, later"));
        assert!(device.all_text().contains("how the mac put it"));
    }
}

#[tokio::test]
async fn a_lost_ancestor_is_asked_of_the_other_device() {
    let (mac, linux) = pair().await;
    let id = mac.create("Set", "A", "one\ntwo\nthree");
    converge(&[&mac, &linux]).await;
    std::fs::remove_dir_all(mac.dirs().ancestors).unwrap();
    mac.edit(&id, |b| format!("zero\n{b}"));
    linux.append(&id, "four");
    let report = mac.sync(&linux).await.unwrap();
    assert!(report.conflicts.is_empty(), "{report:?}");
    converge(&[&mac, &linux]).await;
    assert!(contains(&linux, &id, "zero") && contains(&linux, &id, "four"));
}

#[tokio::test]
async fn an_edit_on_one_device_outlives_the_other_trashing_the_page() {
    let (mac, linux) = pair().await;
    let id = mac.create("Set", "A", "keep me");
    converge(&[&mac, &linux]).await;
    mac.trash(&id);
    linux.append(&id, "still writing");
    converge(&[&mac, &linux]).await;
    assert_eq!(mac.page(&id).unwrap().path, "Set/A.md");
    assert!(contains(&mac, &id, "still writing"));
    assert!(linux.trash_pages().is_empty());
}

#[tokio::test]
async fn a_page_restored_on_one_device_comes_back_on_the_other() {
    let (mac, linux) = pair().await;
    let id = mac.create("Set", "A", "back soon");
    converge(&[&mac, &linux]).await;
    mac.trash(&id);
    converge(&[&mac, &linux]).await;
    mac.restore(&id);
    converge(&[&mac, &linux]).await;
    assert!(contains(&linux, &id, "back soon"));

    // Linux still has the copy it trashed. Restoring that one too makes a
    // second page, under an id of its own, as it does in the app.
    linux.restore(&id);
    converge(&[&mac, &linux]).await;
    assert_eq!(mac.pages().len(), 2, "{:?}", mac.paths());
}

#[tokio::test]
async fn trashing_a_page_while_its_child_is_edited_keeps_both() {
    let (mac, linux) = pair().await;
    let parent = mac.create("Set", "Parent", "p");
    let child = mac.create_child(&parent, "Child", "c");
    converge(&[&mac, &linux]).await;
    mac.trash(&parent);
    linux.append(&child, "edited meanwhile");
    converge(&[&mac, &linux]).await;
    for device in [&mac, &linux] {
        assert!(device.page(&parent).is_some(), "{:?}", device.paths());
        assert!(contains(device, &child, "edited meanwhile"));
    }
}

#[tokio::test]
async fn a_subtree_moved_on_one_device_while_edited_inside_on_the_other() {
    let (mac, linux) = pair().await;
    let projects = mac.create("Set", "Projects", "index");
    let launch = mac.create_child(&projects, "Launch", "plan");
    let work = mac.create("Set", "Work", "work");
    mac.add_image(&launch, "k.png", b"png");
    converge(&[&mac, &linux]).await;

    mac.move_under(&projects, Some(&work));
    linux.append(&launch, "edited where it used to be");
    converge(&[&mac, &linux]).await;
    for device in [&mac, &linux] {
        assert_eq!(
            device.page(&launch).unwrap().path,
            "Set/Work/Projects/Launch.md"
        );
        assert!(contains(device, &launch, "edited where it used to be"));
        assert!(device
            .root()
            .join("Set/Work/Projects/Launch/Set-page-assets/k.png")
            .exists());
        assert!(
            !device.root().join("Set/Projects").exists(),
            "{:?}",
            device.paths()
        );
    }
}

#[tokio::test]
async fn swapping_two_page_names_leaves_nothing_behind() {
    let (mac, linux) = pair().await;
    let a = mac.create("Set", "A", "was a");
    let b = mac.create("Set", "B", "was b");
    converge(&[&mac, &linux]).await;
    mac.retitle(&a, "Temp");
    mac.retitle(&b, "A");
    mac.retitle(&a, "B");
    converge(&[&mac, &linux]).await;
    assert_eq!(linux.page(&a).unwrap().path, "Set/B.md");
    assert_eq!(linux.page(&b).unwrap().path, "Set/A.md");
}

#[tokio::test]
async fn contexts_are_made_renamed_and_removed_across() {
    let (mac, linux) = pair().await;
    std::fs::create_dir_all(mac.root().join("Ideas")).unwrap();
    let id = mac.create("Work", "Plan", "p");
    // A folder inside the context, which has to be gone before the context can be.
    let child = mac.create_child(&id, "Step", "s");
    converge(&[&mac, &linux]).await;
    assert!(
        linux.contexts().contains("Ideas"),
        "an empty context arrives"
    );

    std::fs::rename(mac.root().join("Work"), mac.root().join("Job")).unwrap();
    std::fs::remove_dir(mac.root().join("Ideas")).unwrap();
    converge(&[&mac, &linux]).await;
    assert_eq!(linux.page(&id).unwrap().path, "Job/Plan.md");
    assert_eq!(linux.page(&child).unwrap().path, "Job/Plan/Step.md");
    for device in [&mac, &linux] {
        let contexts = device.contexts();
        assert!(
            !contexts.contains("Work") && !contexts.contains("Ideas"),
            "{contexts:?}"
        );
    }
}

#[tokio::test]
async fn names_that_differ_only_in_case_both_survive() {
    let (mac, linux) = pair().await;
    std::fs::write(linux.root().join("Set/probe"), "x").unwrap();
    if linux.root().join("Set/PROBE").exists() {
        // This filesystem cannot hold the two at once; the plan tests cover renaming.
        return;
    }
    std::fs::remove_file(linux.root().join("Set/probe")).unwrap();
    let upper = linux.create("Set", "Notes", "upper");
    let lower = linux.create("Set", "notes", "lower");
    converge(&[&mac, &linux]).await;
    for device in [&mac, &linux] {
        assert!(contains(device, &upper, "upper") && contains(device, &lower, "lower"));
        let folded: std::collections::BTreeSet<String> =
            device.paths().iter().map(|p| manifest::fold(p)).collect();
        assert_eq!(folded.len(), device.paths().len());
    }
}

#[tokio::test]
async fn a_page_renamed_only_in_case_keeps_its_children_on_both_devices() {
    let (mac, linux) = pair().await;
    let page = mac.create("Set", "notes", "page");
    let child = mac.create_child(&page, "Child", "child");
    mac.add_image(&page, "pic.png", b"png");
    converge(&[&mac, &linux]).await;

    // Renamed by hand, the file alone: its folder keeps the old case. Where
    // the filesystem ignores case that is still the page's folder.
    let root = linux.root();
    std::fs::rename(root.join("Set/notes.md"), root.join("Set/Notes.md")).unwrap();
    converge(&[&mac, &linux]).await;

    for device in [&mac, &linux] {
        let paths = device.paths();
        assert_eq!(
            device.page(&page).unwrap().path,
            "Set/Notes.md",
            "{paths:?}"
        );
        assert_eq!(
            device.page(&child).unwrap().path,
            "Set/Notes/Child.md",
            "{paths:?}"
        );
        assert!(
            paths
                .iter()
                .any(|p| p == "Set/Notes/Set-page-assets/pic.png"),
            "{paths:?}"
        );
        // What a directory listing says, not what a lookup that ignores case
        // would let through.
        let listed: Vec<String> = std::fs::read_dir(device.root().join("Set"))
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| !n.starts_with('.'))
            .collect();
        assert!(
            listed.contains(&"Notes".to_string()),
            "{} {listed:?}",
            device.name
        );
        assert!(
            !listed.contains(&"notes".to_string()),
            "{} {listed:?}",
            device.name
        );
    }
}

#[tokio::test]
async fn a_duplicate_made_outside_set_gets_an_id_of_its_own() {
    let (mac, linux) = pair().await;
    let id = mac.create("Set", "Original", "words");
    std::fs::copy(
        mac.root().join("Set/Original.md"),
        mac.root().join("Set/Original copy.md"),
    )
    .unwrap();
    converge(&[&mac, &linux]).await;
    // Which keeps the id is the app's rule (first in byte order).
    let pages = linux.pages();
    assert_eq!(pages.len(), 2, "{pages:?}");
    assert_eq!(pages[&id].path, "Set/Original copy.md");
    assert!(pages.values().any(|p| p.path == "Set/Original.md"));
}

#[tokio::test]
async fn a_round_cut_off_at_any_point_loses_nothing_and_settles() {
    let cuts = [
        Cut::Drop(Stage::Planned),
        Cut::Drop(Stage::AppliedHere),
        Cut::Drop(Stage::AppliedThere),
        Cut::Crash(Stage::Planned),
        Cut::Crash(Stage::AppliedHere),
        Cut::Crash(Stage::AppliedThere),
    ];
    for cut in cuts {
        let (mac, linux) = pair().await;
        let shared = mac.create("Set", "Shared", "one\ntwo\nthree");
        let renamed = mac.create("Set", "Renamed", "r");
        let trashed = mac.create("Set", "Trashed", "t");
        converge(&[&mac, &linux]).await;

        mac.edit(&shared, |b| format!("zero from the mac\n{b}"));
        linux.append(&shared, "four from linux");
        let from_mac = mac.create("Set", "From the mac", "m");
        let from_linux = linux.create("Set", "From linux", "l");
        mac.retitle(&renamed, "Renamed again");
        linux.trash(&trashed);

        mac.sync_cut(&linux, cut).await;
        converge(&[&mac, &linux]).await;

        for device in [&mac, &linux] {
            assert!(
                contains(device, &shared, "zero from the mac")
                    && contains(device, &shared, "four from linux"),
                "{cut:?}: {:?}",
                device.body(&shared)
            );
            assert!(device.page(&from_mac).is_some() && device.page(&from_linux).is_some());
            assert_eq!(device.page(&renamed).unwrap().path, "Set/Renamed-again.md");
            assert!(device.page(&trashed).is_none(), "{cut:?}");
            assert_eq!(
                device.trash_pages().len(),
                1,
                "{cut:?}: once, however often the round was tried"
            );
            assert!(
                device.conflict_copies().is_empty(),
                "{cut:?}: {:?}",
                device.paths()
            );
        }
    }
}

#[tokio::test]
async fn a_file_changed_by_something_else_mid_round_is_left_for_the_next() {
    let (mac, linux) = pair().await;
    let id = mac.create("Set", "A", "one\ntwo");
    converge(&[&mac, &linux]).await;
    linux.append(&id, "from linux");

    // Another app writes the Mac's copy after the plan was made from it.
    let path = mac.root().join("Set/A.md");
    mac.sync_with_hook(&linux, Stage::Planned, move || {
        let text = std::fs::read_to_string(&path).unwrap();
        std::fs::write(&path, text.replace("one", "one, from another app")).unwrap();
    })
    .await
    .unwrap();
    converge(&[&mac, &linux]).await;
    assert!(contains(&linux, &id, "one, from another app") && contains(&linux, &id, "from linux"));
}

#[tokio::test]
async fn both_devices_pressing_sync_now_at_once_both_finish() {
    let (mac, linux) = pair().await;
    for i in 0..5 {
        mac.create("Set", &format!("Mac {i}"), "m");
        linux.create("Set", &format!("Linux {i}"), "l");
    }
    let (a, b) = tokio::join!(mac.sync(&linux), linux.sync(&mac));
    a.expect("the mac's round");
    b.expect("linux's round");
    converge(&[&mac, &linux]).await;
    assert_eq!(mac.pages().len(), 10);
}

#[tokio::test]
async fn a_page_gone_altogether_while_open_comes_back_with_the_edit() {
    let (mac, linux) = pair().await;
    let id = mac.create("Set", "A", "draft");
    converge(&[&mac, &linux]).await;
    let mut editor = linux.open(&id);
    mac.trash(&id);
    converge(&[&mac, &linux]).await;
    linux.delete_forever(&id);

    assert_eq!(
        editor.save(&linux.folder(), |b| format!("{b}\nstill typing")),
        Saved::Recreated
    );
    converge(&[&mac, &linux]).await;
    assert!(contains(&mac, &id, "still typing"));
}

#[tokio::test]
async fn a_page_trashed_elsewhere_while_open_comes_back_out_with_the_edit() {
    let (mac, linux) = pair().await;
    let parent = mac.create("Set", "Parent", "above");
    let id = mac.create_child(&parent, "A", "draft");
    converge(&[&mac, &linux]).await;
    let mut editor = linux.open(&id);
    mac.trash(&id);
    converge(&[&mac, &linux]).await;
    assert!(linux.page(&id).is_none() && linux.trashed_page(&id).is_some());

    assert_eq!(
        editor.save(&linux.folder(), |b| format!("{b}\nstill typing")),
        Saved::Restored
    );
    converge(&[&mac, &linux]).await;
    for device in [&mac, &linux] {
        assert!(contains(device, &id, "still typing"));
        assert_eq!(
            device.pages().len(),
            2,
            "and only once: {:?}",
            device.paths()
        );
    }
}

#[tokio::test]
async fn a_peer_that_hangs_up_has_its_reason_reported() {
    let (mac, refuser) = pair().await;
    // A device that answers every connection by closing it, with a reason.
    refuser.stop_serving();
    let endpoint = refuser.endpoint.clone();
    let server = tokio::spawn(async move {
        while let Some(incoming) = endpoint.accept().await {
            if let Ok(connection) = incoming.await {
                connection.close(
                    0u32.into(),
                    b"not paired - pairing has to be done on both devices",
                );
            }
        }
    });
    let failure = mac
        .sync(&refuser)
        .await
        .expect_err("a peer that hangs up can't be synced with");
    server.abort();
    assert_eq!(failure.code, "transport");
    assert!(failure.message.contains("not paired"), "{failure}");
}

#[tokio::test]
async fn three_devices_settle_on_one_folder() {
    let notes = crate::page_id::random();
    let (a, b, c) = (
        Device::new("A", &notes).await,
        Device::new("B", &notes).await,
        Device::new("C", &notes).await,
    );
    let page = a.create("Set", "Shared", "one\ntwo\nthree");
    converge(&[&a, &b, &c]).await;
    a.edit(&page, |t| format!("zero\n{t}"));
    b.append(&page, "four");
    c.retitle(&page, "Renamed on C");
    b.sync(&c).await.unwrap();
    converge(&[&a, &b, &c]).await;
    for device in [&a, &b, &c] {
        assert_eq!(device.page(&page).unwrap().path, "Set/Renamed-on-C.md");
        assert!(contains(device, &page, "zero") && contains(device, &page, "four"));
    }
}

#[tokio::test]
async fn a_page_deleted_on_one_of_three_devices_stays_deleted_unless_edited_since() {
    let notes = crate::page_id::random();
    let (a, b, c) = (
        Device::new("A", &notes).await,
        Device::new("B", &notes).await,
        Device::new("C", &notes).await,
    );
    // Both reach C by way of B: A and C never agree on either.
    let doomed = a.create("Set", "Doomed", "bye");
    let edited = a.create("Set", "Edited", "v1");
    a.sync(&b).await.unwrap();
    b.sync(&c).await.unwrap();
    for page in [&doomed, &edited] {
        c.trash(page);
    }
    a.edit(&edited, |_| "v2, which C never saw".to_string());

    // A's copy of `doomed` is one C held and let go of, not a page C lacks.
    a.sync(&c).await.unwrap();
    assert!(a.page(&doomed).is_none(), "the delete went across");
    assert!(a.trashed_page(&doomed).is_some(), "into A's own trash");
    assert!(
        contains(&c, &edited, "v2"),
        "an edit C never saw outlives it"
    );

    converge(&[&a, &b, &c]).await;
    for device in [&a, &b, &c] {
        assert!(device.page(&doomed).is_none());
        assert!(contains(device, &edited, "v2"));
    }
}
