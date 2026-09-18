//! Every edit writes a unique token; a token may vanish only if its page was emptied from a trash
//! or its line was replaced. A failure prints the seed to replay.

use std::collections::BTreeSet;

use super::harness::{converge, Cut, Device, Folder};
use crate::sync::round::Stage;

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    fn below(&mut self, n: usize) -> usize {
        (self.next() % n.max(1) as u64) as usize
    }

    fn pick<'a, T>(&mut self, items: &'a [T]) -> Option<&'a T> {
        (!items.is_empty()).then(|| &items[self.below(items.len())])
    }
}

struct World {
    rng: Rng,
    written: BTreeSet<String>,
    allowed_gone: BTreeSet<String>,
    next: u64,
    log: Vec<String>,
}

impl World {
    fn token(&mut self) -> String {
        self.next += 1;
        let token = format!("tok{:05}x", self.next);
        self.written.insert(token.clone());
        token
    }

    fn note(&mut self, line: impl Into<String>) {
        let line = line.into();
        if std::env::var_os("SET_SYNC_FUZZ_VERBOSE").is_some() {
            // As it happens, so a run that dies part way still shows how far.
            println!("{line}");
        }
        self.log.push(line);
    }
}

fn tokens_in(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|w| {
            w.len() > 4
                && w.starts_with("tok")
                && w.ends_with('x')
                && w[3..w.len() - 1].bytes().all(|b| b.is_ascii_digit())
        })
        .map(str::to_string)
        .collect()
}

fn live(folder: &Folder) -> Vec<String> {
    folder.pages().into_keys().collect()
}

/// Pages sitting directly in a trash, which is all the app offers to restore or
/// empty.
fn trashed(folder: &Folder) -> Vec<String> {
    folder
        .trash_pages()
        .into_iter()
        .filter(|p| super::harness::directly_in_a_bin(&p.path))
        .map(|p| p.id)
        .collect()
}

const TITLES: [&str; 6] = ["Untitled", "Notes", "notes", "Plan", "Ideas", "Café"];

async fn run(seed: u64, count: usize, steps: usize) {
    super::harness::reseed(seed);
    let notes = format!("fuzz-{seed}");
    let mut devices = Vec::new();
    for i in 0..count {
        devices.push(Device::new(&format!("D{i}"), &notes).await);
    }
    let mut w = World {
        rng: Rng(seed),
        written: BTreeSet::new(),
        allowed_gone: BTreeSet::new(),
        next: seed * 100_000,
        log: Vec::new(),
    };

    let verbose = std::env::var("SET_SYNC_FUZZ_VERBOSE").is_ok();
    for step in 0..steps {
        if verbose && step > 0 {
            for device in &devices {
                let mut lines = Vec::new();
                for page in device.pages().into_values() {
                    lines.push(format!(
                        "      {} {} {:?}",
                        page.id,
                        page.path,
                        tokens_in(&page.text)
                    ));
                }
                w.note(format!("    [{}]\n{}", device.name, lines.join("\n")));
            }
        }
        let d = w.rng.below(count);
        let e = (d + 1 + w.rng.below(count - 1)) % count;
        let dev = &devices[d];
        let roll = w.rng.below(100);
        match roll {
            0..=11 => {
                let context = if w.rng.below(5) == 0 { "Work" } else { "Set" };
                let title = TITLES[w.rng.below(TITLES.len())];
                let token = w.token();
                let id = dev.create(context, title, &token);
                w.note(format!(
                    "{step}: {} creates {id} \"{title}\" in {context}",
                    dev.name
                ));
            }
            12..=18 => {
                if let Some(parent) = w.rng.pick(&live(dev)).cloned() {
                    let title = TITLES[w.rng.below(TITLES.len())];
                    let token = w.token();
                    let id = dev.create_child(&parent, title, &token);
                    w.note(format!("{step}: {} creates {id} under {parent}", dev.name));
                }
            }
            19..=38 => {
                if let Some(id) = w.rng.pick(&live(dev)).cloned() {
                    let token = w.token();
                    dev.append(&id, &token);
                    w.note(format!("{step}: {} appends {token} to {id}", dev.name));
                }
            }
            39..=45 => {
                let pages: Vec<String> = dev.pages().into_keys().collect();
                if let Some(id) = w.rng.pick(&pages).cloned() {
                    let body = dev.body(&id).unwrap_or_default();
                    let lines: Vec<&str> =
                        body.lines().filter(|l| !tokens_in(l).is_empty()).collect();
                    if let Some(line) = w.rng.pick(&lines).map(|l| l.to_string()) {
                        let replacement = w.token();
                        w.allowed_gone.extend(tokens_in(&line));
                        dev.edit(&id, |b| b.replacen(&line, &replacement, 1));
                        w.note(format!("{step}: {} replaces {line:?} in {id}", dev.name));
                    }
                }
            }
            46..=51 => {
                if let Some(id) = w.rng.pick(&live(dev)).cloned() {
                    let title = TITLES[w.rng.below(TITLES.len())];
                    dev.retitle(&id, title);
                    w.note(format!("{step}: {} retitles {id} \"{title}\"", dev.name));
                }
            }
            52..=56 => {
                let pages = live(dev);
                if let Some(id) = w.rng.pick(&pages).cloned() {
                    let parent = if w.rng.below(3) == 0 {
                        None
                    } else {
                        w.rng.pick(&pages).cloned().filter(|p| *p != id)
                    };
                    dev.move_under(&id, parent.as_deref());
                    w.note(format!("{step}: {} moves {id} under {parent:?}", dev.name));
                }
            }
            57..=62 => {
                if let Some(id) = w.rng.pick(&live(dev)).cloned() {
                    dev.trash(&id);
                    w.note(format!("{step}: {} trashes {id}", dev.name));
                }
            }
            63..=65 => {
                if let Some(id) = w.rng.pick(&trashed(dev)).cloned() {
                    dev.restore(&id);
                    w.note(format!("{step}: {} restores {id}", dev.name));
                }
            }
            66..=68 => {
                if let Some(id) = w.rng.pick(&trashed(dev)).cloned() {
                    for text in dev.delete_forever(&id) {
                        w.allowed_gone.extend(tokens_in(&text));
                    }
                    w.note(format!("{step}: {} empties {id} from the trash", dev.name));
                }
            }
            69..=70 => {
                if let Some(id) = w.rng.pick(&live(dev)).cloned() {
                    let name = format!("{}.png", super::harness::next_id());
                    dev.add_image(&id, &name, name.as_bytes());
                    w.note(format!("{step}: {} adds an image to {id}", dev.name));
                }
            }
            71 => {
                // A copy made in Finder, frontmatter and all.
                if let Some(page) = w
                    .rng
                    .pick(&dev.pages().into_values().collect::<Vec<_>>())
                    .cloned()
                {
                    let copy = format!("{} copy.md", crate::paths::strip_md(&page.path));
                    if !dev.root().join(&copy).exists() {
                        std::fs::write(dev.root().join(&copy), &page.text).unwrap();
                        w.note(format!(
                            "{step}: {} copies {} in Finder",
                            dev.name, page.path
                        ));
                    }
                }
            }
            72..=79 => {
                // Someone typing on a page while a round runs.
                let typist = if w.rng.below(2) == 0 { d } else { e };
                let folder = devices[typist].folder();
                if let Some(id) = w.rng.pick(&live(&folder)).cloned() {
                    let mut editor = folder.open(&id);
                    let other = &devices[if typist == d { e } else { d }];
                    if other.page(&id).is_some() && w.rng.below(2) == 0 {
                        let token = w.token();
                        other.append(&id, &token);
                        w.note(format!("{step}: {} appends {token} to {id}", other.name));
                    }
                    let token = w.token();
                    let stage =
                        [Stage::Planned, Stage::AppliedHere, Stage::AppliedThere][w.rng.below(3)];
                    w.note(format!(
                        "{step}: {} types {token} into {id} while {} syncs with {} ({stage:?})",
                        devices[typist].name, dev.name, devices[e].name
                    ));
                    let result = dev
                        .sync_with_hook(&devices[e], stage, move || {
                            editor.save(&folder, |b| format!("{}\n{token}", b.trim_end()));
                        })
                        .await;
                    match result {
                        Ok(report) => w.note(format!("    -> {report:?}")),
                        Err(failure) => {
                            panic!("seed {seed} step {step}: {failure}\n{}", w.log.join("\n"))
                        }
                    }
                }
            }
            80..=83 => {
                let cut = [
                    Cut::Drop(Stage::Planned),
                    Cut::Drop(Stage::AppliedHere),
                    Cut::Drop(Stage::AppliedThere),
                    Cut::Crash(Stage::Planned),
                    Cut::Crash(Stage::AppliedHere),
                    Cut::Crash(Stage::AppliedThere),
                ][w.rng.below(6)];
                w.note(format!(
                    "{step}: {} with {} is cut: {cut:?}",
                    dev.name, devices[e].name
                ));
                dev.sync_cut(&devices[e], cut).await;
            }
            _ => match dev.sync(&devices[e]).await {
                Ok(report) => w.note(format!(
                    "{step}: {} syncs with {}: {report:?}",
                    dev.name, devices[e].name
                )),
                Err(failure) => {
                    panic!("seed {seed} step {step}: {failure}\n{}", w.log.join("\n"))
                }
            },
        }
    }

    let refs: Vec<&Device> = devices.iter().collect();
    let settled = std::panic::AssertUnwindSafe(converge(&refs));
    if let Err(panic) = futures_catch(settled).await {
        eprintln!(
            "seed {seed} failed to settle. What happened:\n{}",
            w.log.join("\n")
        );
        std::panic::resume_unwind(panic);
    }

    // A trash counts: what one device let go of, others trashed rather than destroyed.
    let text: String = devices.iter().map(|d| d.all_text()).collect();
    let missing: Vec<&String> = w
        .written
        .iter()
        .filter(|t| !w.allowed_gone.contains(*t) && !text.contains(t.as_str()))
        .collect();
    assert!(
        missing.is_empty(),
        "seed {seed}: lost {missing:?}\nfolder: {:?}\nwhat happened:\n{}",
        devices[0].paths(),
        w.log.join("\n")
    );
    for device in devices {
        device.close().await;
    }
}

async fn futures_catch<F: std::future::Future<Output = ()>>(
    future: std::panic::AssertUnwindSafe<F>,
) -> Result<(), Box<dyn std::any::Any + Send>> {
    use std::pin::Pin;
    use std::task::{Context, Poll};

    struct Catch<F>(Pin<Box<F>>);
    impl<F: std::future::Future<Output = ()>> std::future::Future for Catch<F> {
        type Output = Result<(), Box<dyn std::any::Any + Send>>;
        fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
            let inner = self.0.as_mut();
            match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| inner.poll(cx))) {
                Ok(Poll::Pending) => Poll::Pending,
                Ok(Poll::Ready(())) => Poll::Ready(Ok(())),
                Err(panic) => Poll::Ready(Err(panic)),
            }
        }
    }
    Catch(Box::pin(future.0)).await
}

fn seeds(var: &str, default: u64) -> u64 {
    std::env::var(var)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

/// The seeds to run: `SET_SYNC_FUZZ_ONLY` replays one exactly.
fn seed_range(start: u64, default: u64) -> Vec<u64> {
    if let Some(only) = std::env::var("SET_SYNC_FUZZ_ONLY")
        .ok()
        .and_then(|v| v.parse().ok())
    {
        return vec![only];
    }
    (start..start + seeds("SET_SYNC_FUZZ_SEEDS", default)).collect()
}

#[tokio::test]
async fn two_devices_never_lose_an_edit() {
    for seed in seed_range(0, 12).into_iter().filter(|s| *s < 1_000) {
        run(seed, 2, seeds("SET_SYNC_FUZZ_STEPS", 60) as usize).await;
    }
}

#[tokio::test]
async fn three_devices_never_lose_an_edit() {
    for seed in seed_range(1_000, 6)
        .into_iter()
        .filter(|s| (1_000..10_000).contains(s))
    {
        run(seed, 3, seeds("SET_SYNC_FUZZ_STEPS", 50) as usize).await;
    }
}

/// By hand: `SET_SYNC_FUZZ_SEEDS=500 cargo test --release --no-default-features --lib
/// sync::e2e::fuzz::soak -- --ignored`
#[tokio::test]
#[ignore]
async fn soak() {
    for seed in seed_range(seeds("SET_SYNC_FUZZ_START", 10_000), 200) {
        // Shown only for the run that fails, which is the one to replay.
        println!("seed {seed}");
        run(
            seed,
            2 + (seed % 2) as usize,
            seeds("SET_SYNC_FUZZ_STEPS", 120) as usize,
        )
        .await;
    }
}
