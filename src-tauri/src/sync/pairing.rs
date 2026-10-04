use std::collections::HashMap;
use std::str::FromStr;
use std::time::Duration;

use iroh::{EndpointAddr, EndpointId};
use iroh_tickets::endpoint::EndpointTicket;
use serde::{de, Deserialize, Deserializer, Serialize, Serializer};

pub const MAX_ATTEMPTS: u32 = 10;

pub const COOLDOWN: Duration = Duration::from_secs(5 * 60);

/// How many devices' failed attempts are remembered at once.
const MAX_TRACKED: usize = 1024;

/// Long enough to walk to the other machine.
pub const APPROVAL_TIMEOUT: Duration = Duration::from_secs(90);

const SECRET_LEN: usize = 16;

#[derive(Clone, PartialEq, Eq)]
pub struct Secret([u8; SECRET_LEN]);

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Secret(…)")
    }
}

impl Serialize for Secret {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        if serializer.is_human_readable() {
            serializer.serialize_str(&self.to_hex())
        } else {
            self.0.serialize(serializer)
        }
    }
}

impl<'de> Deserialize<'de> for Secret {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        if deserializer.is_human_readable() {
            let text = String::deserialize(deserializer)?;
            Secret::from_hex(&text)
                .ok_or_else(|| de::Error::custom("a pairing secret is 32 hex digits"))
        } else {
            Ok(Secret(<[u8; SECRET_LEN]>::deserialize(deserializer)?))
        }
    }
}

impl Secret {
    pub fn generate() -> Self {
        Secret(rand::random())
    }

    pub fn same_as(&self, other: &Secret) -> bool {
        let mut diff = 0u8;
        for (a, b) in self.0.iter().zip(other.0.iter()) {
            diff |= a ^ b;
        }
        diff == 0
    }

    fn to_hex(&self) -> String {
        crate::hex::encode(&self.0)
    }

    fn from_hex(text: &str) -> Option<Self> {
        crate::hex::decode(text).map(Secret)
    }
}

#[derive(Clone, Debug)]
pub struct PairingCode {
    pub addr: EndpointAddr,
    pub secret: Secret,
}

impl std::fmt::Display for PairingCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{}-{}",
            EndpointTicket::new(self.addr.clone()),
            self.secret.to_hex()
        )
    }
}

impl FromStr for PairingCode {
    type Err = String;

    fn from_str(text: &str) -> Result<Self, Self::Err> {
        let text = text.trim();
        let Some((ticket, secret)) = text.rsplit_once('-') else {
            return Err("that doesn't look like a pairing code".to_string());
        };
        let ticket: EndpointTicket = ticket
            .parse()
            .map_err(|e| format!("that doesn't look like a pairing code: {e}"))?;
        let secret = Secret::from_hex(secret)
            .ok_or_else(|| "that pairing code is incomplete".to_string())?;
        Ok(PairingCode {
            addr: EndpointAddr::from(ticket),
            secret,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refused {
    Wrong,

    TooManyAttempts,

    DifferentNotes,

    Version {
        theirs: u32,
        ours: u32,
    },

    /// The code was right and someone clicked "Don't allow".
    Declined,

    /// The code was right and nobody answered the prompt in time.
    NoAnswer,

    NotDiscoverable,

    DeclinedNearby,

    /// A step of pairing nearby that came too late, out of turn, or on another connection.
    KnockExpired,

    KnockMismatch,

    Busy,
}

impl Refused {
    pub fn code(&self) -> &'static str {
        match self {
            Refused::Wrong => "wrong_code",
            Refused::TooManyAttempts => "throttled",
            Refused::DifferentNotes => "different_notes",
            Refused::Version { .. } => "version_mismatch",
            Refused::Declined => "declined",
            Refused::NoAnswer => "no_answer",
            Refused::NotDiscoverable => "not_discoverable",
            Refused::DeclinedNearby => "declined_nearby",
            Refused::KnockExpired => "knock_expired",
            Refused::KnockMismatch => "knock_mismatch",
            Refused::Busy => "pairing_busy",
        }
    }
}

impl std::fmt::Display for Refused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Refused::Wrong => write!(
                f,
                "that code was already used or replaced. Copy the current one from the other device"
            ),
            Refused::TooManyAttempts => write!(
                f,
                "the other device has refused too many pairing attempts from here; wait a few minutes and try again"
            ),
            Refused::DifferentNotes => write!(
                f,
                "these two devices are already syncing different notes folders. Unpair one of them first, or pair a device that hasn't synced yet"
            ),

            Refused::Version { theirs, ours } => write!(
                f,
                "these devices are running different versions of Set (sync protocol {theirs} and {ours}). Update both to the same version"
            ),
            Refused::Declined => write!(
                f,
                "the other device didn't allow it. That code is used up, so copy the new one"
            ),
            Refused::NoAnswer => write!(
                f,
                "nobody clicked Allow on the other device. Try again and answer the prompt there"
            ),
            Refused::NotDiscoverable => write!(
                f,
                "the other device isn't discoverable. Turn on Discoverable in its Sync settings and try again"
            ),
            Refused::DeclinedNearby => write!(
                f,
                "the other device didn't allow it. You can ask again in a few minutes"
            ),
            Refused::KnockExpired => write!(f, "the pairing request ran out of time. Try again"),
            Refused::KnockMismatch => write!(
                f,
                "the other device's answer didn't check out, so it wasn't paired. Try again"
            ),
            Refused::Busy => write!(
                f,
                "the other device is showing another pairing prompt. Try again in a moment"
            ),
        }
    }
}

pub type Nonce = [u8; 32];

pub fn nonce() -> Nonce {
    rand::random()
}

/// Sent before the other device's nonce is seen, so the nonce can't be chosen to suit it.
pub fn commit(nonce: &Nonce) -> [u8; 32] {
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"set/sync/knock-commit");
    hasher.update(nonce);
    *hasher.finalize().as_bytes()
}

/// Neither device can choose its nonce after seeing the other's, so a device in the middle gets
/// matching digits only by a one in a million chance.
pub fn check_digits(
    knocker: &EndpointId,
    knocked: &EndpointId,
    knocker_nonce: &Nonce,
    knocked_nonce: &Nonce,
) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"set/sync/check-digits");
    hasher.update(knocker.as_bytes());
    hasher.update(knocked.as_bytes());
    hasher.update(knocker_nonce);
    hasher.update(knocked_nonce);
    let bytes = hasher.finalize();
    let n = u64::from_le_bytes(bytes.as_bytes()[..8].try_into().expect("eight bytes")) % 1_000_000;
    format!("{:03} {:03}", n / 1000, n % 1000)
}

const MAX_NAME: usize = 64;

/// No control or invisible formatting characters, which could make it read as another name.
pub fn device_name(given: &str, id: &EndpointId) -> String {
    let shown: String = given
        .chars()
        .filter(|c| !c.is_control() && !invisible(*c))
        .collect();
    let shown: String = shown.trim().chars().take(MAX_NAME).collect();
    match shown.trim_end() {
        "" => format!("Device {}", &id.to_string()[..8]),
        named => named.to_string(),
    }
}

fn invisible(c: char) -> bool {
    matches!(c,
        '\u{00AD}'
        | '\u{061C}'
        | '\u{180E}'
        | '\u{200B}'..='\u{200F}'
        | '\u{202A}'..='\u{202E}'
        | '\u{2060}'..='\u{2069}'
        | '\u{FEFF}'
    )
}

pub fn may_claim(their_version: u32) -> Result<(), Refused> {
    if their_version != super::protocol::VERSION {
        return Err(Refused::Version {
            theirs: their_version,
            ours: super::protocol::VERSION,
        });
    }
    Ok(())
}

pub fn agree(claimer: Option<&str>, ours: &str, ours_settled: bool) -> Result<String, Refused> {
    match claimer {
        None => Ok(ours.to_string()),
        Some(theirs) if theirs == ours => Ok(ours.to_string()),

        Some(theirs) if !ours_settled => Ok(theirs.to_string()),
        Some(_) => Err(Refused::DifferentNotes),
    }
}

#[derive(Debug, Default)]
pub struct Throttle(HashMap<EndpointId, Failures>);

#[derive(Debug)]
struct Failures {
    count: u32,
    latest: f64,
}

impl Throttle {
    pub fn allows(&mut self, peer: &EndpointId, now: f64) -> Result<(), Refused> {
        let Some(failures) = self.0.get(peer) else {
            return Ok(());
        };
        if failures.count < MAX_ATTEMPTS {
            return Ok(());
        }
        if now - failures.latest >= COOLDOWN.as_millis() as f64 {
            self.0.remove(peer);
            return Ok(());
        }
        Err(Refused::TooManyAttempts)
    }

    pub fn failed(&mut self, peer: EndpointId, now: f64) {
        // Endpoint ids are free to make; the secret's 128 bits are the defence, this map only has
        // to stay bounded.
        if self.0.len() >= MAX_TRACKED && !self.0.contains_key(&peer) {
            let cooled = COOLDOWN.as_millis() as f64;
            self.0.retain(|_, f| now - f.latest < cooled);
            if self.0.len() >= MAX_TRACKED {
                self.0.clear();
            }
        }
        let failures = self.0.entry(peer).or_insert(Failures {
            count: 0,
            latest: now,
        });
        failures.count += 1;
        failures.latest = now;
    }

    /// So a stranger on the network can't keep a prompt on screen.
    pub fn block(&mut self, peer: EndpointId, now: f64) {
        self.failed(peer, now);
        if let Some(failures) = self.0.get_mut(&peer) {
            failures.count = failures.count.max(MAX_ATTEMPTS);
        }
    }

    pub fn succeeded(&mut self, peer: &EndpointId) {
        self.0.remove(peer);
    }
}

const REVEAL_TIMEOUT: Duration = Duration::from_secs(30);

const MAX_KNOCKS: usize = 8;

/// Pairing nearby, from the device asked. Each device saves the other only once Allow is clicked
/// on it, so it takes three requests on the knock's connection:
///
/// 1. `Knock` carries the knocker's commitment; this device answers with its own nonce.
/// 2. `Reveal` carries the knocker's nonce. This device shows the check digits and asks, and
///    answers `Allowed` once someone clicks Allow here.
/// 3. `ConfirmKnock` comes once the digits are typed in on the knocker and Allow clicked there
///    too. Only then does this device save it.
#[derive(Default)]
pub struct Knocks(HashMap<EndpointId, Knock>);

struct Knock {
    connection: usize,
    at: f64,
    name: String,
    notes_id: Option<String>,
    stage: Stage,
}

enum Stage {
    Committed { commit: [u8; 32], nonce: Nonce },
    Asking,
    Allowed,
}

pub struct Revealed {
    pub nonce: Nonce,
    pub name: String,
}

impl Knocks {
    pub fn knock(
        &mut self,
        peer: EndpointId,
        connection: usize,
        name: String,
        notes_id: Option<String>,
        commit: [u8; 32],
        now: f64,
    ) -> Nonce {
        if self.0.len() >= MAX_KNOCKS && !self.0.contains_key(&peer) {
            let oldest = self
                .0
                .iter()
                .min_by(|a, b| a.1.at.total_cmp(&b.1.at))
                .map(|(id, _)| *id);
            if let Some(oldest) = oldest {
                self.0.remove(&oldest);
            }
        }
        let nonce = nonce();
        self.0.insert(
            peer,
            Knock {
                connection,
                at: now,
                name,
                notes_id,
                stage: Stage::Committed { commit, nonce },
            },
        );
        nonce
    }

    pub fn reveal(
        &mut self,
        peer: &EndpointId,
        connection: usize,
        theirs: &Nonce,
        now: f64,
    ) -> Result<Revealed, Refused> {
        let knock = self.current(peer, connection)?;
        let Stage::Committed {
            commit: committed,
            nonce,
        } = knock.stage
        else {
            return Err(Refused::KnockExpired);
        };
        if now - knock.at > REVEAL_TIMEOUT.as_millis() as f64 {
            self.0.remove(peer);
            return Err(Refused::KnockExpired);
        }
        if commit(theirs) != committed {
            self.0.remove(peer);
            return Err(Refused::KnockMismatch);
        }
        knock.stage = Stage::Asking;
        Ok(Revealed {
            nonce,
            name: knock.name.clone(),
        })
    }

    /// Refused if the knock was dropped while asking, so the knocker isn't told to confirm it.
    pub fn allowed(
        &mut self,
        peer: &EndpointId,
        connection: usize,
        now: f64,
    ) -> Result<(), Refused> {
        let knock = self.current(peer, connection)?;
        if !matches!(knock.stage, Stage::Asking) {
            return Err(Refused::KnockExpired);
        }
        knock.stage = Stage::Allowed;
        knock.at = now;
        Ok(())
    }

    pub fn forget(&mut self, peer: &EndpointId) {
        self.0.remove(peer);
    }

    pub fn confirm(
        &mut self,
        peer: &EndpointId,
        connection: usize,
        now: f64,
    ) -> Result<(String, Option<String>), Refused> {
        let knock = self.current(peer, connection)?;
        if !matches!(knock.stage, Stage::Allowed) {
            return Err(Refused::KnockExpired);
        }
        let late = now - knock.at > APPROVAL_TIMEOUT.as_millis() as f64;
        let knock = self.0.remove(peer).expect("just found");
        if late {
            return Err(Refused::KnockExpired);
        }
        Ok((knock.name, knock.notes_id))
    }

    fn current(&mut self, peer: &EndpointId, connection: usize) -> Result<&mut Knock, Refused> {
        match self.0.get_mut(peer) {
            Some(knock) if knock.connection == connection => Ok(knock),
            _ => Err(Refused::KnockExpired),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use iroh::SecretKey;

    fn addr() -> EndpointAddr {
        EndpointAddr::from_parts(SecretKey::generate().public(), [])
    }

    fn peer() -> EndpointId {
        SecretKey::generate().public()
    }

    const NOW: f64 = 1_720_000_000_000.0;

    #[test]
    fn a_code_survives_the_round_trip_a_user_puts_it_through() {
        let code = PairingCode {
            addr: addr(),
            secret: Secret::generate(),
        };
        let text = code.to_string();
        assert!(
            text.chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'),
            "a code gets retyped and shouted down a phone: {text}"
        );
        let back: PairingCode = text.parse().expect("parse");
        assert_eq!(back.addr.id, code.addr.id);
        assert!(back.secret.same_as(&code.secret));
    }

    #[test]
    fn surrounding_whitespace_from_a_paste_is_forgiven() {
        let code = PairingCode {
            addr: addr(),
            secret: Secret::generate(),
        };
        let back: PairingCode = format!("  {code}\n").parse().expect("parse");
        assert!(back.secret.same_as(&code.secret));
    }

    #[test]
    fn a_secret_is_hex_in_the_config_and_bytes_on_the_wire() {
        let secret = Secret::generate();

        let json = serde_json::to_string(&secret).expect("to json");
        assert_eq!(json.len(), SECRET_LEN * 2 + 2, "expected a quoted hex run");
        let back: Secret = serde_json::from_str(&json).expect("from json");
        assert!(back.same_as(&secret));

        let bytes = postcard::to_allocvec(&secret).expect("to postcard");
        assert_eq!(bytes.len(), SECRET_LEN);
        let back: Secret = postcard::from_bytes(&bytes).expect("from postcard");
        assert!(back.same_as(&secret));
    }

    #[test]
    fn a_truncated_secret_in_the_config_is_rejected_rather_than_padded() {
        assert!(serde_json::from_str::<Secret>("\"abcd\"").is_err());
    }

    #[test]
    fn two_secrets_are_never_accidentally_equal() {
        assert!(!Secret::generate().same_as(&Secret::generate()));
    }

    #[test]
    fn a_secret_never_prints_itself() {
        let secret = Secret::generate();
        assert_eq!(format!("{secret:?}"), "Secret(…)");
        assert!(
            !format!("{secret:?}").contains(&secret.to_hex()[..4]),
            "a Debug that leaks the secret defeats the point of having one"
        );
    }

    #[test]
    fn guessing_costs_a_device_its_own_turn_and_nothing_else() {
        let mut throttle = Throttle::default();
        let attacker = peer();
        let innocent = peer();

        for _ in 0..MAX_ATTEMPTS {
            assert_eq!(throttle.allows(&attacker, NOW), Ok(()));
            throttle.failed(attacker, NOW);
        }
        assert_eq!(
            throttle.allows(&attacker, NOW),
            Err(Refused::TooManyAttempts)
        );
        assert_eq!(
            throttle.allows(&innocent, NOW),
            Ok(()),
            "one stranger grinding must never be able to lock anyone else out"
        );
    }

    #[test]
    fn a_cooldown_lapses_on_its_own() {
        let mut throttle = Throttle::default();
        let device = peer();
        for _ in 0..MAX_ATTEMPTS {
            throttle.failed(device, NOW);
        }
        assert_eq!(throttle.allows(&device, NOW), Err(Refused::TooManyAttempts));

        let later = NOW + COOLDOWN.as_millis() as f64;
        assert_eq!(
            throttle.allows(&device, later),
            Ok(()),
            "a user who mistyped ten times shouldn't be shut out for good"
        );
    }

    #[test]
    fn pairing_clears_what_a_device_had_against_it() {
        let mut throttle = Throttle::default();
        let device = peer();
        for _ in 0..MAX_ATTEMPTS {
            throttle.failed(device, NOW);
        }
        throttle.succeeded(&device);
        assert_eq!(throttle.allows(&device, NOW), Ok(()));
    }

    #[test]
    fn a_claim_from_a_build_that_speaks_another_protocol_is_named_as_such() {
        use crate::sync::protocol::VERSION;

        assert_eq!(may_claim(VERSION), Ok(()));

        let refused = may_claim(VERSION - 1).expect_err("a v1 claim must not be accepted");
        assert_eq!(refused.code(), "version_mismatch");
        let message = refused.to_string();
        assert!(
            message.contains("different versions of Set") && message.contains("Update both"),
            "the fix is the same on both devices; say so: {message}"
        );

        for side in ["older", "newer", "the other device"] {
            assert!(!message.contains(side), "{message} takes a side on {side}");
        }
    }

    #[test]
    fn a_version_difference_is_never_charged_to_the_guess_budget() {
        let mut throttle = Throttle::default();
        let device = peer();
        for _ in 0..MAX_ATTEMPTS * 2 {
            assert!(may_claim(crate::sync::protocol::VERSION - 1).is_err());
        }
        assert_eq!(
            throttle.allows(&device, NOW),
            Ok(()),
            "may_claim must be answerable without touching the throttle"
        );
    }

    #[test]
    fn a_device_that_has_never_synced_joins_the_folder_it_was_invited_to() {
        assert_eq!(agree(None, "notes-1", true), Ok("notes-1".to_string()));
    }

    #[test]
    fn a_device_already_in_this_folder_is_welcome_back() {
        assert_eq!(
            agree(Some("notes-1"), "notes-1", true),
            Ok("notes-1".to_string())
        );
    }

    #[test]
    fn it_doesnt_matter_which_device_the_user_pasted_the_code_into() {
        assert_eq!(
            agree(Some("notes-1"), "fresh-notes", false),
            Ok("notes-1".to_string()),
            "the side with no devices of its own is the side that moves"
        );
    }

    #[test]
    fn two_established_note_folders_are_never_folded_together() {
        assert_eq!(
            agree(Some("notes-2"), "notes-1", true),
            Err(Refused::DifferentNotes)
        );
    }

    #[test]
    fn two_fresh_installs_converge_instead_of_refusing_each_other_for_ever() {
        use crate::sync::protocol::{check_hello, VERSION};
        use crate::sync::state::Config;

        let mut joiner = Config::default();
        let issuer = Config::default();
        assert_ne!(
            joiner.notes_id, issuer.notes_id,
            "independent installs never start out matching"
        );

        let joined = agree(None, &issuer.notes_id, false).expect("a fresh device may join");
        joiner.notes_id = joined;

        assert_eq!(
            check_hello(&joiner.notes_id, &issuer.notes_id, VERSION),
            Ok(()),
            "the handshake right after pairing has to pass, or nothing ever syncs"
        );
    }

    #[test]
    fn no_refusal_points_the_user_at_the_wrong_machine() {
        for refused in [
            Refused::Wrong,
            Refused::TooManyAttempts,
            Refused::DifferentNotes,
            Refused::Declined,
            Refused::NoAnswer,
        ] {
            let message = refused.to_string();
            assert!(
                !message.contains("this device"),
                "reads as the wrong machine on the screen it appears on: {message}"
            );
            assert!(
                message.len() > 30,
                "a refusal the user can't act on is a dead end: {message}"
            );
        }
    }

    #[test]
    fn check_digits_depend_on_both_nonces() {
        let (a, b) = (peer(), peer());
        let (na, nb) = (nonce(), nonce());
        let digits = check_digits(&a, &b, &na, &nb);
        assert_eq!(digits, check_digits(&a, &b, &na, &nb));
        assert_eq!(digits.len(), 7);
        assert_ne!(digits, check_digits(&a, &b, &na, &nonce()));
        assert_ne!(digits, check_digits(&a, &b, &nonce(), &nb));
    }

    #[test]
    fn a_name_is_cleaned_before_anyone_reads_it() {
        let id = peer();
        assert_eq!(device_name("  Laptop\n", &id), "Laptop");
        assert_eq!(
            device_name("Lap\u{202E}pot\u{200B}", &id),
            "Lappot",
            "no reordering or invisible characters"
        );
        assert_eq!(device_name(&"x".repeat(500), &id).chars().count(), MAX_NAME);
        assert!(device_name("\u{200B} \t", &id).starts_with("Device "));
    }

    const CONN: usize = 7;

    fn knocked(knocks: &mut Knocks, p: EndpointId) -> Nonce {
        knocked_at(knocks, p, NOW)
    }

    fn knocked_at(knocks: &mut Knocks, p: EndpointId, at: f64) -> Nonce {
        let mine = nonce();
        knocks.knock(p, CONN, "Laptop".into(), None, commit(&mine), at);
        mine
    }

    #[test]
    fn a_knock_pairs_only_after_reveal_allow_and_confirm() {
        let mut knocks = Knocks::default();
        let p = peer();
        let mine = knocked(&mut knocks, p);
        assert_eq!(
            knocks.confirm(&p, CONN, NOW).err(),
            Some(Refused::KnockExpired),
            "not before anyone allowed it"
        );
        assert!(knocks.reveal(&p, CONN, &mine, NOW + 1000.0).is_ok());
        assert_eq!(
            knocks.reveal(&p, CONN, &mine, NOW + 1000.0).err(),
            Some(Refused::KnockExpired),
            "revealed once"
        );
        assert_eq!(
            knocks.confirm(&p, CONN, NOW).err(),
            Some(Refused::KnockExpired),
            "still asking"
        );
        knocks.allowed(&p, CONN, NOW + 2000.0).expect("allowed");
        assert_eq!(
            knocks.confirm(&p, CONN + 1, NOW + 3000.0).err(),
            Some(Refused::KnockExpired),
            "another connection"
        );
        assert_eq!(
            knocks.confirm(&p, CONN, NOW + 3000.0),
            Ok(("Laptop".to_string(), None))
        );
        assert!(knocks.confirm(&p, CONN, NOW + 3000.0).is_err(), "once");
    }

    #[test]
    fn a_reveal_must_match_its_commitment_and_come_in_time() {
        let mut knocks = Knocks::default();
        let p = peer();
        knocked(&mut knocks, p);
        assert_eq!(
            knocks.reveal(&p, CONN, &nonce(), NOW).err(),
            Some(Refused::KnockMismatch)
        );

        let mine = knocked(&mut knocks, p);
        let late = NOW + REVEAL_TIMEOUT.as_millis() as f64 + 1.0;
        assert_eq!(
            knocks.reveal(&p, CONN, &mine, late).err(),
            Some(Refused::KnockExpired)
        );
    }

    #[test]
    fn a_confirm_after_the_approval_window_is_refused() {
        let mut knocks = Knocks::default();
        let p = peer();
        let mine = knocked(&mut knocks, p);
        knocks.reveal(&p, CONN, &mine, NOW).expect("reveal");
        knocks.allowed(&p, CONN, NOW).expect("allowed");
        let late = NOW + APPROVAL_TIMEOUT.as_millis() as f64 + 1.0;
        assert_eq!(
            knocks.confirm(&p, CONN, late).err(),
            Some(Refused::KnockExpired)
        );
    }

    #[test]
    fn allowing_a_knock_that_was_dropped_is_refused() {
        let mut knocks = Knocks::default();
        let p = peer();
        let mine = knocked(&mut knocks, p);
        knocks.reveal(&p, CONN, &mine, NOW).expect("reveal");
        // Knocked again on another connection while the first was being asked about.
        knocks.knock(p, CONN + 1, "Laptop".into(), None, commit(&nonce()), NOW);
        assert_eq!(
            knocks.allowed(&p, CONN, NOW).err(),
            Some(Refused::KnockExpired)
        );
        knocks.forget(&p);
        assert_eq!(
            knocks.allowed(&p, CONN, NOW).err(),
            Some(Refused::KnockExpired),
            "gone"
        );
    }

    #[test]
    fn knocks_stay_bounded() {
        let mut knocks = Knocks::default();
        let first = peer();
        knocked_at(&mut knocks, first, NOW - 1.0);
        for _ in 0..MAX_KNOCKS {
            knocked(&mut knocks, peer());
        }
        assert_eq!(knocks.0.len(), MAX_KNOCKS);
        assert!(!knocks.0.contains_key(&first), "the oldest made way");
    }

    #[test]
    fn a_device_turned_down_waits_out_the_cooldown() {
        let mut throttle = Throttle::default();
        let p = peer();
        throttle.block(p, NOW);
        assert_eq!(
            throttle.allows(&p, NOW + 1000.0),
            Err(Refused::TooManyAttempts)
        );
        assert_eq!(
            throttle.allows(&p, NOW + COOLDOWN.as_millis() as f64),
            Ok(())
        );
    }
}
