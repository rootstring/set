# Device sync

Set syncs the notes folder directly between your devices, with no server or account.
[iroh](https://www.iroh.computer/) provides encrypted, authenticated QUIC and NAT traversal.
Everything else is in `src-tauri/src/sync/`.

The one rule everything below serves: **sync never loses anything anyone wrote, and never makes two
of anything that was one.** When it can't tell which of two versions is wanted, it keeps both. When
the other device let a page go, it goes to this device's Trash rather than being deleted. When it
can't read something, it leaves it alone on both devices.

## Modules

| Module        | Job                                                                   |
| ------------- | --------------------------------------------------------------------- |
| `manifest.rs` | what a folder holds, what couldn't be read, and what counts as content |
| `plan.rs`     | what a round does, for both devices at once (pure)                    |
| `merge.rs`    | three-way merge of a note                                             |
| `preview.rs`  | a plan as someone can read it before it runs, and a note's line diff  |
| `apply.rs`    | carrying out one device's half of a plan, safely                      |
| `round.rs`    | one round, from both ends: the coordinator and the device answering   |
| `ids.rs`      | repairing two notes that carry one page id, the way the app does      |
| `session.rs`  | the transport: streams, message limits, silence                       |
| `protocol.rs` | wire messages                                                         |
| `pairing.rs`  | pairing codes and claims                                              |
| `state.rs`    | identity, paired devices, baselines, lineage, ancestors, spool        |
| `mod.rs`      | endpoint, peer tasks, Tauri commands                                  |
| `e2e/`        | real devices over loopback: scenarios, and seeded random work (fuzz)  |

`plan.rs` has no disk or network access (three manifests and two lineages in, operations out), so
its rules are tested as cases, and `e2e/` tests them again as whole rounds between real devices.

## When it runs

Only when you press **Sync now**. Nothing syncs on save, on connect or on a timer, and no connection
stays open. With sync on, the endpoint listens for the other device but never starts a round itself.

Before a round starts, the app saves whatever is still waiting to be autosaved, so the round carries
what is on screen. For each paired device, one at a time:

1. **Connect**, with a 20s timeout ("couldn't reach it"). A pending pairing claim is redeemed first.
2. **Run one round** (below), with this device coordinating.
3. **Hang up.**

## A round

The device where Sync now was pressed **coordinates**. The other only answers. Only one device
decides anything, so the two can never reach different conclusions about the same pair of folders,
which is what used to leave devices disagreeing for ever and making a conflict copy each time.

1. **Hello and Begin.** Both check the protocol version (an exact match) and the notes id, then take
   both devices' round locks, this device's first. A device already in a round answers `Busy`, and
   the coordinator lets go of its own lock while it waits and retries, so two devices that pressed
   Sync now together both finish.
2. **Prepare.** Each device puts down anything a crashed round left staged (see the journal) and
   repairs duplicated page ids (`ids.rs`, the same rule and the same derived ids as the app's
   `adoptScan`), so the folder it lists is one the plan can trust.
3. **List.** Both manifests, and the baseline both devices hold (see Baselines). A notes folder that
   isn't there fails the round here (`notes_folder`): an unplugged drive is not every note deleted.
4. **Lineage.** Each device stamps every page it holds, or held and deleted (see Lineage).
5. **Plan.** `plan::draft` matches and classifies, and says which bytes it needs; the coordinator
   fetches them into its spool; `plan::finish` merges, places, names and turns it all into operations
   for each side.
6. **Preview.** A plan with anything in it is shown to whoever pressed Sync now, and the round waits
   for the answer (see The preview). A no, or no answer, ends the round with nothing applied
   (`Round::Declined`).
7. **Apply here, then there.** Each device carries out its half (`apply.rs`).
8. **Agree.** What both now hold alike becomes the next baseline, stored by the other device first and
   then by this one, along with every page's lineage.

A round cut off anywhere loses nothing, and the next one settles what it didn't. Every stage is tested
cut short, both by a dropped connection and by the coordinator dying (`e2e/scenarios.rs`).

## What syncs

Files, relative to the notes root. Dotfiles, hidden folders, `.set-tmp` files and every `Set-Trash/`
are skipped. Notes are special in three ways:

- **Identity:** a page is matched across devices by its frontmatter `id`, not its path. Retitling
  renames its file and moving it renames its folder; matched on id, each of those is one page that
  moved rather than one deleted and another created, however many other pages have since taken its
  old name. Everything without an id of its own (an image,
  loose Markdown) is matched by where it sits _relative to the page whose folder it is in_, so a
  page's children and images follow it when it moves instead of being deleted and fetched again.
- **Clock:** frontmatter `updatedAt`, not mtime. Copying a file resets its mtime.
- **Content:** every decision compares a hash taken over the note _without_ `updatedAt`, with
  frontmatter fields sorted and CRLF folded to LF. Saving a page rewrites `updatedAt` whether or not
  the page changed, so comparing whole bytes made a note merely opened on both devices look edited
  on both. Every other line inside the fence counts, including ones Set never writes.

Other files are compared by Blake3 hash of the whole file and are never merged.

## The preview

A round can't be taken back as a whole: what it trashes can be restored a page at a time, and what it
overwrites or merges can't. So the plan is put on screen before any of it happens, and the round goes
on only when told to.

`preview::of` turns the finished plan into what Settings → Sync draws: every file the round touches,
with what happens to it on this device and on the other (new, updated, moved, to the Trash), the
merges, conflicts and files sitting the round out, and everything that stays as it is, so the whole
reads as the notes folder both devices will have. It is made from the plan's operations and nothing
else, so it can't say one thing while `apply` does another. Pages go by their titles rather than
their file names: the round reads each from whichever copy is at hand (this device's file, the spool,
the stored ancestor for a page only the other device still holds), and a page with none to read keeps
its file name. Clicking a note that is being rewritten
shows a line diff of it (`preview::diff`, `sync_preview_diff`), with `updatedAt` left out. Both
versions are already at hand: this device's file, what the round fetched into its spool, and for a
note the other device holds unedited, the stored ancestor.

The round **waits with the plan made** rather than planning twice, so what is confirmed is exactly
what is applied, and nothing is fetched a second time. Both devices' round locks are held meanwhile,
which only keeps other rounds out (the editor doesn't take them), and an edit made while the preview
is up is caught the way any mid-round edit is: every operation names the bytes it expects to replace.
The wait ends by itself after ten minutes, when the other device hangs up, or when the preview has
nowhere to be shown (Settings closed, the window reloaded). A round with nothing to do asks nothing.
Only the coordinator is asked; the other device answers as it always has.

## Deletes

**The Trash is each device's own, and sync never deletes a page.** A manifest doesn't list any
`Set-Trash/`, so a page trashed on one device is simply gone from it. The other device then moves its
own copy into its own Trash (`Op::Trash`), laid out the way the app would have trashed it: the topmost
page going sits at the top of its context's `Set-Trash/`, with everything it owns under its folder, so
restoring it brings the subtree back whole. `apply` steps around names the Trash already holds. A
context removed elsewhere, once nothing but its Trash is left here, goes to the root `Set-Trash/` as a
deleted context, as it does when someone deletes one in the app.

So emptying the Trash is a local act and the only thing that destroys a page, and whatever goes wrong
upstream of a delete (a bug, the wrong folder, a bad restore) leaves pages in a Trash rather than
nowhere. Unless it was edited since: an edit always outlives a delete, and the page comes back.
Restoring on one device brings the page back on the others. Their own trashed copies stay where they
are until those Trashes are emptied, and restoring one of those as well makes a second page, with an
id of its own.

**A mass delete is asked about pointedly.** Restoring puts a page back at the top of its context, one
page at a time, so a folder that turned up empty by mistake is far cheaper to stop than to undo. A
plan that would trash more than ten pages and more than a quarter of the pages a device holds
(`Plan::mass_trash`) says so at the top of the preview, how many pages and on which device, and the
button that goes ahead turns into a red **Sync anyway** with Cancel holding the focus.

**What can't be read is left alone.** A file that is there and can't be read (permissions, a cloud
placeholder that won't download, a failing disk) looks exactly like one that was deleted.
`manifest::scan` names these, and a page's folder with it, and any file a device last held somewhere
it couldn't read this round sits the round out on both devices (`Skip::Unreadable`, logged as
`sync.unreadable`).

**Another folder is other notes.** Choosing a different notes folder without moving the notes into it
(`sync_forget_notes`) forgets every baseline and the lineage, which were about the old notes, and
gives the folder a new notes id. Paired devices refuse it as a different notes folder until they are
paired again, rather than merging two sets of notes or reading one as the other with everything
deleted.

## Sizes

**Sizes travel in the manifest.** One fetch is one message, capped at `MAX_MESSAGE` (64 MB); batches
fill to `FETCH_BATCH_BYTES` (8 MB) or 32 files. A file over `MAX_FILE` (63 MB) can't cross, so it is
left where it is on both devices rather than failing the round. It is logged as `sync.too_big` and
listed under the device in Settings → Sync for as long as it keeps being skipped.

## Where things end up

A file's final path is worked out from its owner's final path, top down, so a subtree moved on one
device moves as a whole on the other. Names are allocated as they are placed, and compared the way a
case-insensitive, normalization-insensitive filesystem compares them: two pages that would be one file
on a Mac get `Notes.md` and `Notes 2.md` on every device, including one whose filesystem could hold
both. A folder whose name differs from its page's only in case is still that page's folder, and
`apply` renames folders to the case the plan gave them. Moving a renamed page's files one at a time
into a folder that differs only in case otherwise lands them in the old folder, which keeps its old
name, and the page and its children drift apart.

A page edited on one device while the other moved it or trashed it is kept, with the edit, and so are
the pages above it.

## Baselines

For each peer, a device stores what the two last agreed they both hold, so every decision is
three-way. Without it, "the peer deleted this" and "I just created this" look the same.

| This device vs baseline | Peer vs baseline | Result                            |
| ----------------------- | ---------------- | --------------------------------- |
| unchanged               | changed          | take the peer's                   |
| changed                 | unchanged        | keep this one (the peer takes it) |
| unchanged               | deleted          | delete here                       |
| changed                 | deleted          | **the edit wins**                 |
| changed                 | changed          | merge, or **conflict**, keep both |

"Changed" means the content hash moved, or the page moved. Lineage decides first, where it can (see
below); the table decides between versions made independently of each other.

Both devices of a pair store the **same** baseline: the coordinator works out what was agreed and
sends it to the other device, which stores it before the coordinator does. Each is a generation with
an id, and two are kept, so a round cut off between the two stores still leaves one both hold; a round
plans against the newest they share. Only what went through on both devices is recorded; anything
short of that keeps what the old baseline said about it, which is always a true ancestor of what each
now holds.

Baselines live in `sync-baselines/<peer>.postcard` in the OS config dir, behind a header naming the
layout (`BASELINE_HEADER`). Deleting a baseline loses nothing but forces a full reconcile, where
notes both devices changed become conflict copies instead of merges.

## Lineage

A pair's baseline only knows what _those two_ devices last agreed on, and with three devices that
isn't enough. A device can hold a version its peer already replaced (it arrived by way of the third
device), which the pair's baseline reads as an edit. A page one device deleted reads as created to a
pair whose baseline never had it. A page moved on one device and moved back on another reads as moved
by whichever the pair's baseline didn't see. Each pair then undoes what another did, and the devices
pass the difference around for ever.

So every copy of a page carries two **version vectors** (`plan::Clock`): one for what it says and one
for where it is, each counting, per device, the versions that device made. A device stamps its copies
at the start of every round (`state::Lineage::observe`): a version it hasn't stamped before is one it
made, whether an edit, a move or a delete, and is kept as seen straight away, so no two versions are
ever stamped alike.

- A version whose clock covers the other's has seen it, and is the newer, whatever any baseline says.
- A page one device holds and the other deleted having seen that very copy is deleted.
- Only versions made independently of each other fall to the baseline table.
- Whatever a round settles on covers both sides' clocks, and a version the round made itself (a merge,
  a name neither had) is one more of the coordinator's. The version it replaced loses to it on every
  other device too, so nothing can go round. The coordinator keeps its lineage before telling the
  other device, so a stamp it made can't be made again for something else.

Lineage lives in `sync-lineage.postcard`. Counts only mean anything while the device that hands them
out remembers which it has used, so two things guard that:

- **Epoch.** Each lineage file is made with a random epoch, and a device's versions are stamped as made
  by `<device id>.<epoch>`. A file that is lost starts again at one, under a new name: to every other
  device its versions are a stranger's, neither newer nor older than the ones they hold, and the
  baseline table decides, which at worst means a conflict copy. Under the old name, `{me: 1}` today
  would lose to anything that had seen `{me: 1}` last year, and an edit would be thrown away as old.
- **Marks.** A file put back to an earlier state (a restored backup) keeps its epoch and hands out
  counts it has used before. Each device remembers where its peer's lineage stood when they last agreed
  (`state::Mark`: epoch and a count of writes) and says so at `Begin`. A device that finds itself
  behind what a peer remembers starts a new epoch. And for a pair that has no such memory, the planner
  won't compare stamps for a page where one device knows fewer of its own versions than the other has
  seen (`Lineages::consistent`).

## Merging and conflicts

When both sides changed a note independently, `merge.rs` tries a three-way merge against the version
in the baseline:

- **Body:** line-based diff3. Edits in different places both survive.
- **Frontmatter:** merged per field, since every save changes `updatedAt`.

There is no merging two versions without the one they started from: on their own they can't say
whether a line one lacks was deleted there or added on the other side, and any stand-in quietly
undoes deletions. So **a conflict** happens when both rewrote the same lines, the file isn't a note or
is over `MAX_MERGE` (4 MB), or there is no agreed version at all (the first sync of a page both
devices already had). The newer version (by `updatedAt`, then content hash) keeps the page's name.
The other is saved beside it as `<name> (conflict from <device>).md`, retitled to say so, with a page
id derived from the original's so the two never share one, and so a copy made in a round that was cut
short is recognised rather than made twice.

**Ancestors.** Baselines store only hashes, so the versions merges need are kept in `sync-ancestors/`,
named by content hash, and swept once no baseline refers to them. A miss is asked of the other device,
and failing that costs a conflict copy instead of a merge, never an edit.

## Applying a plan safely

`apply.rs` runs against a folder people are using:

- **Look before leaping.** Every operation that replaces, moves or removes a file names the exact
  bytes it was planned from, and is refused if the file holds anything else. The whole run holds the
  write gate the app's own saves take (`write::gate`), so a save can't slip in between the look and
  the leap. A refused group sits the round out, exactly where it is on both devices.
- **Groups stand or fall together.** A page's move, its conflict copy and its rewrite are one group.
- **Nothing is removed before its replacement is in place.** Files moving or going away are first
  renamed to hidden names beside themselves, recorded in `sync-journal/`, and put down only once the
  writes succeed. A swap of two names needs no ordering to get right.
- **Nothing the other device let go of is destroyed.** It is put down in the Trash. The only file a
  run removes outright is one whose newer version the same group has just written elsewhere.
- **What is written is on disk before it counts.** Notes, baselines, lineage and the journal are
  flushed before the rename that makes them the file (`write_atomically`), so a power cut can't leave
  an empty note for the next round to read as an edit. The spool and the ancestor store skip the wait:
  every read of them is checked against a hash.
- **A crash leaves nothing hidden.** The journal says where each staged file came from and where it
  was going, and the next round puts every one down before it starts.
- **Bytes from the peer are spooled** to `sync-spool/` and checked against the hash they were listed
  with, never held whole in memory.

## The editor

A sync that changes the page you're typing in must neither be written over by your next autosave nor
throw away what you typed. So every save says which version of the file it was edited from
(`write_page`'s `expected`: the SHA-256 of the text the editor loaded, or `absent` for a new page), and
the write is refused if the file on disk is anything else. Sync's apply takes the same gate.

A refused save (`ChangedOnDiskError`) is folded in (`workspace.foldChangeOnDisk`):

- **The file changed:** your edits are merged into it with the same merge sync uses (`merge_note`),
  the editor shows the result, and that is saved. Only when you both rewrote the same lines are you
  asked: keep yours, take theirs, or keep both.
- **The page moved** (a sync retitled it): it is found by id and saved where it is now.
- **The page was trashed elsewhere** while you were typing in it (so it is in this device's Trash
  now): it is brought back, with your changes. **Gone altogether:** it is written back under its own
  id. Either way a toast says so.
- A save of a page that is gone never makes a new blank page in its place, which is what an earlier
  build did.

Applied changes emit `sync:changed`, which calls `workspace.reloadFromDisk()`. Edits made outside Set
come in through the folder watch (`src-tauri/src/watch.rs`) as `notes:changed`, and take the same
path.

## Pairing and trust

- **Code:** an iroh `EndpointTicket` (endpoint id and addressing) followed by a 128-bit secret.
  Pasting it on the other device makes that device dial this one and send a `Claim` with the
  secret. Either device can show the code.
- **Approval:** a valid claim still has to be allowed. The device showing the code asks **"Pair with
  &lt;name&gt;?"** and waits up to `APPROVAL_TIMEOUT`. The name comes from the claimer and isn't
  verified; only allow it if you just pasted the code.
- **One code, one device:** allowing or declining rotates `pairing_secret`; an unanswered prompt
  doesn't. Prompts are handled one at a time and recheck the secret, so a second device with the
  same code is refused as "used or replaced". If a freshly pasted code is refused, the claiming
  device removes the pairing.
- **Allowlist:** iroh authenticates the peer's key before any data is read, so a paired id is
  allowed and anything else isn't. An unpaired peer can only send a `Claim` (capped at
  `MAX_CLAIM`).
- **Notes id:** a uuid created on first run and checked during the handshake. Devices with different
  notes folders refuse each other.
- **Path validation:** every incoming path is resolved component by component and refused unless
  it's inside the notes root.
- **Key storage:** the private key is in `sync.json` in the OS config dir (`0600`), outside the
  synced folder. A malformed `sync.json` is reported, not regenerated, because regenerating would
  change the device's identity.

## Transport

- Incoming streams are each served on their own task (`session::serve_streams`). At most `IN_FLIGHT`
  (4) of one peer's requests are read or answered at once, since each can hold a whole message in
  memory.
- A reply may go silent for at most `SILENCE` (five minutes) before the peer counts as gone. The limit
  is on silence, not on the whole reply, so a slow transfer that keeps moving is never cut off. The
  requests that do real work on the other device (`Begin`, `Apply`, `Commit`) have no limit of their
  own; the connection closes if the device goes away.

## Tests

Unit tests sit beside each module: what counts as content (`manifest.rs`), the planning rules as
cases (`plan.rs`), the merge (`merge.rs`), refusal, undo and crash recovery (`apply.rs`), baselines
and lineage (`state.rs`), the id repair (`ids.rs`) and its derived ids, which
`src/lib/utils/id.test.ts` checks the app derives identically (`src/page_id.rs`), and the transport
(`session.rs`).

`e2e/` runs whole rounds between real devices, each with its own notes folder, sync state and iroh
endpoint, over 127.0.0.1 with no relay and no DNS (`presets::Minimal`). What happens to the folders
in between is done the way the app does it (`e2e/harness.rs`), including the editor saving part way
through a round, at exactly the moment a test chooses.

- **`e2e/scenarios.rs`** names each rule: retitles, moves and trash across devices; typing while a
  round lands, at every stage, on either device; a stale editor; the same note under two ids; case
  collisions and case-only renames; Finder duplicates; rounds cut off at every stage; files changed
  by something else mid-round; both devices pressing Sync now at once; three devices; a page that
  can't be read; a notes folder that has gone; a mass delete flagged in the preview, and a preview turned down leaving both folders untouched; lineage lost,
  and lineage restored from a backup.
- **`e2e/fuzz.rs`** throws seeded random work at two and three devices (creating, editing, typing
  mid-round, retitling, moving, trashing, restoring, emptying the trash, images, Finder copies, cut
  rounds) and checks after every run that the devices settle on identical folders, that every token
  anyone typed is still on some device, live or in a Trash, unless someone emptied it out of one, that
  no page id is held twice, and that nothing is left under a hidden name. A failure names its seed,
  and replays exactly.

```bash
cd src-tauri
cargo test --no-default-features --lib sync::            # everything, including a short fuzz run
SET_SYNC_FUZZ_SEEDS=500 cargo test --release --no-default-features --lib sync::e2e::fuzz::soak -- --ignored
SET_SYNC_FUZZ_ONLY=10063 SET_SYNC_FUZZ_VERBOSE=1 cargo test --release --no-default-features \
  --lib sync::e2e::fuzz::soak -- --ignored --nocapture    # replay one seed, step by step
```

CI runs the sync suite on Linux on every push and pull request, as part of `cargo test`. Running
the Checks workflow by hand also runs it on macOS, Linux and Windows (where filesystems ignore
case), each with a soak of 300 seeds.
