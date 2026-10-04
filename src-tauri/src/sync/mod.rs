pub mod apply;
pub mod ids;
pub mod log;
pub mod manifest;
pub mod merge;
pub mod nearby;
pub mod pairing;
pub mod plan;
pub mod preview;
pub mod protocol;
pub mod round;
pub mod session;
pub mod state;

#[cfg(test)]
mod e2e;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use iroh::endpoint::Connection;
use iroh::protocol::{AcceptError, ProtocolHandler, Router};
use iroh::{Endpoint, EndpointAddr, EndpointId};
use iroh_mdns_address_lookup::MdnsAddressLookup;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use protocol::{Request, Response};
use state::Config;

/// How long "Sync now" waits to reach a device before reporting it offline.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);

const INTRODUCE_TIMEOUT: Duration = Duration::from_secs(5);

/// Both devices' round locks are held while a preview is up.
const REVIEW_TIMEOUT: Duration = Duration::from_secs(10 * 60);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub enabled: bool,
    pub running: bool,
    pub device_name: String,
    pub endpoint_id: String,

    pub notes_id: String,
    pub protocol_version: u32,

    pub pairing_code: Option<String>,
    pub peers: Vec<PeerStatus>,
    pub discoverable: bool,
    /// Milliseconds since the epoch.
    pub searching_until: Option<f64>,
    pub nearby: Vec<NearbyDevice>,

    pub last_error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerStatus {
    pub id: String,
    pub name: String,
    pub connected: bool,
    pub nearby: bool,

    pub syncing: bool,
    pub last_synced_at: Option<f64>,
    pub last_error: Option<String>,

    pub pairing_pending: bool,

    /// Files the last round with this device wanted and couldn't carry.
    pub too_big: Vec<TooBigFile>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NearbyDevice {
    pub id: String,
    pub name: String,
    pub compatible: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct TooBigFile {
    pub path: String,
    pub bytes: u64,
}

#[derive(Default)]
struct Live {
    connected: bool,
    syncing: bool,
    last_synced_at: Option<f64>,
    last_error: Option<String>,

    last_logged: Option<String>,

    /// Also keeps `sync.too_big` to one line per file.
    too_big: Vec<round::TooBig>,
}

/// A round waiting on its preview.
struct Reviewing {
    id: u32,
    answer: tokio::sync::oneshot::Sender<bool>,
    diff: round::Diff,
}

/// How a round with one device ended, when nothing went wrong.
enum Outcome {
    Synced,
    /// Turned down at the preview, so nothing changed on either device.
    Declined,
}

#[derive(Clone)]
pub struct Sync(Arc<Inner>);

struct Inner {
    app: AppHandle,
    config: Mutex<Config>,

    notes_root: Mutex<Option<PathBuf>>,
    peers: Mutex<HashMap<EndpointId, Live>>,
    nearby: Mutex<nearby::Nearby>,
    knocks: Mutex<pairing::Knocks>,
    last_error: Mutex<Option<String>>,

    running: tokio::sync::Mutex<Option<Running>>,

    /// Held for every round this device is part of, whichever end it is on.
    round_lock: Arc<tokio::sync::Mutex<()>>,

    throttle: Mutex<pairing::Throttle>,

    /// One "Allow this device?" prompt at a time.
    approving: tokio::sync::Mutex<()>,

    /// The prompt on screen, if any, and where its answer goes.
    approval: Mutex<Option<(u32, tokio::sync::oneshot::Sender<Reply>)>>,

    /// The preview on screen, if any. One at most: a round is what shows it,
    /// and `round_lock` lets one round run at a time.
    reviewing: Mutex<Option<Reviewing>>,
}

struct Running {
    endpoint: Endpoint,
    router: Router,
    /// `None` where the network allows no multicast.
    mdns: Option<Mdns>,
}

struct Mdns {
    lookup: nearby::Lookup,
    watch: tauri::async_runtime::JoinHandle<()>,
}

impl Sync {
    pub fn new(app: AppHandle) -> Self {
        let (config, error) = match state::load() {
            Ok(config) => (config, None),
            Err(e) => (
                Config {
                    enabled: false,
                    ..Config::default()
                },
                Some(e),
            ),
        };
        Sync(Arc::new(Inner {
            app,
            config: Mutex::new(config),
            notes_root: Mutex::new(None),
            peers: Mutex::new(HashMap::new()),
            nearby: Mutex::new(nearby::Nearby::default()),
            knocks: Mutex::new(pairing::Knocks::default()),
            last_error: Mutex::new(error),
            running: tokio::sync::Mutex::new(None),
            round_lock: Arc::new(tokio::sync::Mutex::new(())),
            throttle: Mutex::new(pairing::Throttle::default()),
            approving: tokio::sync::Mutex::new(()),
            approval: Mutex::new(None),
            reviewing: Mutex::new(None),
        }))
    }

    fn engine(&self) -> &Arc<Inner> {
        &self.0
    }
}

impl Inner {
    fn config(&self) -> Config {
        self.config.lock().expect("sync config poisoned").clone()
    }

    fn set_error(&self, error: Option<String>) {
        *self.last_error.lock().expect("sync error poisoned") = error;
    }

    fn status(&self, endpoint: Option<&Endpoint>) -> Status {
        let config = self.config();
        let code = self.pairing_code(endpoint);
        let live = self.peers.lock().expect("sync peers poisoned");
        let nearby = self.nearby.lock().expect("sync nearby poisoned");
        let now = now_ms();
        let searching = nearby.searching(now);
        Status {
            enabled: config.enabled,
            running: endpoint.is_some(),
            device_name: config.device_name.clone(),
            endpoint_id: config.endpoint_id().to_string(),
            notes_id: config.notes_id.clone(),
            protocol_version: protocol::VERSION,
            pairing_code: code,
            peers: config
                .paired
                .iter()
                .map(|d| {
                    let l = live.get(&d.id);
                    PeerStatus {
                        id: d.id.to_string(),
                        name: d.name.clone(),
                        connected: l.is_some_and(|l| l.connected),
                        nearby: nearby.contains(&d.id),
                        syncing: l.is_some_and(|l| l.syncing),
                        last_synced_at: l.and_then(|l| l.last_synced_at),
                        last_error: l.and_then(|l| l.last_error.clone()),
                        pairing_pending: d.claim.is_some(),
                        too_big: l
                            .map(|l| l.too_big.as_slice())
                            .unwrap_or_default()
                            .iter()
                            .map(|f| TooBigFile {
                                path: f.path.clone(),
                                bytes: f.size,
                            })
                            .collect(),
                    }
                })
                .collect(),
            discoverable: nearby.discoverable(now),
            searching_until: searching.map(|s| s.until),
            nearby: if searching.is_some() {
                let mut devices: Vec<NearbyDevice> = nearby
                    .introduced()
                    .filter(|(id, _)| !config.is_paired(id))
                    .map(|(id, intro)| NearbyDevice {
                        id: id.to_string(),
                        name: intro.name.clone(),
                        compatible: intro.version == protocol::VERSION,
                    })
                    .collect();
                devices.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.id.cmp(&b.id)));
                devices
            } else {
                Vec::new()
            },
            last_error: self.last_error.lock().expect("sync error poisoned").clone(),
        }
    }

    async fn broadcast(self: &Arc<Self>) {
        let running = self.running.lock().await;
        let status = self.status(running.as_ref().map(|r| &r.endpoint));
        drop(running);
        let _ = self.app.emit("sync:status", status);
    }

    fn pairing_code(&self, endpoint: Option<&Endpoint>) -> Option<String> {
        let endpoint = endpoint?;
        Some(
            pairing::PairingCode {
                addr: endpoint.addr(),
                secret: self.config().pairing_secret,
            }
            .to_string(),
        )
    }

    fn root(&self) -> Result<PathBuf, String> {
        self.notes_root
            .lock()
            .expect("notes root poisoned")
            .clone()
            .ok_or_else(|| "the notes folder hasn't been set yet".to_string())
    }

    fn device(&self) -> Result<round::Device, String> {
        let app = self.app.clone();
        Ok(round::Device {
            root: self.root()?,
            dirs: state::Dirs::app()?,
            identity: self.identity(),
            lock: self.round_lock.clone(),
            written: Arc::new(move |paths: &[PathBuf]| {
                if let Some(watch) = app.try_state::<crate::watch::Watch>() {
                    for path in paths {
                        watch.own_writes().record(path);
                    }
                }
            }),
            hook: None,
        })
    }

    fn peer_name(&self, peer: &EndpointId) -> String {
        self.config()
            .paired
            .iter()
            .find(|d| d.id == *peer)
            .map(|d| d.name.clone())
            .or_else(|| {
                let nearby = self.nearby.lock().expect("sync nearby poisoned");
                nearby.name(peer).map(str::to_string)
            })
            .unwrap_or_else(|| format!("device {}", &peer.to_string()[..8]))
    }
}

impl Inner {
    async fn start(self: &Arc<Self>) -> Result<(), String> {
        let mut running = self.running.lock().await;
        if running.is_some() {
            return Ok(());
        }
        let config = self.config();

        let mdns = nearby::Lookup::new(config.endpoint_id(), self.announcing());
        let mut builder = Endpoint::builder(iroh::endpoint::presets::N0)
            .secret_key(config.secret_key.clone())
            .alpns(vec![protocol::ALPN.to_vec()]);
        if let Some(mdns) = &mdns {
            builder = builder.address_lookup(mdns.clone());
        }
        let endpoint = match builder.bind().await {
            Ok(endpoint) => endpoint,
            Err(e) => {
                let msg = format!("starting sync: {e}");
                log::error("sync.start_failed").field("error", &msg).emit();
                return Err(msg);
            }
        };

        let router = Router::builder(endpoint.clone())
            .accept(protocol::ALPN, Handler(Arc::downgrade(self)))
            .spawn();

        let mdns = mdns.map(|lookup| Mdns {
            watch: self.watch(lookup.mdns()),
            lookup,
        });

        *running = Some(Running {
            endpoint,
            router,
            mdns,
        });
        drop(running);

        // A round cut off by a crash left files staged under hidden names.
        if let Ok(device) = self.device() {
            let _ = tauri::async_runtime::spawn_blocking(move || {
                apply::recover(&device.root, &device.dirs.journal);
                state::Spool::clear_all(&device.dirs.spool);
            })
            .await;
        }

        self.set_error(None);
        log::info("sync.started")
            .field("peers", config.paired.len())
            .field("protocol", protocol::VERSION)
            .field("notes", &config.notes_id)
            .emit();
        self.broadcast().await;
        Ok(())
    }

    async fn stop(self: &Arc<Self>) {
        let taken = self.running.lock().await.take();
        let was_running = taken.is_some();
        if let Some(running) = taken {
            if let Some(mdns) = running.mdns {
                mdns.watch.abort();
            }
            let _ = running.router.shutdown().await;
            running.endpoint.close().await;
        }
        self.peers.lock().expect("sync peers poisoned").clear();
        self.nearby.lock().expect("sync nearby poisoned").reset();
        *self.knocks.lock().expect("sync knocks poisoned") = pairing::Knocks::default();
        if was_running {
            log::info("sync.stopped").emit();
        }
        self.broadcast().await;
    }

    fn watch(self: &Arc<Self>, mdns: MdnsAddressLookup) -> tauri::async_runtime::JoinHandle<()> {
        let weak = Arc::downgrade(self);
        tauri::async_runtime::spawn(nearby::watch(mdns, move |event| {
            let Some(inner) = weak.upgrade() else { return };
            let config = inner.config();
            let shown = inner
                .nearby
                .lock()
                .expect("sync nearby poisoned")
                .apply(event, |id| config.is_paired(id));
            if shown {
                tauri::async_runtime::spawn(async move { inner.broadcast().await });
            }
        }))
    }

    /// Only when someone could want to find this device: anyone on the network sees the
    /// announcement, and its endpoint id never changes.
    fn announcing(&self) -> bool {
        let now = now_ms();
        let nearby = self.nearby.lock().expect("sync nearby poisoned");
        !self.config().paired.is_empty()
            || nearby.discoverable(now)
            || nearby.searching(now).is_some()
    }

    /// The endpoint stays up, so nothing in progress is cut off.
    async fn announce(self: &Arc<Self>) -> Result<(), String> {
        let mut running = self.running.lock().await;
        let running = running
            .as_mut()
            .ok_or_else(|| "turn on sync first".to_string())?;
        let Some(mdns) = running.mdns.as_mut() else {
            return Ok(());
        };
        if let Some(swapped) = mdns.lookup.advertise(self.announcing()) {
            mdns.watch.abort();
            // The old mDNS can no longer say who left, and the new one hears everyone again.
            self.nearby
                .lock()
                .expect("sync nearby poisoned")
                .forget_devices();
            mdns.watch = self.watch(swapped);
        }
        Ok(())
    }

    async fn restart(self: &Arc<Self>) -> Result<(), String> {
        self.stop().await;
        if self.config().enabled {
            self.start().await?;
        }
        Ok(())
    }

    async fn endpoint(&self) -> Result<Endpoint, String> {
        self.running
            .lock()
            .await
            .as_ref()
            .map(|r| r.endpoint.clone())
            .ok_or_else(|| "sync isn't running".to_string())
    }

    /// Each device's outcome goes on its own status row.
    async fn sync_all(self: &Arc<Self>) -> Result<(), String> {
        self.root()?;
        let endpoint = self.endpoint().await?;
        for device in self.config().paired {
            self.sync_peer(&endpoint, &device).await;
        }
        Ok(())
    }

    /// One manual round with one device, then hang up.
    async fn sync_peer(self: &Arc<Self>, endpoint: &Endpoint, device: &state::PairedDevice) {
        let peer = device.id;
        let Some(connection) = self.connect(endpoint, device).await else {
            return;
        };

        let serving = {
            let inner = self.clone();
            let connection = connection.clone();
            tauri::async_runtime::spawn(async move {
                inner.serve_streams(connection, peer).await;
            })
        };

        let result = self.coordinate(&connection, peer).await;

        connection.close(0u32.into(), b"done");
        serving.abort();
        self.mark(peer, |l| {
            l.connected = false;
            match result {
                Ok(Outcome::Synced) => {
                    l.last_error = None;
                    l.last_synced_at = Some(now_ms());
                }
                Ok(Outcome::Declined) => l.last_error = None,
                Err(e) => l.last_error = Some(e),
            }
        });
        self.broadcast().await;
    }

    async fn introduce(self: &Arc<Self>, endpoint: &Endpoint, peer: EndpointId) {
        if self.config().is_paired(&peer) {
            return;
        }
        let asked = tokio::time::timeout(INTRODUCE_TIMEOUT, async {
            let connection = endpoint
                .connect(EndpointAddr::new(peer), protocol::ALPN)
                .await
                .map_err(|e| e.to_string())?;
            let reply = session::request_small(&connection, &Request::Introduce).await;
            connection.close(0u32.into(), b"introduced");
            reply
        })
        .await;
        let heard = match asked {
            Ok(Ok(Response::Introduced {
                version,
                device_name,
            })) => Some(nearby::Introduction {
                name: pairing::device_name(&device_name, &peer),
                version,
            }),
            // Refused, or an older Set that doesn't know the question: not discoverable.
            Ok(Ok(_)) => None,
            _ => return,
        };
        let changed = self
            .nearby
            .lock()
            .expect("sync nearby poisoned")
            .heard(&peer, heard);
        if changed {
            self.broadcast().await;
        }
    }

    /// Asks every device each time round, so one made discoverable meanwhile turns up and one no
    /// longer discoverable drops off.
    async fn search(self: &Arc<Self>) -> Result<(), String> {
        let endpoint = self.endpoint().await?;
        let search = self
            .nearby
            .lock()
            .expect("sync nearby poisoned")
            .search(now_ms());
        self.announce().await?;
        log::info("nearby.searching").emit();
        self.broadcast().await;

        let inner = Arc::downgrade(self);
        tauri::async_runtime::spawn(async move {
            loop {
                let Some(inner) = inner.upgrade() else { return };
                let (still, devices) = {
                    let nearby = inner.nearby.lock().expect("sync nearby poisoned");
                    let still = nearby.searching(now_ms()).map(|s| s.id) == Some(search.id);
                    (still, nearby.devices())
                };
                if !still {
                    inner.stop_search(Some(search.id)).await;
                    return;
                }
                let mut asking = tokio::task::JoinSet::new();
                for peer in devices {
                    let inner = inner.clone();
                    let endpoint = endpoint.clone();
                    asking.spawn(async move { inner.introduce(&endpoint, peer).await });
                }
                drop(inner);
                asking.join_all().await;
                tokio::time::sleep(nearby::SEARCH_EVERY).await;
            }
        });
        Ok(())
    }

    async fn stop_search(self: &Arc<Self>, id: Option<u64>) {
        let stopped = self
            .nearby
            .lock()
            .expect("sync nearby poisoned")
            .stop_search(id);
        if stopped {
            let _ = self.announce().await;
            self.broadcast().await;
        }
    }

    async fn discover(self: &Arc<Self>) -> Result<(), String> {
        self.endpoint().await?;
        let window = self
            .nearby
            .lock()
            .expect("sync nearby poisoned")
            .discover(now_ms());
        self.announce().await?;
        log::info("nearby.discoverable").emit();
        self.broadcast().await;

        let inner = Arc::downgrade(self);
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(nearby::DISCOVERABLE_WINDOW).await;
            if let Some(inner) = inner.upgrade() {
                inner.hide(Some(window.id)).await;
            }
        });
        Ok(())
    }

    async fn close_nearby(self: &Arc<Self>) {
        self.hide(None).await;
        self.stop_search(None).await;
    }

    async fn hide(self: &Arc<Self>, id: Option<u64>) {
        let hidden = self.nearby.lock().expect("sync nearby poisoned").hide(id);
        if hidden {
            log::info("nearby.hidden").emit();
            let _ = self.announce().await;
            self.broadcast().await;
        }
    }

    /// Dials a paired device and redeems its pairing claim if one is pending.
    async fn connect(
        self: &Arc<Self>,
        endpoint: &Endpoint,
        device: &state::PairedDevice,
    ) -> Option<Connection> {
        let connection = self.dial(endpoint, device).await?;
        // A refusal is already on the device's row; the caller carries on.
        let _ = self.redeem(&connection, device.id).await;
        Some(connection)
    }

    async fn dial(
        self: &Arc<Self>,
        endpoint: &Endpoint,
        device: &state::PairedDevice,
    ) -> Option<Connection> {
        let peer = device.id;
        let addr = EndpointAddr::from_parts(peer, device.addrs.clone());
        let dialed =
            match tokio::time::timeout(CONNECT_TIMEOUT, endpoint.connect(addr, protocol::ALPN))
                .await
            {
                Ok(Ok(connection)) => Ok(connection),
                Ok(Err(e)) => Err(e.to_string()),
                Err(_) => Err("couldn't reach it. Is Set open on that device?".to_string()),
            };
        match dialed {
            Ok(connection) => {
                log::info("peer.connected")
                    .peer(peer, self.peer_name(&peer))
                    .emit();
                self.mark(peer, |l| {
                    l.connected = true;
                    l.last_error = None;
                });
                self.broadcast().await;
                Some(connection)
            }
            Err(e) => {
                log::warn("peer.unreachable")
                    .peer(peer, self.peer_name(&peer))
                    .field("error", &e)
                    .emit();
                self.mark(peer, |l| {
                    l.connected = false;
                    l.last_error = Some(e);
                });
                self.broadcast().await;
                None
            }
        }
    }

    /// A claim that could not be delivered is not a refusal and waits for next time.
    async fn redeem(
        self: &Arc<Self>,
        connection: &Connection,
        peer: EndpointId,
    ) -> Result<(), String> {
        let config = self.config();
        let Some(secret) = config
            .paired
            .iter()
            .find(|d| d.id == peer)
            .and_then(|d| d.claim.clone())
        else {
            return Ok(());
        };

        let settled = config.paired.iter().any(|d| d.id != peer);
        let claim = Request::Claim {
            version: protocol::VERSION,
            secret,
            device_name: config.device_name,
            notes_id: settled.then(|| config.notes_id.clone()),
        };
        let name = self.peer_name(&peer);
        let outcome = match session::request(connection, &claim).await {
            Ok(Response::Paired { notes_id }) => {
                let joined = self.join_notes(notes_id.clone());
                log::info("pair.confirmed")
                    .peer(peer, &name)
                    .field("notes", &notes_id)
                    .field("joined", joined)
                    .emit();
                None
            }
            Ok(other) => Some(refusal(other)),
            Err(_) => return Ok(()),
        };
        let Some((reason, error)) = outcome else {
            self.forget_claim(&peer);
            self.broadcast().await;
            return Ok(());
        };
        // Nobody saw the prompt, so the claim is retried next sync.
        if reason != pairing::Refused::NoAnswer.code() {
            self.forget_claim(&peer);
        }
        log::error("pair.rejected")
            .peer(peer, &name)
            .field("reason", reason)
            .field("error", &error)
            .emit();
        self.mark(peer, |l| l.last_error = Some(error.clone()));
        self.broadcast().await;
        Err(error)
    }

    fn join_notes(&self, notes_id: String) -> bool {
        let mut config = self.config.lock().expect("sync config poisoned");
        if config.notes_id == notes_id {
            return false;
        }
        config.notes_id = notes_id;
        let _ = state::save(&config);
        true
    }

    fn forget_claim(&self, peer: &EndpointId) {
        let mut config = self.config.lock().expect("sync config poisoned");
        let Some(device) = config.paired.iter_mut().find(|d| &d.id == peer) else {
            return;
        };
        if device.claim.is_none() {
            return;
        }
        device.claim = None;
        let _ = state::save(&config);
    }

    async fn coordinate(
        self: &Arc<Self>,
        connection: &Connection,
        peer: EndpointId,
    ) -> Result<Outcome, String> {
        let device = self.device()?;
        let peer_name = self.peer_name(&peer);

        self.mark(peer, |l| l.syncing = true);
        self.broadcast().await;

        let approve: round::Approve = {
            let (inner, connection, peer_name) =
                (self.clone(), connection.clone(), peer_name.clone());
            Arc::new(move |review| {
                let (inner, connection, peer_name) =
                    (inner.clone(), connection.clone(), peer_name.clone());
                Box::pin(async move { inner.review(&connection, peer, &peer_name, review).await })
            })
        };

        let started = std::time::Instant::now();
        let result = round::coordinate(&device, connection, peer, &peer_name, &approve).await;

        self.mark(peer, |l| l.syncing = false);

        let report = match result {
            Ok(round::Round::Done(report)) => report,
            Ok(round::Round::Declined) => {
                self.broadcast().await;
                return Ok(Outcome::Declined);
            }
            Err(failure) => {
                let novel = {
                    let mut peers = self.peers.lock().expect("sync peers poisoned");
                    let live = peers.entry(peer).or_default();
                    let novel = live.last_logged.as_deref() != Some(failure.message.as_str());
                    live.last_logged = Some(failure.message.clone());
                    novel
                };
                if novel {
                    log::error("sync.failed")
                        .peer(peer, &peer_name)
                        .field("reason", failure.code)
                        .field("error", &failure.message)
                        .field("elapsed_ms", started.elapsed().as_millis())
                        .emit();
                }
                self.broadcast().await;
                return Err(failure.message);
            }
        };

        // A file too big to carry may be the only thing this round had to do; say so.
        let newly_too_big: Vec<round::TooBig> = {
            let mut peers = self.peers.lock().expect("sync peers poisoned");
            let live = peers.entry(peer).or_default();
            live.last_logged = None;
            let fresh = report
                .too_big
                .iter()
                .filter(|file| !live.too_big.contains(file))
                .cloned()
                .collect();
            live.too_big = report.too_big.clone();
            fresh
        };
        for file in &newly_too_big {
            log::warn("sync.too_big")
                .peer(peer, &peer_name)
                .field("path", &file.path)
                .field("bytes", file.size)
                .field("limit", protocol::MAX_FILE)
                .emit();
        }
        for path in &report.deferred {
            log::info("sync.deferred")
                .peer(peer, &peer_name)
                .field("path", path)
                .emit();
        }
        for path in &report.unreadable {
            log::warn("sync.unreadable")
                .peer(peer, &peer_name)
                .field("path", path)
                .emit();
        }
        for why in &report.failed {
            log::error("sync.apply_failed")
                .peer(peer, &peer_name)
                .field("error", why)
                .emit();
        }

        if report.changed_here + report.changed_there > 0 {
            log::info("sync.completed")
                .peer(peer, &peer_name)
                .field("changed_here", report.changed_here)
                .field("changed_there", report.changed_there)
                .field("merged", report.merged.len())
                .field("conflicts", report.conflicts.len())
                .field("elapsed_ms", started.elapsed().as_millis())
                .emit();
            for path in &report.merged {
                log::info("sync.merged")
                    .peer(peer, &peer_name)
                    .field("path", path)
                    .emit();
            }
            for conflict in &report.conflicts {
                log::warn("sync.conflict")
                    .peer(peer, &peer_name)
                    .field("path", &conflict.path)
                    .field("kept_as", &conflict.kept_as)
                    .emit();
            }
        }
        if report.changed_here > 0 {
            self.changed(report.changed_here, &report.merged, &report.conflicts);
        }
        self.broadcast().await;
        Ok(Outcome::Synced)
    }

    /// Anything but a yes calls the round off.
    async fn review(
        &self,
        connection: &Connection,
        peer: EndpointId,
        peer_name: &str,
        review: round::Review,
    ) -> bool {
        let id: u32 = rand::random();
        let (answer, answered) = tokio::sync::oneshot::channel();
        *self.reviewing.lock().expect("sync review poisoned") = Some(Reviewing {
            id,
            answer,
            diff: review.diff,
        });
        let _ = self.app.emit(
            "sync:preview",
            serde_json::json!({
                "id": id,
                "peerId": peer.to_string(),
                "peerName": peer_name,
                "preview": review.preview,
            }),
        );

        let outcome = tokio::select! {
            answer = tokio::time::timeout(REVIEW_TIMEOUT, answered) => {
                answer.ok().and_then(Result::ok)
            }
            _ = connection.closed() => None,
        };

        let _ = self
            .reviewing
            .lock()
            .expect("sync review poisoned")
            .take_if(|pending| pending.id == id);
        let _ = self
            .app
            .emit("sync:preview-closed", serde_json::json!({ "id": id }));

        if outcome != Some(true) {
            let reason = if outcome.is_some() {
                "declined"
            } else {
                "no_answer"
            };
            log::info("sync.declined")
                .peer(peer, peer_name)
                .field("reason", reason)
                .emit();
        }
        outcome == Some(true)
    }

    fn changed(&self, changed: usize, merged: &[String], conflicts: &[round::Conflict]) {
        let _ = self.app.emit(
            "sync:changed",
            serde_json::json!({
                "changed": changed,
                "merged": merged,
                "conflicts": conflicts
                    .iter()
                    .map(|c| serde_json::json!({ "path": c.path, "keptAs": c.kept_as }))
                    .collect::<Vec<_>>(),
            }),
        );
    }

    fn identity(&self) -> session::Identity {
        let config = self.config();
        session::Identity {
            device_id: config.endpoint_id().to_string(),
            device_name: config.device_name,
            notes_id: config.notes_id,
        }
    }

    async fn serve_streams(self: &Arc<Self>, connection: Connection, peer: EndpointId) {
        let limit = {
            let inner = self.clone();
            move || {
                if inner.config().is_paired(&peer) {
                    protocol::MAX_MESSAGE
                } else {
                    protocol::MAX_CLAIM
                }
            }
        };

        // One session per connection: its lock and spool live as long as the connection.
        let session = match self.device() {
            Ok(device) => {
                let inner = Arc::downgrade(self);
                let peer_name = self.peer_name(&peer);
                Some(Arc::new(round::Session::new(
                    device,
                    peer,
                    Arc::new(move |answered: round::Answered| {
                        let Some(inner) = inner.upgrade() else { return };
                        if answered.changed == 0 {
                            return;
                        }
                        log::info("sync.answered")
                            .peer(peer, &peer_name)
                            .field("changed", answered.changed)
                            .field("merged", answered.merged.len())
                            .field("conflicts", answered.conflicts.len())
                            .emit();
                        inner.changed(answered.changed, &answered.merged, &answered.conflicts);
                    }),
                )))
            }
            Err(_) => None,
        };

        let inner = self.clone();
        let held = connection.clone();
        session::serve_streams(connection, limit, move |bytes| {
            let inner = inner.clone();
            let connection = held.clone();
            let session = session.clone();
            async move {
                let response = inner
                    .respond(&bytes, peer, &connection, session.as_deref())
                    .await;
                protocol::encode(&response)
                    .unwrap_or_else(|e| protocol::encode(&Response::Error(e)).unwrap_or_default())
            }
        })
        .await;
    }

    async fn respond(
        self: &Arc<Self>,
        bytes: &[u8],
        peer: EndpointId,
        connection: &Connection,
        session: Option<&round::Session>,
    ) -> Response {
        match protocol::decode::<Request>(bytes) {
            Ok(request) => self.answer(request, peer, connection, session).await,

            Err(e) => {
                if self.config().is_paired(&peer) {
                    Response::Error(e)
                } else {
                    log::warn("pair.refused")
                        .peer(peer, self.peer_name(&peer))
                        .field("reason", "unreadable_claim")
                        .field("error", &e)
                        .field("ours", protocol::VERSION)
                        .emit();
                    Response::Refused {
                        code: "unreadable_claim".to_string(),
                        message: format!(
                            "these devices are running different versions of Set (this one \
                             speaks sync protocol {}). Update both to the same version",
                            protocol::VERSION
                        ),
                    }
                }
            }
        }
    }

    async fn answer(
        self: &Arc<Self>,
        request: Request,
        peer: EndpointId,
        connection: &Connection,
        session: Option<&round::Session>,
    ) -> Response {
        if let Request::Claim {
            version,
            secret,
            device_name,
            notes_id,
        } = &request
        {
            return self
                .claim(
                    peer,
                    connection,
                    *version,
                    secret,
                    device_name,
                    notes_id.as_deref(),
                )
                .await;
        }
        match &request {
            Request::Introduce => return self.introduce_self(peer),
            Request::Knock {
                version,
                device_name,
                notes_id,
                commit,
            } => {
                return self
                    .knocked(
                        peer,
                        connection,
                        *version,
                        device_name,
                        notes_id.as_deref(),
                        commit,
                    )
                    .await
            }
            Request::Reveal { nonce } => return self.revealed(peer, connection, nonce).await,
            Request::ConfirmKnock => return self.confirmed(peer, connection).await,
            _ => {}
        }

        let paired = self.config().is_paired(&peer);
        if !paired {
            return Response::Refused {
                code: protocol::Refusal::NotPaired.code().to_string(),
                message: protocol::Refusal::NotPaired.to_string(),
            };
        }
        match session {
            Some(session) => session.answer(request).await,
            None => Response::Error("the notes folder hasn't been set yet".to_string()),
        }
    }

    async fn claim(
        self: &Arc<Self>,
        peer: EndpointId,
        connection: &Connection,
        version: u32,
        secret: &pairing::Secret,
        device_name: &str,
        notes_id: Option<&str>,
    ) -> Response {
        if let Err(refused) = pairing::may_claim(version) {
            return self.refuse(peer, refused).await;
        }

        if self.config().is_paired(&peer) {
            return Response::Paired {
                notes_id: self.config().notes_id,
            };
        }

        let now = now_ms();

        let allowed = self
            .throttle
            .lock()
            .expect("pairing throttle poisoned")
            .allows(&peer, now);
        if let Err(refused) = allowed {
            return self.refuse(peer, refused).await;
        }

        if !self.config().pairing_secret.same_as(secret) {
            self.throttle
                .lock()
                .expect("pairing throttle poisoned")
                .failed(peer, now);
            return self.refuse(peer, pairing::Refused::Wrong).await;
        }

        // Refuse what a click on Allow could not fix before asking anyone.
        if let Err(refused) = self.joining(peer, notes_id) {
            return self.refuse(peer, refused).await;
        }

        let name = pairing::device_name(device_name, &peer);

        // Whoever went first may have used the code up; check again once it is our turn.
        let _turn = self.approving.lock().await;
        if !self.config().pairing_secret.same_as(secret) {
            return self.refuse(peer, pairing::Refused::Wrong).await;
        }
        match self.ask(connection, &name, Prompt::Code).await {
            Some(Answer::Allowed) => {}
            Some(_) => {
                self.use_up_code();
                return self.refuse(peer, pairing::Refused::Declined).await;
            }
            None => return self.refuse(peer, pairing::Refused::NoAnswer).await,
        }
        self.admit(peer, name, notes_id, now, true).await
    }

    /// Asked every few seconds by every searching device, so refused without a log line.
    fn open_to(&self, peer: &EndpointId) -> Result<(), Response> {
        let open = self
            .nearby
            .lock()
            .expect("sync nearby poisoned")
            .open_to(peer, now_ms());
        if open {
            return Ok(());
        }
        Err(Response::Refused {
            code: pairing::Refused::NotDiscoverable.code().to_string(),
            message: pairing::Refused::NotDiscoverable.to_string(),
        })
    }

    fn introduce_self(&self, peer: EndpointId) -> Response {
        if let Err(refused) = self.open_to(&peer) {
            return refused;
        }
        Response::Introduced {
            version: protocol::VERSION,
            device_name: self.config().device_name,
        }
    }

    async fn knocked(
        self: &Arc<Self>,
        peer: EndpointId,
        connection: &Connection,
        version: u32,
        device_name: &str,
        notes_id: Option<&str>,
        commit: &[u8; 32],
    ) -> Response {
        // A device already paired here still takes every step: its `Paired` may have been lost,
        // and it must not skip its own prompt on our word (`admit` doesn't save it twice).
        if let Err(refused) = self.open_to(&peer) {
            return refused;
        }
        if let Err(refused) = pairing::may_claim(version) {
            return self.refuse(peer, refused).await;
        }
        let now = now_ms();
        let allowed = self
            .throttle
            .lock()
            .expect("pairing throttle poisoned")
            .allows(&peer, now);
        if let Err(refused) = allowed {
            return self.refuse(peer, refused).await;
        }
        if let Err(refused) = self.joining(peer, notes_id) {
            return self.refuse(peer, refused).await;
        }
        let nonce = self.knocks.lock().expect("sync knocks poisoned").knock(
            peer,
            connection.stable_id(),
            pairing::device_name(device_name, &peer),
            notes_id.map(str::to_string),
            *commit,
            now,
        );
        Response::Knocked { nonce }
    }

    async fn revealed(
        self: &Arc<Self>,
        peer: EndpointId,
        connection: &Connection,
        theirs: &pairing::Nonce,
    ) -> Response {
        if let Err(refused) = self.open_to(&peer) {
            return refused;
        }
        let revealed = self.knocks.lock().expect("sync knocks poisoned").reveal(
            &peer,
            connection.stable_id(),
            theirs,
            now_ms(),
        );
        let revealed = match revealed {
            Ok(revealed) => revealed,
            Err(refused) => return self.refuse(peer, refused).await,
        };
        let me = self.config().endpoint_id();
        let digits = pairing::check_digits(&peer, &me, theirs, &revealed.nonce);

        // Not waiting for a turn: two devices knocking on each other would each wait on the other.
        let Ok(_turn) = self.approving.try_lock() else {
            self.knocks
                .lock()
                .expect("sync knocks poisoned")
                .forget(&peer);
            return self.refuse(peer, pairing::Refused::Busy).await;
        };
        let prompt = Prompt::Nearby {
            digits: &digits,
            asking: false,
        };
        let answer = self.ask(connection, &revealed.name, prompt).await;
        if answer == Some(Answer::Allowed) {
            let allowed = self.knocks.lock().expect("sync knocks poisoned").allowed(
                &peer,
                connection.stable_id(),
                now_ms(),
            );
            return match allowed {
                Ok(()) => Response::Allowed,
                Err(refused) => self.refuse(peer, refused).await,
            };
        }

        self.knocks
            .lock()
            .expect("sync knocks poisoned")
            .forget(&peer);
        let refused = {
            let mut throttle = self.throttle.lock().expect("pairing throttle poisoned");
            match answer {
                Some(_) => {
                    throttle.block(peer, now_ms());
                    pairing::Refused::DeclinedNearby
                }
                None => {
                    throttle.failed(peer, now_ms());
                    pairing::Refused::NoAnswer
                }
            }
        };
        // Ids cost nothing, so a stranger turned down would just knock again as someone else.
        // Hiding means one prompt per press of Pair nearby.
        self.hide(None).await;
        self.refuse(peer, refused).await
    }

    async fn confirmed(self: &Arc<Self>, peer: EndpointId, connection: &Connection) -> Response {
        let confirmed = self.knocks.lock().expect("sync knocks poisoned").confirm(
            &peer,
            connection.stable_id(),
            now_ms(),
        );
        match confirmed {
            Ok((name, notes_id)) => {
                self.admit(peer, name, notes_id.as_deref(), now_ms(), false)
                    .await
            }
            Err(refused) => self.refuse(peer, refused).await,
        }
    }

    async fn pair_nearby(self: &Arc<Self>, peer: EndpointId) -> Result<(), String> {
        if self.config().is_paired(&peer) {
            return Err("that device is already paired".to_string());
        }
        let name = self
            .nearby
            .lock()
            .expect("sync nearby poisoned")
            .name(&peer)
            .map(str::to_string)
            .ok_or_else(|| {
                "that device isn't on the list anymore. Click Find nearby devices again".to_string()
            })?;
        let endpoint = self.endpoint().await?;
        let Ok(_turn) = self.approving.try_lock() else {
            return Err("answer the pairing prompt that's already open first".to_string());
        };

        let connection = match tokio::time::timeout(
            CONNECT_TIMEOUT,
            endpoint.connect(EndpointAddr::new(peer), protocol::ALPN),
        )
        .await
        {
            Ok(Ok(connection)) => connection,
            Ok(Err(e)) => return Err(format!("couldn't reach {name}: {e}")),
            Err(_) => return Err(format!("couldn't reach {name}. Is Set open on it?")),
        };
        let knocked = self.knock(&connection, peer, &name).await;
        connection.close(0u32.into(), b"paired");

        let notes_id = match knocked {
            Ok(notes_id) => notes_id,
            Err((code, message)) => {
                log::error("pair.rejected")
                    .peer(peer, &name)
                    .field("by", "nearby")
                    .field("reason", &code)
                    .field("error", &message)
                    .emit();
                return Err(message);
            }
        };
        {
            let mut config = self.config.lock().expect("sync config poisoned");
            if !config.is_paired(&peer) {
                // Only once saved: unsaved, a retry would be turned away as already paired.
                let mut saved = config.clone();
                saved.paired.push(state::PairedDevice {
                    id: peer,
                    name: name.clone(),
                    paired_at: now_ms(),
                    addrs: std::collections::BTreeSet::new(),
                    claim: None,
                });
                state::save(&saved)?;
                *config = saved;
            }
        }
        self.close_nearby().await;
        let _ = self.announce().await;
        let joined = self.join_notes(notes_id.clone());
        log::info("pair.confirmed")
            .peer(peer, &name)
            .field("by", "nearby")
            .field("notes", &notes_id)
            .field("joined", joined)
            .emit();
        self.broadcast().await;
        Ok(())
    }

    async fn knock(
        &self,
        connection: &Connection,
        peer: EndpointId,
        name: &str,
    ) -> Result<String, (String, String)> {
        let unreachable = |e: String| ("unreachable".to_string(), e);
        let config = self.config();
        let mine = pairing::nonce();
        let knock = Request::Knock {
            version: protocol::VERSION,
            device_name: config.device_name.clone(),
            notes_id: (!config.paired.is_empty()).then(|| config.notes_id.clone()),
            commit: pairing::commit(&mine),
        };
        let theirs = match session::request_small(connection, &knock).await {
            Ok(Response::Knocked { nonce }) => nonce,
            Ok(other) => return Err(refusal(other)),
            Err(e) => return Err(unreachable(e)),
        };
        let digits = pairing::check_digits(&config.endpoint_id(), &peer, &mine, &theirs);

        // Both prompts are up at once, so the digits can be read off one and typed into the other.
        // Either device turning it down hangs up, which takes the other prompt down too.
        let there = async {
            let reply = session::request_small(connection, &Request::Reveal { nonce: mine }).await;
            if !matches!(reply, Ok(Response::Allowed)) {
                connection.close(0u32.into(), b"refused");
            }
            reply
        };
        let here = async {
            let prompt = Prompt::Nearby {
                digits: &digits,
                asking: true,
            };
            let answer = self.ask(connection, name, prompt).await;
            if answer != Some(Answer::Allowed) {
                connection.close(0u32.into(), b"declined");
            }
            answer
        };
        let (there, here) = tokio::join!(there, here);
        match here {
            Some(Answer::Declined) => {
                return Err((
                    "declined_here".to_string(),
                    "you didn't allow it, so the devices weren't paired".to_string(),
                ))
            }
            Some(Answer::Mistyped) => {
                return Err((
                    "digits_mismatch".to_string(),
                    format!(
                        "that isn't the number on {name}, so the devices weren't paired. If you \
                         typed it right, another device may be posing as it"
                    ),
                ))
            }
            _ => {}
        }
        match there {
            Ok(Response::Allowed) => {}
            Ok(other) => return Err(refusal(other)),
            Err(e) => return Err(unreachable(e)),
        }
        if here.is_none() {
            return Err((
                pairing::Refused::NoAnswer.code().to_string(),
                "nobody clicked Allow on this device in time".to_string(),
            ));
        }

        match session::request_small(connection, &Request::ConfirmKnock).await {
            Ok(Response::Paired { notes_id }) => Ok(notes_id),
            Ok(other) => Err(refusal(other)),
            Err(e) => Err(unreachable(e)),
        }
    }

    /// Pairing by code (`rotate`) spends the code.
    async fn admit(
        self: &Arc<Self>,
        peer: EndpointId,
        name: String,
        notes_id: Option<&str>,
        now: f64,
        rotate: bool,
    ) -> Response {
        let joined = match self.joining(peer, notes_id) {
            Ok(joined) => joined,
            Err(refused) => return self.refuse(peer, refused).await,
        };
        let device = state::PairedDevice {
            id: peer,
            name: name.clone(),
            paired_at: now,

            addrs: std::collections::BTreeSet::new(),

            claim: None,
        };
        let moved_notes = {
            let mut config = self.config.lock().expect("sync config poisoned");
            let moved_notes = config.notes_id != joined;
            // Paired once already, but the other device never heard back.
            if !config.is_paired(&peer) {
                config.paired.push(device.clone());
            }

            config.notes_id = joined.clone();
            if rotate {
                config.pairing_secret = pairing::Secret::generate();
            }
            if let Err(e) = state::save(&config) {
                return Response::Error(e);
            }
            moved_notes
        };
        self.throttle
            .lock()
            .expect("pairing throttle poisoned")
            .succeeded(&peer);
        log::info("pair.accepted")
            .peer(peer, &name)
            .field("by", if rotate { "code" } else { "nearby" })
            .field("notes", &joined)
            .field("moved_notes", moved_notes)
            .emit();
        let _ = self.app.emit(
            "sync:paired",
            serde_json::json!({ "name": name, "byCode": rotate }),
        );
        if !rotate {
            self.close_nearby().await;
        }
        let _ = self.announce().await;
        self.broadcast().await;

        Response::Paired { notes_id: joined }
    }

    fn joining(
        &self,
        peer: EndpointId,
        notes_id: Option<&str>,
    ) -> Result<String, pairing::Refused> {
        let config = self.config();
        let settled = config.paired.iter().any(|d| d.id != peer);
        pairing::agree(notes_id, &config.notes_id, settled)
    }

    /// `None` when nobody answered in time or the peer hung up.
    async fn ask(&self, connection: &Connection, name: &str, prompt: Prompt<'_>) -> Option<Answer> {
        let id: u32 = rand::random();
        let (answer, answered) = tokio::sync::oneshot::channel();
        *self.approval.lock().expect("sync approval poisoned") = Some((id, answer));
        let _ = self.app.emit(
            "sync:pair-request",
            match prompt {
                Prompt::Code => serde_json::json!({ "id": id, "name": name }),
                // Not the digits: the person has to read them off the other device.
                Prompt::Nearby {
                    asking: true,
                    digits,
                } => serde_json::json!({
                    "id": id,
                    "name": name,
                    "asking": true,
                    "digitCount": digits.chars().filter(char::is_ascii_digit).count(),
                }),
                Prompt::Nearby {
                    asking: false,
                    digits,
                } => serde_json::json!({
                    "id": id,
                    "name": name,
                    "checkDigits": digits,
                    "asking": false,
                }),
            },
        );

        let outcome = tokio::select! {
            answer = tokio::time::timeout(pairing::APPROVAL_TIMEOUT, answered) => {
                answer.ok().and_then(Result::ok)
            }
            _ = connection.closed() => None,
        };
        let outcome = outcome.map(|reply| prompt.answer(reply));

        let _ = self
            .approval
            .lock()
            .expect("sync approval poisoned")
            .take_if(|(pending, _)| *pending == id);
        let _ = self
            .app
            .emit("sync:pair-request-closed", serde_json::json!({ "id": id }));
        outcome
    }

    /// Turning a device down still spends the code.
    fn use_up_code(&self) {
        let mut config = self.config.lock().expect("sync config poisoned");
        config.pairing_secret = pairing::Secret::generate();
        let _ = state::save(&config);
        log::info("code.used").emit();
    }

    async fn refuse(self: &Arc<Self>, peer: EndpointId, refused: pairing::Refused) -> Response {
        let mut record = log::warn("pair.refused")
            .peer(peer, self.peer_name(&peer))
            .field("reason", refused.code());
        if let pairing::Refused::Version { theirs, ours } = refused {
            record = record.field("theirs", theirs).field("ours", ours);
        }
        record.emit();
        self.broadcast().await;
        Response::Refused {
            code: refused.code().to_string(),
            message: refused.to_string(),
        }
    }

    fn mark(&self, peer: EndpointId, f: impl FnOnce(&mut Live)) {
        let mut peers = self.peers.lock().expect("sync peers poisoned");
        f(peers.entry(peer).or_default());
    }
}

#[derive(Clone, Copy)]
enum Prompt<'a> {
    Code,
    /// The picker (`asking`) types the check digits in rather than being shown them, so nobody can
    /// allow it without comparing.
    Nearby {
        digits: &'a str,
        asking: bool,
    },
}

struct Reply {
    allow: bool,
    digits: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Answer {
    Allowed,
    Declined,
    Mistyped,
}

impl Prompt<'_> {
    fn answer(self, reply: Reply) -> Answer {
        if !reply.allow {
            return Answer::Declined;
        }
        match self {
            Prompt::Nearby {
                digits,
                asking: true,
            } => {
                let only_digits =
                    |s: &str| s.chars().filter(char::is_ascii_digit).collect::<String>();
                let typed = reply.digits.as_deref().map(only_digits);
                if typed.is_some_and(|typed| typed == only_digits(digits)) {
                    Answer::Allowed
                } else {
                    Answer::Mistyped
                }
            }
            _ => Answer::Allowed,
        }
    }
}

#[derive(Debug, Clone)]
struct Handler(Weak<Inner>);

impl ProtocolHandler for Handler {
    async fn accept(&self, connection: Connection) -> Result<(), AcceptError> {
        let Some(inner) = self.0.upgrade() else {
            return Ok(());
        };
        let peer = connection.remote_id();

        inner.mark(peer, |l| l.connected = true);
        inner.broadcast().await;
        inner.serve_streams(connection, peer).await;
        inner.mark(peer, |l| l.connected = false);
        inner.broadcast().await;
        Ok(())
    }
}

/// `(code, message)`
fn refusal(reply: Response) -> (String, String) {
    match reply {
        Response::Refused { code, message } => (code, message),
        Response::Error(e) => ("peer_error".to_string(), e),
        other => (
            "unexpected_reply".to_string(),
            format!(
                "the other device didn't understand this pairing request. The two are probably \
                 running different versions of Set. Reply was {other:?}"
            ),
        ),
    }
}

fn now_ms() -> f64 {
    crate::clock::now_ms() as f64
}

#[tauri::command]
pub async fn sync_status(sync: tauri::State<'_, Sync>) -> Result<Status, String> {
    let inner = sync.engine().clone();
    let running = inner.running.lock().await;
    Ok(inner.status(running.as_ref().map(|r| &r.endpoint)))
}

#[tauri::command]
pub async fn sync_set_enabled(
    sync: tauri::State<'_, Sync>,
    enabled: bool,
    notes_dir: String,
) -> Result<Status, String> {
    let inner = sync.engine().clone();
    *inner.notes_root.lock().expect("notes root poisoned") = Some(PathBuf::from(notes_dir));
    {
        let mut config = inner.config.lock().expect("sync config poisoned");
        config.enabled = enabled;
        state::save(&config)?;
    }
    if enabled {
        inner.start().await?;
    } else {
        inner.stop().await;
    }
    sync_status(sync).await
}

#[tauri::command]
pub async fn sync_set_notes_dir(
    sync: tauri::State<'_, Sync>,
    notes_dir: String,
) -> Result<(), String> {
    let inner = sync.engine().clone();
    let next = crate::root::policy(&notes_dir)?;
    let changed = {
        let mut root = inner.notes_root.lock().expect("notes root poisoned");
        let changed = root.as_ref() != Some(&next);
        *root = Some(next);
        changed
    };

    if changed {
        inner.restart().await?;
    }
    Ok(())
}

/// Another folder was chosen: forget every agreement and take a new folder id, which paired devices
/// refuse until re-paired.
#[tauri::command]
pub async fn sync_forget_notes(sync: tauri::State<'_, Sync>) -> Result<Status, String> {
    let inner = sync.engine().clone();
    {
        let _no_round = inner.round_lock.lock().await;
        let mut config = inner.config.lock().expect("sync config poisoned");
        config.notes_id = uuid::Uuid::new_v4().to_string();
        state::save(&config)?;
        state::forget_notes(&state::Dirs::app()?);
    }
    inner.peers.lock().expect("sync peers poisoned").clear();
    log::info("notes.forgotten").emit();
    inner.broadcast().await;
    sync_status(sync).await
}

#[tauri::command]
pub async fn sync_regenerate_pairing_code(sync: tauri::State<'_, Sync>) -> Result<Status, String> {
    let inner = sync.engine().clone();
    {
        let mut config = inner.config.lock().expect("sync config poisoned");
        config.pairing_secret = pairing::Secret::generate();
        state::save(&config)?;
    }

    *inner.throttle.lock().expect("pairing throttle poisoned") = pairing::Throttle::default();
    log::info("code.replaced").emit();
    inner.broadcast().await;
    sync_status(sync).await
}

/// An id that timed out or was answered is ignored.
#[tauri::command]
pub fn sync_answer_pair(
    sync: tauri::State<'_, Sync>,
    id: u32,
    allow: bool,
    digits: Option<String>,
) {
    let pending = sync
        .engine()
        .approval
        .lock()
        .expect("sync approval poisoned")
        .take_if(|(pending, _)| *pending == id);
    if let Some((_, answer)) = pending {
        let _ = answer.send(Reply { allow, digits });
    }
}

#[tauri::command]
pub async fn sync_pair(sync: tauri::State<'_, Sync>, code: String) -> Result<Status, String> {
    let inner = sync.engine().clone();
    let code: pairing::PairingCode = code.parse()?;
    let addr = code.addr;
    let id = addr.id;

    if id == inner.config().endpoint_id() {
        return Err("that's this device's own pairing code".to_string());
    }

    let fresh = {
        let mut config = inner.config.lock().expect("sync config poisoned");
        let fresh = if let Some(existing) = config.paired.iter_mut().find(|d| d.id == id) {
            existing.paired_at = now_ms();
            existing.addrs = addr.addrs.clone();
            existing.claim = Some(code.secret);
            false
        } else {
            config.paired.push(state::PairedDevice {
                id,
                name: format!("Device {}", &id.to_string()[..8]),
                paired_at: now_ms(),
                addrs: addr.addrs.clone(),

                claim: Some(code.secret),
            });
            true
        };
        state::save(&config)?;
        fresh
    };
    log::info("pair.added")
        .peer(id, inner.peer_name(&id))
        .field("addrs", addr.addrs.len())
        .emit();

    // Nothing is synced until "Sync now".
    if inner.config().enabled {
        inner.start().await?;
        inner.announce().await?;
        let endpoint = inner.endpoint().await?;
        let device = inner.config().paired.into_iter().find(|d| d.id == id);
        if let Some(device) = device {
            if let Some(connection) = inner.dial(&endpoint, &device).await {
                let redeemed = inner.redeem(&connection, id).await;
                connection.close(0u32.into(), b"paired");
                inner.mark(id, |l| l.connected = false);
                if let Err(refused) = redeemed {
                    // A device that was only ever a pasted code should not look half paired.
                    if fresh {
                        let mut config = inner.config.lock().expect("sync config poisoned");
                        config.paired.retain(|d| d.id != id);
                        let _ = state::save(&config);
                        drop(config);
                        inner.peers.lock().expect("sync peers poisoned").remove(&id);
                    }
                    let _ = inner.announce().await;
                    inner.broadcast().await;
                    return Err(refused);
                }
            }
        }
    }
    inner.broadcast().await;
    sync_status(sync).await
}

#[tauri::command]
pub async fn sync_search_nearby(sync: tauri::State<'_, Sync>, on: bool) -> Result<Status, String> {
    let inner = sync.engine().clone();
    if on {
        inner.search().await?;
    } else {
        inner.stop_search(None).await;
    }
    sync_status(sync).await
}

#[tauri::command]
pub async fn sync_set_discoverable(
    sync: tauri::State<'_, Sync>,
    on: bool,
) -> Result<Status, String> {
    let inner = sync.engine().clone();
    if on {
        inner.discover().await?;
    } else {
        inner.hide(None).await;
    }
    sync_status(sync).await
}

#[tauri::command]
pub async fn sync_pair_nearby(sync: tauri::State<'_, Sync>, id: String) -> Result<Status, String> {
    let peer: EndpointId = id.parse().map_err(|e| format!("not a device id: {e}"))?;
    sync.engine().clone().pair_nearby(peer).await?;
    sync_status(sync).await
}

#[tauri::command]
pub async fn sync_unpair(sync: tauri::State<'_, Sync>, id: String) -> Result<Status, String> {
    let inner = sync.engine().clone();
    let peer: EndpointId = id.parse().map_err(|e| format!("not a device id: {e}"))?;
    let peer_name = inner.peer_name(&peer);
    {
        let mut config = inner.config.lock().expect("sync config poisoned");
        config.paired.retain(|d| d.id != peer);
        state::save(&config)?;
    }
    log::info("pair.removed").peer(peer, &peer_name).emit();

    if let Ok(dirs) = state::Dirs::app() {
        state::forget_baseline(&dirs.baselines, &peer);
    }
    inner
        .peers
        .lock()
        .expect("sync peers poisoned")
        .remove(&peer);
    let _ = inner.announce().await;
    inner.broadcast().await;
    sync_status(sync).await
}

/// A round with something to do stops at a "sync:preview" first.
#[tauri::command]
pub async fn sync_now(sync: tauri::State<'_, Sync>) -> Result<Status, String> {
    let inner = sync.engine().clone();
    if !inner.config().enabled {
        return Err("sync is off".to_string());
    }
    inner.start().await?;
    inner.sync_all().await?;
    sync_status(sync).await
}

/// No `id` answers whichever is up, which is how a reloaded window calls off a stale round.
#[tauri::command]
pub fn sync_answer_preview(sync: tauri::State<'_, Sync>, id: Option<u32>, go: bool) {
    let pending = sync
        .engine()
        .reviewing
        .lock()
        .expect("sync review poisoned")
        .take_if(|pending| id.is_none_or(|id| pending.id == id));
    if let Some(pending) = pending {
        let _ = pending.answer.send(go);
    }
}

/// `None` when the preview is gone or the change has nothing to compare (image, move, too big).
#[tauri::command]
pub async fn sync_preview_diff(
    sync: tauri::State<'_, Sync>,
    id: u32,
    path: String,
) -> Result<Option<preview::Diff>, String> {
    let diff = sync
        .engine()
        .reviewing
        .lock()
        .expect("sync review poisoned")
        .as_ref()
        .filter(|pending| pending.id == id)
        .map(|pending| pending.diff.clone());
    let Some(diff) = diff else { return Ok(None) };
    tauri::async_runtime::spawn_blocking(move || diff(&path))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sync_log_read() -> Vec<serde_json::Value> {
    log::read()
        .into_iter()
        .map(|entry| {
            serde_json::json!({
                "at": entry.at,
                "level": entry.level.as_str(),
                "event": entry.event,

                "fields": entry.fields,
            })
        })
        .collect()
}

#[tauri::command]
pub fn sync_log_clear() -> Result<(), String> {
    log::clear()
}

#[cfg(test)]
mod prompt_tests {
    use super::*;

    fn reply(allow: bool, digits: Option<&str>) -> Reply {
        Reply {
            allow,
            digits: digits.map(str::to_string),
        }
    }

    #[test]
    fn the_device_that_picked_must_type_the_digits() {
        let asking = Prompt::Nearby {
            digits: "123 456",
            asking: true,
        };
        assert_eq!(asking.answer(reply(true, Some("123456"))), Answer::Allowed);
        assert_eq!(
            asking.answer(reply(true, Some(" 123-456 "))),
            Answer::Allowed
        );
        assert_eq!(asking.answer(reply(true, Some("123457"))), Answer::Mistyped);
        assert_eq!(
            asking.answer(reply(true, None)),
            Answer::Mistyped,
            "just Allow"
        );
        assert_eq!(
            asking.answer(reply(false, Some("123456"))),
            Answer::Declined
        );
    }
}
