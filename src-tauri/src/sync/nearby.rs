//! mDNS on the local network. Being nearby grants nothing: the allowlist and the claim are still
//! the only ways in.

use std::collections::hash_map::Entry;
use std::collections::HashMap;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use iroh::address_lookup::{AddressLookup, EndpointData, Error as LookupError, Item};
use iroh::EndpointId;
use iroh_mdns_address_lookup::{DiscoveryEvent, MdnsAddressLookup};
use tokio_stream::StreamExt;

pub const SEARCH_WINDOW: Duration = Duration::from_secs(2 * 60);

pub const DISCOVERABLE_WINDOW: Duration = Duration::from_secs(2 * 60);

pub const SEARCH_EVERY: Duration = Duration::from_secs(4);

/// Ours rather than iroh's shared `irohv1`, so Set only hears from Set. At most 15 bytes.
pub const SERVICE: &str = "set-sync";

/// Anyone on the network can announce as many ids as they like.
const MAX_HEARD: usize = 32;

/// `None` without multicast; sync then goes through the relay alone.
pub fn lookup(me: EndpointId, advertise: bool) -> Option<MdnsAddressLookup> {
    match MdnsAddressLookup::builder()
        .service_name(SERVICE)
        .advertise(advertise)
        .build(me)
    {
        Ok(mdns) => Some(mdns),
        Err(e) => {
            super::log::warn("sync.mdns_unavailable")
                .field("error", e.to_string())
                .emit();
            None
        }
    }
}

/// mDNS can't start or stop announcing once built, so this swaps in a new one and the endpoint,
/// with any round on it, stays up.
#[derive(Clone, Debug)]
pub struct Lookup(Arc<Mutex<Announcer>>);

#[derive(Debug)]
struct Announcer {
    me: EndpointId,
    mdns: MdnsAddressLookup,
    advertising: bool,
    /// Republished by a swapped-in mDNS.
    published: Option<EndpointData>,
}

impl Lookup {
    pub fn new(me: EndpointId, advertise: bool) -> Option<Self> {
        let mdns = lookup(me, advertise)?;
        Some(Lookup(Arc::new(Mutex::new(Announcer {
            me,
            mdns,
            advertising: advertise,
            published: None,
        }))))
    }

    pub fn mdns(&self) -> MdnsAddressLookup {
        self.0.lock().expect("mdns poisoned").mdns.clone()
    }

    /// The new mDNS to follow, if it changed.
    pub fn advertise(&self, advertise: bool) -> Option<MdnsAddressLookup> {
        let mut announcer = self.0.lock().expect("mdns poisoned");
        if announcer.advertising == advertise {
            return None;
        }
        let mdns = lookup(announcer.me, advertise)?;
        if let Some(data) = &announcer.published {
            mdns.publish(data);
        }
        announcer.mdns = mdns.clone();
        announcer.advertising = advertise;
        Some(mdns)
    }
}

impl AddressLookup for Lookup {
    fn publish(&self, data: &EndpointData) {
        let mut announcer = self.0.lock().expect("mdns poisoned");
        announcer.published = Some(data.clone());
        announcer.mdns.publish(data);
    }

    fn resolve(
        &self,
        endpoint_id: EndpointId,
    ) -> Option<Pin<Box<dyn tokio_stream::Stream<Item = Result<Item, LookupError>> + Send>>> {
        self.mdns().resolve(endpoint_id)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Introduction {
    pub name: String,
    pub version: u32,
}

#[derive(Default)]
pub struct Nearby {
    devices: HashMap<EndpointId, Option<Introduction>>,
    discoverable: Option<Window>,
    search: Option<Window>,
    windows: u64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Window {
    /// Which press, so the timer of an earlier one can't end a later one.
    pub id: u64,
    /// Milliseconds since the epoch.
    pub until: f64,
}

impl Nearby {
    /// Keeps the window counter, so an old timer can't end a new window.
    pub fn reset(&mut self) {
        *self = Nearby {
            windows: self.windows,
            ..Nearby::default()
        };
    }

    pub fn forget_devices(&mut self) {
        self.devices.clear();
    }

    pub fn contains(&self, id: &EndpointId) -> bool {
        self.devices.contains_key(id)
    }

    fn open(&mut self, now: f64, length: Duration) -> Window {
        self.windows += 1;
        Window {
            id: self.windows,
            until: now + length.as_millis() as f64,
        }
    }

    pub fn discover(&mut self, now: f64) -> Window {
        let window = self.open(now, DISCOVERABLE_WINDOW);
        self.discoverable = Some(window);
        window
    }

    /// `None`: whichever window is open.
    pub fn hide(&mut self, id: Option<u64>) -> bool {
        let open = is_current(self.discoverable, id);
        if open {
            self.discoverable = None;
        }
        open
    }

    pub fn discoverable(&self, now: f64) -> bool {
        self.discoverable.is_some_and(|w| now < w.until)
    }

    pub fn open_to(&self, peer: &EndpointId, now: f64) -> bool {
        self.discoverable(now) && self.contains(peer)
    }

    pub fn search(&mut self, now: f64) -> Window {
        let window = self.open(now, SEARCH_WINDOW);
        self.search = Some(window);
        window
    }

    /// `None`: whichever. Also forgets the names heard.
    pub fn stop_search(&mut self, id: Option<u64>) -> bool {
        let running = is_current(self.search, id);
        if running {
            self.search = None;
            for intro in self.devices.values_mut() {
                *intro = None;
            }
        }
        running
    }

    pub fn searching(&self, now: f64) -> Option<Window> {
        self.search.filter(|s| now < s.until)
    }

    /// All of them every time: a device can become discoverable or stop being so.
    pub fn devices(&self) -> Vec<EndpointId> {
        self.devices.keys().copied().collect()
    }

    /// Whether Settings needs updating.
    pub fn apply(&mut self, event: DiscoveryEvent, paired: impl Fn(&EndpointId) -> bool) -> bool {
        match event {
            DiscoveryEvent::Discovered { endpoint_info, .. } => {
                let id = endpoint_info.endpoint_id;
                let full = self.devices.len() >= MAX_HEARD;
                match self.devices.entry(id) {
                    Entry::Occupied(_) => false,
                    Entry::Vacant(_) if full && !paired(&id) => false,
                    Entry::Vacant(entry) => {
                        entry.insert(None);
                        paired(&id)
                    }
                }
            }
            DiscoveryEvent::Expired { endpoint_id } => match self.devices.remove(&endpoint_id) {
                Some(intro) => intro.is_some() || paired(&endpoint_id),
                None => false,
            },
            _ => false,
        }
    }

    /// `None`: not discoverable (any more).
    pub fn heard(&mut self, id: &EndpointId, introduction: Option<Introduction>) -> bool {
        if self.search.is_none() {
            return false;
        }
        match self.devices.get_mut(id) {
            Some(slot) if *slot != introduction => {
                *slot = introduction;
                true
            }
            _ => false,
        }
    }

    pub fn introduced(&self) -> impl Iterator<Item = (&EndpointId, &Introduction)> {
        self.devices
            .iter()
            .filter_map(|(id, intro)| intro.as_ref().map(|intro| (id, intro)))
    }

    pub fn name(&self, id: &EndpointId) -> Option<&str> {
        self.devices
            .get(id)?
            .as_ref()
            .map(|intro| intro.name.as_str())
    }
}

fn is_current(window: Option<Window>, id: Option<u64>) -> bool {
    match (window, id) {
        (Some(window), Some(id)) => window.id == id,
        (Some(_), None) => true,
        (None, _) => false,
    }
}

pub async fn watch(mdns: MdnsAddressLookup, mut changed: impl FnMut(DiscoveryEvent)) {
    let mut events = mdns.subscribe().await;
    while let Some(event) = events.next().await {
        changed(event);
    }
}

#[cfg(test)]
mod tests {
    use iroh::SecretKey;

    use super::*;

    const NOW: f64 = 1_720_000_000_000.0;

    fn found(nearby: &mut Nearby) -> EndpointId {
        let id = SecretKey::generate().public();
        nearby.apply(discovered(id), |_| false);
        id
    }

    fn discovered(id: EndpointId) -> DiscoveryEvent {
        DiscoveryEvent::Discovered {
            endpoint_info: iroh::address_lookup::EndpointInfo::new(id),
            last_updated: None,
        }
    }

    fn laptop() -> Introduction {
        Introduction {
            name: "Laptop".to_string(),
            version: 5,
        }
    }

    #[test]
    fn only_a_discoverable_device_is_open_to_its_neighbours() {
        let mut nearby = Nearby::default();
        let id = found(&mut nearby);
        assert!(!nearby.open_to(&id, NOW), "not discoverable yet");
        let first = nearby.discover(NOW);
        assert!(nearby.open_to(&id, NOW));
        assert!(
            !nearby.open_to(&SecretKey::generate().public(), NOW),
            "not on this network"
        );
        let window = DISCOVERABLE_WINDOW.as_millis() as f64;
        assert!(!nearby.open_to(&id, NOW + window), "it runs out by itself");

        let second = nearby.discover(NOW + window);
        assert!(!nearby.hide(Some(first.id)), "an old timer leaves it on");
        assert!(nearby.open_to(&id, NOW + window));
        assert!(nearby.hide(Some(second.id)));
        assert!(!nearby.open_to(&id, NOW + window));
    }

    #[test]
    fn windows_from_before_a_restart_end_nothing_after_it() {
        let mut nearby = Nearby::default();
        let before = nearby.search(NOW);
        nearby.reset();
        let after = nearby.search(NOW);
        assert_ne!(before.id, after.id);
        assert!(!nearby.stop_search(Some(before.id)));
    }

    #[test]
    fn strangers_can_only_fill_so_much_of_the_list() {
        let mut nearby = Nearby::default();
        for _ in 0..MAX_HEARD * 4 {
            found(&mut nearby);
        }
        assert_eq!(nearby.devices.len(), MAX_HEARD);
        let paired = SecretKey::generate().public();
        assert!(
            nearby.apply(discovered(paired), |id| *id == paired),
            "a paired device always gets in, and shows"
        );
        assert!(nearby.contains(&paired));
    }

    #[test]
    fn a_search_lists_names_until_it_stops() {
        let mut nearby = Nearby::default();
        let id = found(&mut nearby);
        assert!(!nearby.heard(&id, Some(laptop())), "not searching");

        let first = nearby.search(NOW);
        assert!(nearby.searching(NOW + 1000.0).is_some());
        assert!(nearby.heard(&id, Some(laptop())));
        assert!(!nearby.heard(&id, Some(laptop())), "nothing new");
        assert_eq!(nearby.name(&id), Some("Laptop"));
        assert_eq!(nearby.devices(), vec![id], "still asked");

        assert!(nearby.heard(&id, None));
        assert_eq!(nearby.name(&id), None);
        nearby.heard(&id, Some(laptop()));

        let window = SEARCH_WINDOW.as_millis() as f64;
        assert!(
            nearby.searching(NOW + window).is_none(),
            "the search ran out"
        );

        let second = nearby.search(NOW + window);
        assert!(!nearby.stop_search(Some(first.id)));
        assert!(nearby.searching(NOW + window + 1000.0).is_some());

        assert!(nearby.stop_search(Some(second.id)));
        assert_eq!(
            nearby.name(&id),
            None,
            "names are forgotten when the search stops"
        );
        assert!(nearby.contains(&id), "but the device is still nearby");
    }

    #[test]
    fn follows_announcements_and_expiries() {
        let id = SecretKey::generate().public();
        let mut nearby = Nearby::default();
        assert!(!nearby.apply(DiscoveryEvent::Expired { endpoint_id: id }, |_| false));
        assert!(
            !nearby.apply(discovered(id), |_| false),
            "a stranger arriving shows nothing until it says who it is"
        );
        assert!(!nearby.apply(discovered(id), |_| false));
        assert!(nearby.contains(&id));
        assert_eq!(nearby.introduced().count(), 0);

        nearby.search(NOW);
        assert!(nearby.heard(&id, Some(laptop())));
        assert_eq!(nearby.name(&id), Some("Laptop"));
        nearby.apply(discovered(id), |_| false);
        assert_eq!(nearby.name(&id), Some("Laptop"));

        assert!(
            nearby.apply(DiscoveryEvent::Expired { endpoint_id: id }, |_| false),
            "a named device leaving drops off the list"
        );
        assert!(!nearby.contains(&id));
        assert!(
            !nearby.heard(&id, Some(laptop())),
            "gone devices aren't named"
        );

        let paired = SecretKey::generate().public();
        assert!(nearby.apply(discovered(paired), |_| true));
        assert!(nearby.apply(
            DiscoveryEvent::Expired {
                endpoint_id: paired
            },
            |_| true
        ));
    }
}
