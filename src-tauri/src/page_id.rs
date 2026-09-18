//! Page ids as `src/lib/utils/id.ts` spells them.

use sha2::{Digest, Sha256};

const ALPHABET: &[u8; 32] = b"0123456789abcdefghjkmnpqrstvwxyz";
const LENGTH: usize = 10;

fn spell(bytes: &[u8]) -> String {
    bytes[..LENGTH]
        .iter()
        .map(|byte| ALPHABET[usize::from(byte & 31)] as char)
        .collect()
}

pub fn random() -> String {
    spell(&rand::random::<[u8; LENGTH]>())
}

/// `deriveId` from id.ts: app and sync must derive the same id from a seed.
pub fn derive(seed: &str) -> String {
    spell(&Sha256::digest(seed.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_random_id_is_ten_letters_of_the_apps_alphabet() {
        let id = random();
        assert_eq!(id.len(), LENGTH);
        assert!(id.bytes().all(|c| ALPHABET.contains(&c)), "{id}");
        assert_ne!(random(), random());
    }

    #[test]
    fn a_derived_id_is_the_one_the_app_derives() {
        // The same vectors are asserted in `src/lib/utils/id.test.ts`.
        assert_eq!(derive("abc/Set/A.md"), "4q1xfzmhq1");
        assert_eq!(derive("p1/Work/Café.md"), "p7d4x7kk4n");
        assert_eq!(derive(""), "3g42rwwmtv");
    }
}
